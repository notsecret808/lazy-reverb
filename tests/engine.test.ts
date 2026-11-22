import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { EffectState } from "../src/engine-api.js";

const code = readFileSync(new URL("../dist/firefox/engine.js", import.meta.url), "utf8");

function fixture(sourceCode = code) {
  const contexts: Context[] = [];
  class Param {
    value = 1;
    cancelScheduledValues() {}
    setTargetAtTime(value: number) { this.value = value; }
  }
  class Node {
    connections: [Node, number?, number?][] = [];
    disconnected: unknown[] = [];
    gain = new Param();
    constructor(readonly context: object) {}
    connect(...args: [Node, number?, number?]) { this.connections.push(args); return args[0]; }
    disconnect(...args: [Node, number?, number?] | [number] | []) {
      this.disconnected = args;
      const [target, output, input] = args;
      if (args.length === 0) {
        this.connections = [];
      } else {
        this.connections = this.connections.filter(([node, out = 0, into = 0]) => {
          if (typeof target === "number") return target !== out;
          return target !== node || (output !== undefined && output !== out) || (input !== undefined && input !== into);
        });
      }
    }
  }
  interface Impulse {
    getChannelData(channel: number): Float32Array;
    length: number;
    sampleRate: number;
  }
  class Convolver extends Node { buffer: Impulse | null = null; }
  class Filter extends Node { frequency = new Param(); type = ""; }
  const sourceOwners = new WeakSet<Media>();
  class Context {
    destination = new Node(this);
    currentTime = 0;
    sampleRate = 1000;
    state = "running";
    sources: { element: Media; source: Node }[] = [];
    convolvers: Convolver[] = [];
    filters: Filter[] = [];
    constructor() { contexts.push(this); }
    createGain() { return new Node(this); }
    createConvolver() { const node = new Convolver(this); this.convolvers.push(node); return node; }
    createBiquadFilter() { const node = new Filter(this); this.filters.push(node); return node; }
    createBuffer(channels: number, size: number, rate: number): Impulse {
      const data = Array.from({ length: channels }, () => new Float32Array(size));
      return { getChannelData: c => data[c], length: size, sampleRate: rate };
    }
    createMediaElementSource(element: Media) {
      if (sourceOwners.has(element)) throw new Error("HTML media can only be sourced once");
      sourceOwners.add(element);
      const source = new Node(this);
      this.sources.push({ element, source });
      return source;
    }
    resume() { this.state = "running"; return Promise.resolve(); }
  }
  class Media {
    currentSrc: string;
    crossOrigin: string | null = null;
    preservesPitch = true;
    playbackRate = 1;
    paused = false;
    isConnected = false;
    played = false;
    mediaKeys: object | null = null;
    events: Record<string, () => void> = {};
    constructor(readonly src = "https://www.youtube.com/audio") { this.currentSrc = src; }
    addEventListener(name: string, fn: () => void) { this.events[name] = fn; }
    play() { this.played = true; this.paused = false; return Promise.resolve(); }
  }
  const elements: Media[] = [];
  const stats = { scans: 0 };
  const events: Record<string, (event: { target: Media }) => void> = {};
  const document = {
    querySelectorAll: () => { stats.scans++; return elements; },
    addEventListener(name: string, fn: (event: { target: Media }) => void) { events[name] = fn; },
  };
  const window: { __lazyReverb?: { get(): EffectState; set(options: unknown): EffectState } } = {};
  vm.runInNewContext(sourceCode, {
    window, document, AudioNode: Node, AudioContext: Context, HTMLMediaElement: Media,
    location: { href: "https://www.youtube.com/watch?v=test", origin: "https://www.youtube.com" }, URL,
    MutationObserver: class { constructor() { throw Error("DOM observation is not needed"); } },
  });
  assert(window.__lazyReverb);
  return { api: window.__lazyReverb, elements, Media, Context, Node, stats, events, contexts };
}

await test('off by default; enabling lowers pitch; bypass restores the original media settings', () => {
  const { api, elements, Media } = fixture();
  const media = new Media(); media.playbackRate = 1.25; media.preservesPitch = true; elements.push(media);
  assert.equal(api.get().enabled, false);
  api.set({ enabled: true, rate: 0.8, mix: 0.3 });
  assert.equal(media.playbackRate, 0.8); assert.equal(media.preservesPitch, false);
  api.set({ rate: 0.7 });
  api.set({ enabled: false });
  assert.equal(media.playbackRate, 1.25); assert.equal(media.preservesPitch, true);
  api.set({ enabled: false });
  assert.equal(media.playbackRate, 1.25);
});

await test('unsafe cross-origin audio is never routed or reloaded, but slowing works', () => {
  const { api, elements, Media } = fixture();
  const media = new Media('https://cdn.example/track.mp3'); elements.push(media);
  const state = api.set({ enabled: true });
  assert.equal(state.blockedCount, 1); assert.equal(state.graphCount, 0);
  assert.equal(media.playbackRate, 0.85); assert.equal(media.src, 'https://cdn.example/track.mp3');
});

await test('detached Audio-style players are found through play and sourced only once', async () => {
  const { api, Media } = fixture();
  api.set({ enabled: true });
  const media = new Media('https://cdn.example/track.mp3'); media.crossOrigin = 'anonymous';
  await media.play(); await media.play();
  api.set({ mix: 0.4 });
  assert.equal(api.get().mediaCount, 1); assert.equal(api.get().graphCount, 1);
  assert.equal(api.get().blockedCount, 0); assert.equal(media.playbackRate, 0.85);
});

await test('a player first blocked by CORS can later join a site-owned graph', () => {
  const { api, elements, Media, Context } = fixture();
  const player = new Media('https://cdn.example/audio'); elements.push(player);
  assert.equal(api.set({ enabled: true }).blockedCount, 1);
  const context = new Context();
  context.createMediaElementSource(player).connect(context.destination);
  assert.equal(api.get().blockedCount, 0);
});

await test('site-owned Web Audio graph uses a single rack and preserves connect/disconnect ports', () => {
  const { api, Context, Node, Media } = fixture();
  const ctx = new Context(); const player = new Media();
  const source = ctx.createMediaElementSource(player);
  assert.equal(source.connect(ctx.destination, 1, 0), ctx.destination);
  const input = source.connections[0][0];
  assert.notEqual(input, ctx.destination); assert.deepEqual(source.connections[0].slice(1), [1, 0]);
  const other = new Node(ctx); source.connect(other);
  assert.equal(source.connections[1][0], other);
  source.disconnect(ctx.destination, 1, 0);
  assert.equal(source.disconnected[0], input); assert.deepEqual(source.disconnected.slice(1), [1, 0]);
  source.disconnect(0); assert.deepEqual(source.disconnected, [0]);
  source.connect(ctx.destination);
  assert.equal(source.connections.at(-1)?.[0], input);
  api.set({ enabled: true });
  assert.equal(ctx.sources.length, 1); assert.equal(api.get().graphCount, 1);
  assert.equal(ctx.convolvers[0].buffer?.length, 2800);
  const dry = input.connections[0][0]; const wet = ctx.convolvers[0].connections[0][0];
  assert.equal(dry.gain.value, 0.75); assert.equal(wet.gain.value, 0.25);
  assert.deepEqual(dry.connections, [[ctx.destination]]);
  assert.deepEqual(wet.connections, [[ctx.destination]]);
  api.set({ enabled: false });
  assert.equal(dry.gain.value, 1); assert.equal(wet.gain.value, 0);
  assert.deepEqual(input.connections, [[dry]]);
  assert.deepEqual(dry.connections, [[ctx.destination]]);
  assert.deepEqual(wet.connections, []);
});

await test('new SPA media and player rate resets receive the active settings on play', async () => {
  const { api, Media, events } = fixture();
  api.set({ enabled: true, rate: 0.77 });
  const media = new Media(); await media.play();
  assert.equal(media.playbackRate, 0.77);
  media.playbackRate = 1; media.events.ratechange();
  assert.equal(media.playbackRate, 0.77);
  api.set({ enabled: false }); assert.equal(media.playbackRate, 1);
  api.set({ enabled: true });
  const autoplay = new Media(); events.play({ target: autoplay });
  assert.equal(autoplay.playbackRate, 0.77);
});

await test('settings reject invalid types, clamp numbers, and leave offline graphs alone', () => {
  const { api, Node } = fixture();
  api.set({ enabled: 'yes', rate: NaN, mix: Infinity, bass: 'loud' });
  assert.equal(api.get().enabled, false); assert.equal(api.get().rate, 0.85); assert.equal(api.get().mix, 0.25); assert.equal(api.get().bass, 0);
  api.set({ rate: -2, mix: 9, bass: 99 });
  assert.equal(api.get().rate, 0.5); assert.equal(api.get().mix, 1); assert.equal(api.get().bass, 12);
  const offline: {destination?: InstanceType<typeof Node>} = {}; offline.destination = new Node(offline);
  const source = new Node(offline); source.connect(offline.destination);
  assert.equal(source.connections[0][0], offline.destination);
});

await test('idle mode has no DOM observer, scans, filter, or convolver; rate-only mode stays cheap', () => {
  const { api, Context, Node, stats } = fixture();
  assert.equal(stats.scans, 0);
  api.set({ rate: 0.9, bass: 6 });
  assert.equal(stats.scans, 0);
  const ctx = new Context(); new Node(ctx).connect(ctx.destination);
  assert.equal(ctx.convolvers.length, 0); assert.equal(ctx.filters.length, 0);
  api.set({ enabled: true, mix: 0, bass: 0 });
  assert.equal(stats.scans, 1);
  api.set({ rate: 0.8 });
  assert.equal(stats.scans, 1);
  assert.equal(ctx.convolvers.length, 0); assert.equal(ctx.filters.length, 0);
  api.set({ enabled: false });
  assert.equal(stats.scans, 1);
});

await test('speed-only media does not create a Web Audio context or warn about CORS', () => {
  const { api, elements, Media } = fixture();
  elements.push(new Media('https://cdn.example/track.mp3'));
  const state = api.set({ enabled: true, mix: 0, bass: 0, rate: 0.9 });
  assert.equal(state.graphCount, 0); assert.equal(state.blockedCount, 0);
  assert.equal(elements[0].playbackRate, 0.9);
  assert.equal(api.set({ bass: 6 }).blockedCount, 1);
  assert.equal(api.set({ bass: 0 }).blockedCount, 0);
});

await test('bass boosts without attenuation; disabling disconnects FX and frees the impulse', () => {
  const { api, Context, Node } = fixture();
  const ctx = new Context(); const source = new Node(ctx); source.connect(ctx.destination);
  const input = source.connections[0][0];
  const dry = input.connections[0][0];
  api.set({ enabled: true, bass: 6, mix: 0.3 });
  const filter = ctx.filters[0]; const convolver = ctx.convolvers[0];
  assert.equal(filter.type, 'lowshelf'); assert.equal(filter.frequency.value, 200);
  assert.equal(filter.gain.value, 6);
  assert.equal(filter.connections[0][0], dry);
  assert.equal(dry.gain.value, 0.7);
  assert.equal(filter.connections[1][0], convolver);
  assert.equal(input.connections.length, 1); assert.equal(input.connections[0][0], filter);
  assert.ok(convolver.buffer);
  api.set({ bass: 12 });
  assert.equal(ctx.filters.length, 1); assert.equal(filter.gain.value, 12);
  api.set({ enabled: false });
  assert.equal(convolver.buffer, null); assert.equal(convolver.connections.length, 0);
  assert.equal(filter.connections.length, 0);
  assert.equal(input.connections.length, 1); assert.equal(input.connections[0][0], dry);
  assert.equal(dry.gain.value, 1);
  api.set({ enabled: true });
  assert.equal(ctx.filters.length, 1); assert.equal(ctx.convolvers.length, 1);
  assert.ok(convolver.buffer); assert.equal(source.connections.length, 1);
  api.set({ mix: 0, bass: 0 });
  assert.equal(convolver.buffer, null); assert.equal(filter.connections.length, 0);
  assert.equal(input.connections[0][0], dry);
});

await test('repeated toggles and slider changes keep one source and a bounded graph', () => {
  const { api, Context, Media, stats } = fixture();
  const ctx = new Context(); const player = new Media(); player.playbackRate = 1.25;
  const source = ctx.createMediaElementSource(player); source.connect(ctx.destination);
  const input = source.connections[0][0];
  api.set({ enabled: true, bass: 6, mix: 0.25 });
  const scans = stats.scans;
  const impulse = ctx.convolvers[0].buffer;
  for (let i = 0; i < 50; i++) api.set({ rate: 0.5 + i / 100, bass: 1 + i % 12 });
  assert.equal(stats.scans, scans); assert.equal(ctx.convolvers[0].buffer, impulse);
  for (let i = 0; i < 50; i++) {
    api.set({ enabled: false }); api.set({ enabled: true });
    assert.equal(ctx.sources.length, 1); assert.equal(ctx.filters.length, 1); assert.equal(ctx.convolvers.length, 1);
    assert.equal(source.connections.length, 1); assert.equal(input.connections.length, 1);
    assert.equal(ctx.filters[0].connections.length, 2);
  }
  api.set({ enabled: false });
  assert.equal(ctx.convolvers[0].buffer, null); assert.equal(ctx.convolvers[0].connections.length, 0);
  assert.equal(ctx.filters[0].connections.length, 0); assert.equal(player.playbackRate, 1.25);
});

await test('speed up and full wet mix work, clamp safely and restore original media settings', () => {
  const { api, elements, Media, Context, Node } = fixture();
  const player = new Media(); player.playbackRate = 1.1; elements.push(player);
  const context = new Context(); const source = new Node(context); source.connect(context.destination);
  const input = source.connections[0][0]; const dry = input.connections[0][0];
  api.set({ enabled: true, rate: 1.75, mix: 1 });
  assert.equal(player.playbackRate, 1.75); assert.equal(player.preservesPitch, false);
  assert.equal(dry.gain.value, 0); assert.equal(context.convolvers[0].connections[0][0].gain.value, 1);
  api.set({ rate: 20, mix: 20 }); assert.equal(api.get().rate, 2); assert.equal(api.get().mix, 1);
  api.set({ enabled: false });
  assert.equal(player.playbackRate, 1.1); assert.equal(player.preservesPitch, true);
  assert.equal(dry.gain.value, 1); assert.equal(context.convolvers[0].buffer, null);
});

await test('retired detached players restore settings, disconnect owned sources and can replay while off', async () => {
  const { api, Media, contexts } = fixture();
  api.set({ enabled: true, rate: 0.7, bass: 6 });
  const player = new Media(); player.isConnected = false; player.playbackRate = 1.25;
  await player.play();
  const context = contexts[0]; const source = context.sources[0].source;
  assert.equal(api.get().mediaCount, 1); assert.ok(context.convolvers[0].buffer);
  player.paused = true; player.events.pause();
  assert.equal(api.get().mediaCount, 0); assert.equal(source.connections.length, 0);
  assert.equal(player.playbackRate, 1.25); assert.equal(player.preservesPitch, true);
  assert.equal(context.convolvers[0].buffer, null);
  api.set({ enabled: false }); context.state = 'suspended';
  await player.play();
  assert.equal(context.sources.length, 1); assert.equal(source.connections.length, 1);
  assert.equal(context.state, 'running'); assert.equal(player.playbackRate, 1.25);
  assert.equal(api.get().mediaCount, 1);
  api.set({ enabled: true });
  assert.equal(player.playbackRate, 0.7); assert.equal(context.sources.length, 1);
});

await test('playing detached Audio stays tracked; retired site sources are not disconnected', async () => {
  const { api, Media, Context } = fixture();
  const player = new Media(); player.isConnected = false; player.paused = false;
  const context = new Context(); const source = context.createMediaElementSource(player);
  source.connect(context.destination); api.set({ enabled: true });
  assert.equal(api.get().mediaCount, 1);
  player.paused = true; player.events.emptied();
  assert.equal(api.get().mediaCount, 0); assert.equal(source.connections.length, 1);
  await player.play(); assert.equal(api.get().mediaCount, 1); assert.equal(context.sources.length, 1);
  context.state = 'closed'; assert.equal(api.get().graphCount, 0);
});

await test('registry allows abandoned media and site contexts to be garbage collected', async () => {
  const collect = global.gc;
  assert(collect, "GC tests require --expose-gc");
  const { api, Media, Context, Node, contexts } = fixture();
  async function abandonMedia() {
    const player = new Media('https://cdn.example/audio'); await player.play(); return new WeakRef(player);
  }
  function abandonContext() {
    const context = new Context(); const source = new Node(context); source.connect(context.destination);
    contexts.length = 0; return new WeakRef(context);
  }
  const playerRef = await abandonMedia(); const contextRef = abandonContext();
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve)); collect();
    await new Promise(resolve => setImmediate(resolve));
    if (!playerRef.deref() && !contextRef.deref()) break;
  }
  assert.equal(playerRef.deref(), undefined); assert.equal(contextRef.deref(), undefined);
  assert.equal(api.get().mediaCount, 0); assert.equal(api.get().graphCount, 0);
});

await test("DRM leaves the original audio route intact and allows speed changes", () => {
  const { api, elements, Media, contexts } = fixture();
  const player = new Media();
  player.mediaKeys = {};
  elements.push(player);
  assert.equal(api.set({ enabled: true, rate: 0.9, mix: 0.4 }).blockedCount, 1);
  assert.equal(player.playbackRate, 0.9);
  assert.equal(contexts.length, 0);
});

await test("connect preserves the native result for nodes from another JavaScript realm", () => {
  const { Node } = fixture();
  const other = fixture();
  const context = new other.Context();
  const source = new other.Node(context);
  const target = new other.Node(context);
  assert.equal(Node.prototype.connect.call(source, target), target);
});
