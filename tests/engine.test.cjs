const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const code = readFileSync(`${__dirname}/../engine.js`, 'utf8');

function fixture() {
  class Param {
    value = 1;
    cancelScheduledValues() {}
    setTargetAtTime(value) { this.value = value; }
  }
  class Node {
    constructor(context) { this.context = context; this.connections = []; this.gain = new Param(); }
    connect(...args) { this.connections.push(args); return args[0]; }
    disconnect(...args) {
      this.disconnected = args;
      this.connections = args.length ? this.connections.filter(connection => connection[0] !== args[0]) : [];
    }
  }
  class Context {
    constructor() { this.destination = new Node(this); this.currentTime = 0; this.sampleRate = 1000; this.state = 'running'; this.sources = []; this.convolvers = []; this.filters = []; }
    createGain() { return new Node(this); }
    createConvolver() { const node = new Node(this); node.buffer = null; this.convolvers.push(node); return node; }
    createBiquadFilter() { const node = new Node(this); node.frequency = new Param(); this.filters.push(node); return node; }
    createBuffer(channels, size, rate) { const data = Array.from({ length: channels }, () => new Float32Array(size)); return { getChannelData: c => data[c], length: size, sampleRate: rate }; }
    createMediaElementSource(element) { const source = new Node(this); this.sources.push({ element, source }); return source; }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  class Media {
    constructor(src = 'https://www.youtube.com/audio') { this.src = src; this.currentSrc = src; this.crossOrigin = null; this.preservesPitch = true; this.playbackRate = 1; this.events = {}; }
    addEventListener(name, fn) { this.events[name] = fn; }
    play() { this.played = true; return Promise.resolve(); }
  }
  const elements = [];
  const stats = { scans: 0 };
  const events = {};
  const document = { querySelectorAll: () => { stats.scans++; return elements; }, addEventListener(name, fn) { events[name] = fn; } };
  const scope = {
    window: {}, document, AudioNode: Node, AudioContext: Context, HTMLMediaElement: Media,
    location: { href: 'https://www.youtube.com/watch?v=test', origin: 'https://www.youtube.com' }, URL,
    MutationObserver: class { constructor() { throw Error('DOM observation is not needed'); } }
  };
  vm.runInNewContext(code, scope);
  return { api: scope.window.__lazyReverb, elements, Media, Context, Node, stats, events };
}

test('off by default; enabling lowers pitch; bypass restores the original media settings', () => {
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

test('unsafe cross-origin audio is never routed or reloaded, but slowing works', () => {
  const { api, elements, Media } = fixture();
  const media = new Media('https://cdn.example/track.mp3'); elements.push(media);
  const state = api.set({ enabled: true });
  assert.equal(state.blockedCount, 1); assert.equal(state.graphCount, 0);
  assert.equal(media.playbackRate, 0.85); assert.equal(media.src, 'https://cdn.example/track.mp3');
});

test('detached Audio-style players are found through play and sourced only once', async () => {
  const { api, Media } = fixture();
  api.set({ enabled: true });
  const media = new Media('https://cdn.example/track.mp3'); media.crossOrigin = 'anonymous';
  await media.play(); await media.play();
  api.set({ mix: 0.4 });
  assert.equal(api.get().mediaCount, 1); assert.equal(api.get().graphCount, 1);
  assert.equal(api.get().blockedCount, 0); assert.equal(media.playbackRate, 0.85);
});

test('a player first blocked by CORS can later join a site-owned graph', () => {
  const { api, elements, Media, Context } = fixture();
  const player = new Media('https://cdn.example/audio'); elements.push(player);
  assert.equal(api.set({ enabled: true }).blockedCount, 1);
  const context = new Context();
  context.createMediaElementSource(player).connect(context.destination);
  assert.equal(api.get().blockedCount, 0);
});

test('site-owned Web Audio graph uses a single rack and preserves connect/disconnect ports', () => {
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
  assert.equal(source.connections.at(-1)[0], input);
  api.set({ enabled: true });
  assert.equal(ctx.sources.length, 1); assert.equal(api.get().graphCount, 1);
  assert.equal(ctx.convolvers[0].buffer.length, 2800);
  const dry = input.connections[0][0]; const wet = ctx.convolvers[0].connections[0][0];
  assert.equal(dry.gain.value, 0.75); assert.equal(wet.gain.value, 0.25);
  api.set({ enabled: false });
  assert.equal(dry.gain.value, 1); assert.equal(wet.gain.value, 0);
});

test('new SPA media and player rate resets receive the active settings on play', async () => {
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

test('settings reject invalid types, clamp numbers, and leave offline graphs alone', () => {
  const { api, Node } = fixture();
  api.set({ enabled: 'yes', rate: NaN, mix: Infinity, bass: 'loud' });
  assert.equal(api.get().enabled, false); assert.equal(api.get().rate, 0.85); assert.equal(api.get().mix, 0.25); assert.equal(api.get().bass, 0);
  api.set({ rate: -2, mix: 9, bass: 99 });
  assert.equal(api.get().rate, 0.5); assert.equal(api.get().mix, 1); assert.equal(api.get().bass, 12);
  const offline = {}; offline.destination = new Node(offline);
  const source = new Node(offline); source.connect(offline.destination);
  assert.equal(source.connections[0][0], offline.destination);
});

test('idle mode has no DOM observer, scans, filter, or convolver; rate-only mode stays cheap', () => {
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

test('speed-only media does not create a Web Audio context or warn about CORS', () => {
  const { api, elements, Media } = fixture();
  elements.push(new Media('https://cdn.example/track.mp3'));
  const state = api.set({ enabled: true, mix: 0, bass: 0, rate: 0.9 });
  assert.equal(state.graphCount, 0); assert.equal(state.blockedCount, 0);
  assert.equal(elements[0].playbackRate, 0.9);
  assert.equal(api.set({ bass: 6 }).blockedCount, 1);
  assert.equal(api.set({ bass: 0 }).blockedCount, 0);
});

test('bass is a lazy low shelf with headroom; disabling disconnects FX and frees the impulse', () => {
  const { api, Context, Node } = fixture();
  const ctx = new Context(); const source = new Node(ctx); source.connect(ctx.destination);
  const input = source.connections[0][0];
  const dry = input.connections[0][0];
  api.set({ enabled: true, bass: 6, mix: 0.3 });
  const filter = ctx.filters[0]; const convolver = ctx.convolvers[0];
  assert.equal(filter.type, 'lowshelf'); assert.equal(filter.frequency.value, 200);
  assert.equal(filter.gain.value, 6);
  const headroom = filter.connections[0][0];
  assert.ok(Math.abs(headroom.gain.value - Math.pow(10, -6 / 20)) < 1e-9);
  assert.equal(input.connections.length, 1); assert.equal(input.connections[0][0], filter);
  assert.ok(convolver.buffer);
  api.set({ bass: 12 });
  assert.equal(ctx.filters.length, 1); assert.equal(filter.gain.value, 12);
  api.set({ enabled: false });
  assert.equal(convolver.buffer, null); assert.equal(convolver.connections.length, 0);
  assert.equal(filter.connections.length, 0); assert.equal(headroom.connections.length, 0);
  assert.equal(input.connections.length, 1); assert.equal(input.connections[0][0], dry);
  assert.equal(dry.gain.value, 1);
  api.set({ enabled: true });
  assert.equal(ctx.filters.length, 1); assert.equal(ctx.convolvers.length, 1);
  assert.ok(convolver.buffer); assert.equal(source.connections.length, 1);
  api.set({ mix: 0, bass: 0 });
  assert.equal(convolver.buffer, null); assert.equal(filter.connections.length, 0);
  assert.equal(input.connections[0][0], dry);
});

test('repeated toggles and slider changes keep one source and a bounded graph', () => {
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
    assert.equal(ctx.filters[0].connections[0][0].connections.length, 2);
  }
  api.set({ enabled: false });
  assert.equal(ctx.convolvers[0].buffer, null); assert.equal(ctx.convolvers[0].connections.length, 0);
  assert.equal(ctx.filters[0].connections.length, 0); assert.equal(player.playbackRate, 1.25);
});

test('speed up and full wet mix work, clamp safely and restore original media settings', () => {
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

