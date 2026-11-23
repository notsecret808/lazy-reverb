export interface AudioConnections {
  connect(source: AudioNode, target: AudioNode): void;
  disconnect(source: AudioNode): void;
}

const direct: AudioConnections = {
  connect(source, target) { source.connect(target); },
  disconnect(source) { source.disconnect(); },
};

function ramp(parameter: AudioParam, value: number, context: AudioContext) {
  parameter.cancelScheduledValues(context.currentTime);
  parameter.setTargetAtTime(value, context.currentTime, 0.015);
}

function impulse(context: AudioContext) {
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

export class EffectsRack {
  readonly input: GainNode;
  private readonly dry: GainNode;
  private bass?: BiquadFilterNode;
  private wet?: GainNode;
  private convolver?: ConvolverNode;
  private bassActive = false;
  private wetActive = false;

  constructor(
    private readonly context: AudioContext,
    private readonly destination: AudioNode,
    private readonly connections: AudioConnections = direct,
  ) {
    this.input = context.createGain();
    this.dry = context.createGain();
    // Apply the destination's channel rules to each connection before summing.
    this.input.channelCount = destination.channelCount;
    this.input.channelCountMode = destination.channelCountMode;
    this.input.channelInterpretation = destination.channelInterpretation;
    connections.connect(this.input, this.dry);
    connections.connect(this.dry, destination);
  }

  update(mix: number, bass: number): void {
    const { context } = this;
    if (context.state === "closed") return;
    const wetActive = mix > 0;
    const bassActive = bass > 0;
    if (wetActive && !this.convolver) {
      this.convolver = context.createConvolver();
      this.wet = context.createGain();
      this.wet.gain.value = mix;
    }
    if (bassActive && !this.bass) {
      this.bass = context.createBiquadFilter();
      this.bass.type = "lowshelf";
      this.bass.frequency.value = 200;
    }
    if (wetActive !== this.wetActive || bassActive !== this.bassActive) {
      this.route(wetActive, bassActive);
      this.wetActive = wetActive;
      this.bassActive = bassActive;
    }
    if (bassActive && this.bass) ramp(this.bass.gain, bass, context);
    ramp(this.dry.gain, 1 - mix, context);
    if (this.wet) ramp(this.wet.gain, mix, context);
  }

  dispose(): void {
    for (const node of [this.input, this.dry, this.bass, this.convolver, this.wet]) {
      if (node) this.connections.disconnect(node);
    }
    if (this.convolver) this.convolver.buffer = null;
  }

  private route(wetActive: boolean, bassActive: boolean): void {
    const { connections, bass, convolver, wet } = this;
    for (const node of [this.input, bass, convolver, wet]) {
      if (node) connections.disconnect(node);
    }
    let signal: AudioNode = this.input;
    if (bassActive && bass) {
      connections.connect(signal, bass);
      signal = bass;
    }
    connections.connect(signal, this.dry);
    if (wetActive && convolver && wet) {
      convolver.buffer ||= impulse(this.context);
      connections.connect(signal, convolver);
      connections.connect(convolver, wet);
      connections.connect(wet, this.destination);
    } else if (convolver) {
      convolver.buffer = null;
    }
  }
}
