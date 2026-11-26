import type { AudioConnections, EffectsRack } from "./effects-rack";

export class SiteAudioBridge {
  // Capture the functions before patching and forward the native receiver below.
  // oxlint-disable-next-line typescript/unbound-method
  private readonly nativeConnect = AudioNode.prototype.connect;
  // oxlint-disable-next-line typescript/unbound-method
  private readonly nativeDisconnect = AudioNode.prototype.disconnect;

  readonly connections: AudioConnections = {
    connect: (source, target) => { Reflect.apply(this.nativeConnect, source, [target]); },
    disconnect: source => { Reflect.apply(this.nativeDisconnect, source, []); },
  };

  install(
    getRack: (context: AudioContext) => EffectsRack,
    findRack: (context: AudioContext) => EffectsRack | undefined,
  ): void {
    const { nativeConnect, nativeDisconnect } = this;
    function connect(this: AudioNode, destination: AudioNode, output?: number, input?: number): AudioNode;
    function connect(this: AudioNode, destination: AudioParam, output?: number): void;
    function connect(this: AudioNode, destination: AudioNode | AudioParam, ...ports: (number | undefined)[]): AudioNode | void {
      if (this.context instanceof AudioContext && destination === this.context.destination) {
        Reflect.apply(nativeConnect, this, [getRack(this.context).input, ...ports]);
        return destination;
      }
      const result: unknown = Reflect.apply(nativeConnect, this, [destination, ...ports]);
      // The native overload returns the destination node or undefined for an AudioParam.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return result as AudioNode | undefined;
    }
    AudioNode.prototype.connect = connect;
    AudioNode.prototype.disconnect = function (...args: unknown[]) {
      if (this.context instanceof AudioContext && args[0] === this.context.destination) {
        const rack = findRack(this.context);
        if (rack) args[0] = rack.input;
      }
      Reflect.apply(nativeDisconnect, this, args);
    };
  }
}
