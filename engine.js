/* Runs in the page world: no extension APIs, credentials, or network requests. */
(() => {
  "use strict";
  if (window.__lazyReverb) return;

  const settings = { enabled: false, rate: 0.85, mix: 0.25, bass: 0 };
  const media = new Map();
  const ownedSources = new WeakMap();
  const siteSources = new WeakSet();
  const racks = new Map();
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const nativeCreateSource = AudioContext.prototype.createMediaElementSource;
  const nativePlay = HTMLMediaElement.prototype.play;
  let mediaContext;
  let configured = false;
  let error = "";

  function ramp(parameter, value, context) {
    parameter.cancelScheduledValues(context.currentTime);
    parameter.setTargetAtTime(value, context.currentTime, 0.015);
  }

  function impulse(context) {
    const buffer = context.createBuffer(2, Math.ceil(context.sampleRate * 2.8), context.sampleRate);
    let seed = 731;
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const attack = Math.min(1, i / (context.sampleRate * 0.008));
        samples[i] = (seed / 2147483648 - 1) * Math.exp(-6 * i / samples.length) * attack;
      }
    }
    return buffer;
  }

  function updateRack(context, rack) {
    if (context.state === "closed") return;
    const mix = settings.enabled ? settings.mix : 0;
    const bass = settings.enabled ? settings.bass : 0;
    const wetActive = mix > 0;
    const bassActive = bass > 0;
    if (wetActive && !rack.convolver) {
      rack.convolver = context.createConvolver();
      rack.wet = context.createGain();
      rack.wet.gain.value = mix;
    }
    if (bassActive && !rack.bass) {
      rack.bass = context.createBiquadFilter();
      rack.bass.type = "lowshelf";
      rack.bass.frequency.value = 200;
      rack.headroom = context.createGain();
    }
    if (wetActive !== rack.wetActive || bassActive !== rack.bassActive) {
      // Only our nodes are disconnected. The site's connections and context
      // remain intact; the disabled path is input -> dry -> destination.
      for (const node of [rack.input, rack.bass, rack.headroom, rack.convolver, rack.wet]) {
        if (node) nativeDisconnect.call(node);
      }
      let signal = rack.input;
      if (bassActive) {
        nativeConnect.call(signal, rack.bass);
        nativeConnect.call(rack.bass, rack.headroom);
        signal = rack.headroom;
      }
      nativeConnect.call(signal, rack.dry);
      if (wetActive) {
        rack.convolver.buffer ||= impulse(context);
        nativeConnect.call(signal, rack.convolver);
        nativeConnect.call(rack.convolver, rack.wet);
        nativeConnect.call(rack.wet, context.destination);
      } else if (rack.convolver) {
        // Release the impulse and stop convolution, rather than just muting it.
        rack.convolver.buffer = null;
      }
      rack.wetActive = wetActive;
      rack.bassActive = bassActive;
    }
    if (bassActive) {
      ramp(rack.bass.gain, bass, context);
      // Reserve headroom equal to the shelf gain to reduce clipping risk.
      ramp(rack.headroom.gain, Math.pow(10, -bass / 20), context);
    }
    ramp(rack.dry.gain, 1 - mix, context);
    if (rack.wet) ramp(rack.wet.gain, mix, context);
  }

  function getRack(context) {
    if (racks.has(context)) return racks.get(context);
    const rack = {
      input: context.createGain(), dry: context.createGain(),
      wetActive: false, bassActive: false
    };
    // Native calls keep our own output connections out of the interception hook.
    nativeConnect.call(rack.input, rack.dry);
    nativeConnect.call(rack.dry, context.destination);
    racks.set(context, rack);
    updateRack(context, rack);
    return rack;
  }

  // SoundCloud can own its Web Audio graph. Process its final output, rather
  // than creating a second, forbidden MediaElementAudioSource for the player.
  AudioNode.prototype.connect = function (destination, ...ports) {
    if (this.context instanceof AudioContext && destination === this.context.destination) {
      const rack = getRack(this.context);
      nativeConnect.call(this, rack.input, ...ports);
      return destination;
    }
    return nativeConnect.call(this, destination, ...ports);
  };
  AudioNode.prototype.disconnect = function (...args) {
    if (args[0] === this.context.destination && racks.has(this.context)) {
      args[0] = racks.get(this.context).input;
    }
    return nativeDisconnect.apply(this, args);
  };
  AudioContext.prototype.createMediaElementSource = function (element) {
    // Reusing our source is safe only within its original AudioContext.
    const owned = ownedSources.get(element);
    if (owned?.context === this) return owned.source;
    const source = nativeCreateSource.call(this, element);
    siteSources.add(element);
    register(element);
    return source;
  };

  function safeToRoute(element) {
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

  function resume(context) {
    if (settings.enabled && context.state === "suspended") {
      context.resume().catch(() => { error = "Нажмите Play на странице, чтобы запустить обработку."; });
    }
  }

  function attach(element, record) {
    if (siteSources.has(element) || ownedSources.has(element)) { record.blocked = false; return; }
    if (!settings.enabled || (settings.mix === 0 && settings.bass === 0)) { record.blocked = false; return; }
    // Routing a non-CORS cross-origin element would silence it permanently.
    // Leave its audio alone; slowing still works.
    if (!safeToRoute(element)) { record.blocked = true; return; }
    try {
      mediaContext ||= new AudioContext();
      const rack = getRack(mediaContext);
      const source = nativeCreateSource.call(mediaContext, element);
      ownedSources.set(element, { source, context: mediaContext });
      nativeConnect.call(source, rack.input);
      record.blocked = false;
      resume(mediaContext);
    } catch {
      record.blocked = true;
      error = "Не удалось подключить реверберацию к этому плееру.";
    }
  }

  function applyMedia(element, record) {
    if (settings.enabled) {
      if (!record.original) {
        record.original = { rate: element.playbackRate, pitch: element.preservesPitch };
      }
      element.preservesPitch = false;
      if (element.playbackRate !== settings.rate) element.playbackRate = settings.rate;
      attach(element, record);
    } else if (record.original) {
      const original = record.original;
      record.original = null;
      element.preservesPitch = original.pitch;
      element.playbackRate = original.rate;
    }
  }

  function register(element) {
    let record = media.get(element);
    if (!record) {
      record = { original: null, blocked: false };
      media.set(element, record);
      element.addEventListener("ratechange", () => {
        if (settings.enabled && element.playbackRate !== settings.rate) applyMedia(element, record);
      });
      element.addEventListener("loadedmetadata", () => applyMedia(element, record));
    }
    applyMedia(element, record);
  }

  HTMLMediaElement.prototype.play = function (...args) {
    register(this); // Also finds detached new Audio() players used by SoundCloud.
    if (settings.enabled) for (const context of racks.keys()) resume(context);
    return nativePlay.apply(this, args);
  };
  document.addEventListener("play", event => {
    if (event.target instanceof HTMLMediaElement) register(event.target);
  }, true);
  document.addEventListener("pointerdown", () => {
    if (!settings.enabled) return;
    for (const context of racks.keys()) resume(context);
  }, true);

  function scan(root) {
    if (root instanceof HTMLMediaElement) register(root);
    root.querySelectorAll?.("audio, video").forEach(register);
  }

  function snapshot() {
    for (const context of racks.keys()) if (context.state === "closed") racks.delete(context);
    return {
      ...settings, configured, mediaCount: media.size, graphCount: racks.size,
      blockedCount: [...media.values()].filter(record => record.blocked).length,
      suspended: settings.enabled && [...racks.keys()].some(context => context.state === "suspended"),
      error
    };
  }

  function set(options) {
    if (!options || typeof options !== "object") return snapshot();
    error = "";
    const wasEnabled = settings.enabled;
    if (typeof options.enabled === "boolean") settings.enabled = options.enabled;
    if (Number.isFinite(options.rate)) settings.rate = Math.min(2, Math.max(0.5, options.rate));
    if (Number.isFinite(options.mix)) settings.mix = Math.min(1, Math.max(0, options.mix));
    if (Number.isFinite(options.bass)) settings.bass = Math.min(12, Math.max(0, options.bass));
    configured = true;
    if (settings.enabled && !wasEnabled) scan(document);
    for (const [element, record] of media) applyMedia(element, record);
    for (const [context, rack] of racks) { updateRack(context, rack); resume(context); }
    return snapshot();
  }

  Object.defineProperty(window, "__lazyReverb", { value: Object.freeze({ get: snapshot, set }) });
})();
