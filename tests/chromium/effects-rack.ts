import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { withChromium } from "../../tools/chromium-session.js";

declare global {
  interface Window {
    rackTest: {
      peak(): number;
      update(mix: number, bass: number): void;
      dispose(): void;
      running(): boolean;
      impulseReleased(): boolean;
    };
  }
}

export function testStandaloneRack(archive: string) {
  return test("the effect rack processes an explicit Web Audio graph without installing hooks", { timeout: 30_000 }, async () => {
    const source = await readFile(new URL("../../src/effects-rack.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    await withChromium(archive, async ({ context }) => {
      const page = context.pages()[0];
      await page.setContent('<button id="start">Start</button>');
      await page.addScriptTag({
        type: "module",
        content: outputText + '\n' + setup,
      });
      await page.locator("#start").click();
      await page.waitForFunction(() => window.rackTest?.peak() > 0.06);
      const dry = await page.evaluate(() => window.rackTest.peak());
      assert.equal(await page.evaluate(() => typeof window.__lazyReverb), "undefined");
      await page.evaluate(() => { window.rackTest.update(0, 6); });
      await page.waitForFunction(original => window.rackTest.peak() > original * 1.3, dry);
      await page.evaluate(() => { window.rackTest.update(1, 0); });
      await page.waitForFunction(() => !window.rackTest.impulseReleased() && window.rackTest.peak() > 0.001);
      await page.evaluate(() => { window.rackTest.update(0, 0); });
      await page.waitForFunction(original =>
        window.rackTest.impulseReleased() && Math.abs(window.rackTest.peak() - original) < 0.01, dry);
      await page.evaluate(() => { window.rackTest.update(1, 0); window.rackTest.dispose(); });
      await page.waitForFunction(() => window.rackTest.peak() < 0.001 && window.rackTest.impulseReleased());
      assert.equal(await page.evaluate(() => window.rackTest.running()), true);
    });
  });
}

const setup = [
  'document.querySelector("#start").onclick = async () => {',
  '  const context = new AudioContext();',
  '  const output = context.createGain();',
  '  const analyser = context.createAnalyser();',
  '  output.connect(analyser);',
  '  analyser.connect(context.destination);',
  '  const create = context.createConvolver.bind(context);',
  '  let convolver;',
  '  context.createConvolver = () => (convolver = create());',
  '  const rack = new EffectsRack(context, output);',
  '  const oscillator = context.createOscillator();',
  '  const volume = context.createGain();',
  '  oscillator.frequency.value = 120;',
  '  volume.gain.value = 0.08;',
  '  oscillator.connect(volume);',
  '  volume.connect(rack.input);',
  '  oscillator.start();',
  '  await context.resume();',
  '  window.rackTest = {',
  '    update: (mix, bass) => rack.update(mix, bass),',
  '    dispose: () => rack.dispose(),',
  '    running: () => context.state === "running",',
  '    impulseReleased: () => !convolver?.buffer,',
  '    peak() {',
  '      const samples = new Float32Array(analyser.fftSize);',
  '      analyser.getFloatTimeDomainData(samples);',
  '      return samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);',
  '    },',
  '  };',
  '};',
].join("\n");
