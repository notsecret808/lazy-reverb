export interface EffectSettings {
  enabled: boolean;
  rate: number;
  mix: number;
  bass: number;
}

export interface EffectState extends EffectSettings {
  configured: boolean;
  mediaCount: number;
  graphCount: number;
  blockedCount: number;
  suspended: boolean;
  error: string;
}

declare global {
  interface Window {
    readonly __lazyReverb?: {
      get(): EffectState;
      set(options: unknown): EffectState;
    };
  }
}
