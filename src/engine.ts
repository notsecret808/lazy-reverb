/* Runs in the page world: no extension APIs, credentials, or network requests. */
import type { EffectSettings, EffectState } from "./engine-api";
import { EffectsRack } from "./effects-rack";
import { SiteAudioBridge } from "./site-audio-bridge";
import { TrackedPlayer } from "./tracked-player";

type CreateSource = (this: AudioContext, element: HTMLMediaElement) => MediaElementAudioSourceNode;

export interface MediaOperations {
  createSource(context: AudioContext, element: HTMLMediaElement): MediaElementAudioSourceNode;
  resume(context: AudioContext): Promise<void> | undefined;
}

function safeToRoute(element: HTMLMediaElement): boolean {
  if (element.mediaKeys) return false;
  const source = element.currentSrc || element.src;
  if (!source && !element.srcObject) return false;
  if (element.srcObject || source.startsWith("blob:")) return true;
  try {
    const url = new URL(source, location.href);
    return url.origin === location.origin || url.protocol === "data:" || Boolean(element.crossOrigin);
  } catch {
    return false;
  }
}

export class WebAudioEngine {
  private readonly settings: EffectSettings = { enabled: false, rate: 0.85, mix: 0.25, bass: 0 };
  private readonly players = new WeakMap<HTMLMediaElement, TrackedPlayer>();
  private readonly playerRefs = new Set<WeakRef<TrackedPlayer>>();
  private readonly racks = new WeakMap<AudioContext, EffectsRack>();
  private readonly rackRefs = new Set<WeakRef<AudioContext>>();
  private readonly bridge = new SiteAudioBridge();
  private mediaContext?: AudioContext;
  private configured = false;
  private error = "";

  constructor(private readonly platform: MediaOperations) {}

  start(createSiteSource: CreateSource): void {
    this.bridge.install(context => this.getRack(context), context => this.racks.get(context));
    // Native wrappers use their own receiver when the site calls them.
    // oxlint-disable-next-line typescript/no-this-alias
    const engine = this;
    // oxlint-disable-next-line typescript/unbound-method
    const nativePlay = HTMLMediaElement.prototype.play;
    AudioContext.prototype.createMediaElementSource = function (element) {
      const owned = engine.players.get(element)?.ownedSource;
      if (owned?.context === this) return owned.source;
      const source = createSiteSource.call(this, element);
      engine.register(element, true);
      return source;
    };
    HTMLMediaElement.prototype.play = function (...args: []) {
      engine.register(this);
      if (engine.settings.enabled) for (const [context] of engine.activeRacks()) engine.resume(context);
      return nativePlay.apply(this, args);
    };
    document.addEventListener("play", event => {
      if (event.target instanceof HTMLMediaElement) this.register(event.target);
    }, true);
    document.addEventListener("pointerdown", () => {
      if (!this.settings.enabled) return;
      for (const [context] of this.activeRacks()) this.resume(context);
    }, true);
  }

  get(): EffectState {
    this.sweepMedia();
    const players = [...this.activePlayers()];
    const racks = [...this.activeRacks()];
    return {
      ...this.settings, configured: this.configured, mediaCount: players.length, graphCount: racks.length,
      blockedCount: players.filter(player => player.blocked).length,
      suspended: this.settings.enabled && racks.some(([context]) => context.state === "suspended"),
      error: this.error,
    };
  }

  set(options: unknown): EffectState {
    if (!options || typeof options !== "object") return this.get();
    this.error = "";
    this.sweepMedia();
    const { settings } = this;
    const wasEnabled = settings.enabled;
    if ("enabled" in options && typeof options.enabled === "boolean") settings.enabled = options.enabled;
    if ("rate" in options && typeof options.rate === "number" && Number.isFinite(options.rate)) settings.rate = Math.min(2, Math.max(0.5, options.rate));
    if ("mix" in options && typeof options.mix === "number" && Number.isFinite(options.mix)) settings.mix = Math.min(1, Math.max(0, options.mix));
    if ("bass" in options && typeof options.bass === "number" && Number.isFinite(options.bass)) settings.bass = Math.min(12, Math.max(0, options.bass));
    this.configured = true;
    if (settings.enabled && !wasEnabled) {
      document.querySelectorAll<HTMLMediaElement>("audio, video").forEach(element => this.register(element));
    }
    for (const player of this.activePlayers()) this.applyPlayer(player);
    for (const [context, rack] of this.activeRacks()) {
      this.updateRack(context, rack);
      this.resume(context);
    }
    return this.get();
  }

  private *activeRacks(): Generator<[AudioContext, EffectsRack]> {
    for (const ref of this.rackRefs) {
      const context = ref.deref();
      const rack = context && this.racks.get(context);
      if (!context || !rack || context.state === "closed") {
        this.rackRefs.delete(ref);
        if (context) this.racks.delete(context);
        continue;
      }
      yield [context, rack];
    }
  }

  private *activePlayers(): Generator<TrackedPlayer> {
    for (const ref of this.playerRefs) {
      const player = ref.deref();
      if (!player || player.ref !== ref) {
        this.playerRefs.delete(ref);
        continue;
      }
      yield player;
    }
  }

  private sweepMedia(except?: HTMLMediaElement): void {
    for (const player of this.activePlayers()) {
      const { element } = player;
      // A playing detached Audio() may belong to the site's player.
      if (element !== except && element.paused && !element.isConnected) this.retirePlayer(player);
    }
  }

  private retirePlayer(player: TrackedPlayer): void {
    if (!player.ref) return;
    this.playerRefs.delete(player.ref);
    player.ref = undefined;
    player.restoreRate();
    const owned = player.ownedSource;
    if (owned?.connected) {
      this.bridge.connections.disconnect(owned.source);
      owned.connected = false;
      const rack = this.racks.get(owned.context);
      if (rack) this.updateRack(owned.context, rack);
    }
  }

  private getRack(context: AudioContext): EffectsRack {
    const existing = this.racks.get(context);
    if (existing) return existing;
    const rack = new EffectsRack(context, context.destination, this.bridge.connections);
    this.racks.set(context, rack);
    this.rackRefs.add(new WeakRef(context));
    this.updateRack(context, rack);
    return rack;
  }

  private hasOwnedInput(): boolean {
    for (const player of this.activePlayers()) if (player.ownedSource?.connected) return true;
    return false;
  }

  private updateRack(context: AudioContext, rack: EffectsRack): void {
    if (context.state === "closed") return;
    const active = this.settings.enabled && (context !== this.mediaContext || this.hasOwnedInput());
    rack.update(active ? this.settings.mix : 0, active ? this.settings.bass : 0);
  }

  private resume(context: AudioContext, ownedPlayback = false): void {
    if (this.settings.enabled || ownedPlayback) {
      this.platform.resume(context)?.catch(() => { this.error = "Press Play on the page to start processing."; });
    }
  }

  private attach(player: TrackedPlayer): void {
    if (player.source || (this.settings.mix === 0 && this.settings.bass === 0)) {
      player.blocked = false;
      return;
    }
    if (!safeToRoute(player.element)) {
      player.blocked = true;
      return;
    }
    try {
      const context = this.mediaContext ??= new AudioContext();
      const rack = this.getRack(context);
      const source = this.platform.createSource(context, player.element);
      player.source = { source, context, connected: false };
      this.bridge.connections.connect(source, rack.input);
      player.source.connected = true;
      this.updateRack(context, rack);
      player.blocked = false;
      this.resume(context);
    } catch {
      player.blocked = true;
      this.error = "Could not connect reverb to this player.";
    }
  }

  private applyPlayer(player: TrackedPlayer): void {
    if (this.settings.enabled) {
      player.applyRate(this.settings.rate);
      this.attach(player);
    } else {
      player.restoreRate();
    }
  }

  private register(element: HTMLMediaElement, siteOwned = false): void {
    this.sweepMedia(element);
    let player = this.players.get(element);
    if (!player) {
      const tracked = new TrackedPlayer(element, {
        play: () => this.register(element),
        rateChange: () => {
          if (this.settings.enabled && element.playbackRate !== this.settings.rate) this.applyPlayer(tracked);
        },
        metadata: () => this.applyPlayer(tracked),
        retire: () => this.retirePlayer(tracked),
      });
      player = tracked;
      this.players.set(element, tracked);
    }
    if (siteOwned) player.source = "site";
    if (!player.ref) {
      player.ref = new WeakRef(player);
      this.playerRefs.add(player.ref);
    }
    const owned = player.ownedSource;
    if (owned && !owned.connected) {
      try {
        const rack = this.getRack(owned.context);
        this.bridge.connections.connect(owned.source, rack.input);
        owned.connected = true;
        this.updateRack(owned.context, rack);
        this.resume(owned.context, true);
      } catch {
        player.blocked = true;
        this.error = "Could not restore the player’s audio path.";
      }
    }
    this.applyPlayer(player);
  }
}

export function installEngine(): void {
  if (window.__lazyReverb) return;
  // oxlint-disable-next-line typescript/unbound-method
  const createSource: CreateSource = AudioContext.prototype.createMediaElementSource;
  const engine = new WebAudioEngine({
    createSource: (context, element) => createSource.call(context, element),
    resume: context => context.state === "suspended" ? context.resume() : undefined,
  });
  engine.start(createSource);
  Object.defineProperty(window, "__lazyReverb", {
    value: Object.freeze({ get: () => engine.get(), set: (options: unknown) => engine.set(options) }),
  });
}
