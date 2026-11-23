interface OwnedSource {
  source: MediaElementAudioSourceNode;
  context: AudioContext;
  connected: boolean;
}

interface PlayerEvents {
  play(): void;
  rateChange(): void;
  metadata(): void;
  retire(): void;
}

export class TrackedPlayer {
  ref?: WeakRef<TrackedPlayer>;
  blocked = false;
  source?: OwnedSource | "site";
  private original?: { rate: number; pitch: boolean };

  constructor(readonly element: HTMLMediaElement, events: PlayerEvents) {
    element.addEventListener("ratechange", () => { if (this.ref) events.rateChange(); });
    element.addEventListener("loadedmetadata", () => { if (this.ref) events.metadata(); });
    element.addEventListener("play", () => events.play());
    const cleanup = () => { if (element.paused && !element.isConnected) events.retire(); };
    element.addEventListener("pause", cleanup);
    element.addEventListener("emptied", cleanup);
  }

  get ownedSource() {
    return this.source === "site" ? undefined : this.source;
  }

  applyRate(rate: number): void {
    const { element } = this;
    this.original ??= { rate: element.playbackRate, pitch: element.preservesPitch };
    element.preservesPitch = false;
    if (element.playbackRate !== rate) element.playbackRate = rate;
  }

  restoreRate(): void {
    const original = this.original;
    if (!original) return;
    this.original = undefined;
    this.element.preservesPitch = original.pitch;
    this.element.playbackRate = original.rate;
  }
}
