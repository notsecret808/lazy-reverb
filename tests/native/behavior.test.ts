/// <reference lib="dom" />
/// <reference types="firefox-webext-browser" />

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { EffectSettings } from "../../src/engine-api.js";
import { withBrowser } from "../../tools/browser-session.js";
import type { BrowserSession } from "../../tools/browser-session.js";
import { interceptFixture } from "./player-fixture.js";

declare global {
  interface Window {
    player: HTMLMediaElement;
    siteContext: AudioContext;
    siteSource: MediaElementAudioSourceNode;
    impulses: ConvolverNode[];
    outputPeak(meter?: AnalyserNode): number;
    referencePeak(): number;
    mixStartedAt: number;
  }
}

const browserPath = process.env.LAZY_REVERB_BROWSER ?? "/usr/bin/firefox";
const driver = process.env.LAZY_REVERB_GECKODRIVER ?? resolve("dist/drivers/geckodriver");
const archive = process.env.LAZY_REVERB_ARCHIVE ?? resolve("dist/lazy-reverb-0.3.0-firefox.zip");
const artifacts = process.env.LAZY_REVERB_ARTIFACTS ?? "dist/native";
const youtube = "https://www.youtube.com/player";
const soundcloud = "https://soundcloud.com/player";

function lab(session: BrowserSession, id: string) {
  const { client } = session;
  async function findTab(contextId: string) {
    const tab = (await client.browsingContexts()).find(tab => tab.contextId === contextId);
    assert(tab, `Missing browsing context ${contextId}`);
    return tab;
  }
  async function wait(description: string, probe: () => Promise<boolean>) {
    await client.waitUntil(probe, { timeout: 6000, timeoutMsg: description });
  }
  async function play(tab: WebdriverIO.BrowsingContext) {
    await client.switchToWindow(tab.contextId);
    await client.$("#play").click();
    await wait("The media clock did not start", () => tab.execute(() => !window.player.paused && window.player.currentTime > 0));
  }
  return {
    wait, play,
    async player(url = youtube) {
      const { context } = await client.browsingContextCreate({ type: "tab" });
      session.context = context;
      await client.browsingContextNavigate({ context, url, wait: "complete" });
      const tab = await findTab(context);
      await play(tab);
      return tab;
    },
    async panel(player: WebdriverIO.BrowsingContext, supported = true) {
      const context = await session.openPanel(player.contextId, id);
      session.context = context;
      const panel = await findTab(context);
      await wait("The popup did not show the expected tab state", () => panel.execute(supported => {
        return supported
          ? document.querySelector<HTMLInputElement>("#enabled")?.disabled === false
          : document.querySelector("#status")?.textContent?.includes("Open YouTube") === true;
      }, supported));
      return panel;
    },
    async click(tab: WebdriverIO.BrowsingContext, selector: string) {
      await tab.execute(selector => {
        const button = document.querySelector<HTMLElement>(selector);
        if (!button) throw new Error(`Missing control ${selector}`);
        button.click();
      }, selector);
    },
    async slider(tab: WebdriverIO.BrowsingContext, name: "bass" | "mix" | "rate", value: number) {
      await tab.execute((name, value) => {
        const input = document.querySelector<HTMLInputElement>(`#${name}`);
        if (!input) throw new Error(`Missing slider ${name}`);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, name, value);
    },
    async arrowRight(tab: WebdriverIO.BrowsingContext, name: string) {
      await tab.execute(name => { document.getElementById(name)?.focus(); }, name);
      const key = "\uE014";
      const context = tab.contextId;
      await client.inputPerformActions({ context, actions: [{ type: "key", id: "keyboard", actions: [
        { type: "keyDown", value: key }, { type: "keyUp", value: key },
      ] }] });
      await client.inputReleaseActions({ context });
    },
  };
}

async function scenario(name: string, run: (fixture: ReturnType<typeof lab>, session: BrowserSession) => Promise<void>) {
  await withBrowser({ browser: browserPath, driver, artifacts: resolve(artifacts, name) }, async session => {
    session.step = name;
    const routes = await interceptFixture(session);
    try { await run(lab(session, await session.install(archive)), session); }
    finally { await routes.verify(); }
  });
}

await test("the popup handles presets, keyboard input, and the shortcut", async () => {
  await scenario("controls", async fixture => {
    const page = await fixture.player();
    await fixture.wait("The player did not start in bypass", () => page.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === false && state.graphCount === 0 && window.player.playbackRate === 1.25 && window.player.preservesPitch;
    }));
    const panel = await fixture.panel(page);
    assert.equal(await panel.execute(() => document.querySelector<HTMLInputElement>("#enabled")?.checked), false);
    await fixture.click(panel, 'button[data-rate="0.85"]');
    await fixture.wait("The preset did not apply", () => page.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === true && state.mix === 0.25 && window.player.playbackRate === 0.85 && !window.player.preservesPitch;
    }));
    await fixture.arrowRight(panel, "bass");
    await fixture.wait("The arrow key did not change bass", () => page.execute(() => window.__lazyReverb?.get().bass === 1));
    assert.equal(await panel.execute(() => document.querySelector<HTMLOutputElement>("#bass-value")?.value), "+1 dB");
    await fixture.click(panel, "#enabled");
    await fixture.wait("Bypass did not restore playback settings", () => page.execute(() => {
      return window.__lazyReverb?.get().enabled === false
        && window.player.playbackRate === 1.25 && window.player.preservesPitch && !window.player.paused;
    }));
    await panel.execute(() => browser.commands.reset("_execute_action"));
    await fixture.click(panel, "#shortcut-reset");
    await fixture.wait("The popup did not assign the shortcut", () => panel.execute(async () => {
      const commands = await browser.commands.getAll();
      return commands.find(command => command.name === "_execute_action")?.shortcut === "Ctrl+Shift+F8";
    }));
    assert.equal(await page.execute(() => window.__lazyReverb?.get().enabled), false);
  });
});

await test("the latest input persists and new tabs and reloads start in bypass", async () => {
  await scenario("preferences", async (fixture, session) => {
    const first = await fixture.player();
    const firstPanel = await fixture.panel(first);
    await fixture.click(firstPanel, "#enabled");
    await fixture.slider(firstPanel, "bass", 7);
    await fixture.slider(firstPanel, "rate", 0.72);
    for (const mix of [0.1, 0.2, 0.3, 0.4]) await fixture.slider(firstPanel, "mix", mix);
    await fixture.wait("The player did not receive the final slider values", () => first.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.bass === 7 && state.rate === 0.72 && state.mix === 0.4;
    }));
    const expected: Omit<EffectSettings, "enabled"> = { bass: 7, rate: 0.72, mix: 0.4 };
    await fixture.wait("The final slider values were not saved", () => firstPanel.execute(async expected => {
      const { preferences }: { preferences?: unknown } = await browser.storage.local.get("preferences");
      return typeof preferences === "object" && preferences !== null
        && "bass" in preferences && preferences.bass === expected.bass
        && "rate" in preferences && preferences.rate === expected.rate
        && "mix" in preferences && preferences.mix === expected.mix;
    }, expected));
    await session.client.browsingContextClose({ context: firstPanel.contextId });
    const reopened = await fixture.panel(first);
    assert.equal(await reopened.execute(() => document.querySelector<HTMLInputElement>("#bass")?.value), "7");
    assert.equal(await reopened.execute(() => document.querySelector<HTMLInputElement>("#enabled")?.checked), true);

    const second = await fixture.player();
    const secondPanel = await fixture.panel(second);
    assert.equal(await secondPanel.execute(() => document.querySelector<HTMLInputElement>("#bass")?.value), "7");
    await fixture.wait("The second tab did not start in bypass", () => second.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === false && state.graphCount === 0 && window.player.playbackRate === 1.25;
    }));
    await fixture.click(secondPanel, "#enabled");
    await fixture.slider(secondPanel, "bass", 3);
    await fixture.wait("The second tab did not receive its bass setting", () => second.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === true && state.bass === 3;
    }));
    await fixture.wait("The first tab lost its own settings", () => first.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === true && state.bass === 7;
    }));
    await fixture.wait("The second tab did not save its bass setting", () => secondPanel.execute(async () => {
      const { preferences }: { preferences?: unknown } = await browser.storage.local.get("preferences");
      return typeof preferences === "object" && preferences !== null && "bass" in preferences && preferences.bass === 3;
    }));
    await session.client.browsingContextReload({ context: second.contextId, wait: "complete" });
    const reloaded = await fixture.panel(second);
    assert.equal(await reloaded.execute(() => document.querySelector<HTMLInputElement>("#bass")?.value), "3");
    await fixture.wait("The refreshed tab did not start in bypass", () => second.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === false && state.graphCount === 0 && window.player.playbackRate === 1.25;
    }));
  });
});

await test("SPA player replacement, control limits, and speed-only mode", async () => {
  await scenario("spa-speed", async fixture => {
    const page = await fixture.player();
    const panel = await fixture.panel(page);
    await fixture.click(panel, 'button[data-rate="1.25"]');
    await fixture.wait("The speed-only preset set up an unexpected audio route", () => page.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === true && state.mix === 0 && state.graphCount === 0 && window.player.playbackRate === 1.25;
    }));
    await fixture.slider(panel, "rate", 2);
    await fixture.slider(panel, "mix", 1);
    await fixture.wait("The player did not apply the slider limits", () => page.execute(() => {
      return window.player.playbackRate === 2 && window.__lazyReverb?.get().mix === 1;
    }));
    assert.equal(await panel.execute(() => document.querySelector<HTMLOutputElement>("#rate-value")?.value), "2.00×");
    assert.equal(await panel.execute(() => document.querySelector<HTMLOutputElement>("#mix-value")?.value), "100 %");
    await page.execute(() => {
      window.player.pause();
      window.player.remove();
      const replacement = document.createElement("video");
      replacement.src = "/tone.wav";
      replacement.loop = true;
      replacement.playbackRate = 1.5;
      replacement.preservesPitch = true;
      window.player = replacement;
      document.body.append(replacement);
    });
    await fixture.play(page);
    await fixture.wait("The replacement player did not inherit the settings", () => page.execute(() => {
      return window.player.playbackRate === 2 && !window.player.preservesPitch;
    }));
    await fixture.click(panel, "#enabled");
    await fixture.wait("Bypass did not restore the replacement player's settings", () => page.execute(() => {
      return window.player.playbackRate === 1.5 && window.player.preservesPitch && !window.player.paused;
    }));
  });
});

await test("no CORS leaves speed controls available and unsupported URLs get no engine", async () => {
  await scenario("restricted-pages", async fixture => {
    const page = await fixture.player(`${youtube}?blocked=1`);
    const panel = await fixture.panel(page);
    await fixture.click(panel, 'button[data-rate="0.85"]');
    await fixture.wait("The protected stream did not stay on its original audio route", () => page.execute(() => {
      const state = window.__lazyReverb?.get();
      return state?.blockedCount === 1 && state.graphCount === 0 && window.player.playbackRate === 0.85 && !window.player.paused;
    }));
    await fixture.wait("The popup did not explain the audio restriction", () => panel.execute(() => {
      return document.querySelector("#status")?.textContent?.includes("audio protection") === true;
    }));
    const unsupported = await fixture.player("https://unsupported.test/player");
    const unsupportedPanel = await fixture.panel(unsupported, false);
    assert.equal(await unsupported.execute(() => typeof window.__lazyReverb), "undefined");
    assert.equal(await unsupportedPanel.execute(() => document.querySelector<HTMLInputElement>("#enabled")?.disabled), true);
  });
});

await test("the hidden SoundCloud graph outputs audio in dry, bass, wet, and restored bypass modes", async () => {
  await scenario("audio-output", async fixture => {
    const page = await fixture.player(soundcloud);
    await fixture.wait("The hidden player did not produce a dry signal", () => page.execute(() => {
      return window.outputPeak() > 0.025 && !window.player.isConnected && window.siteContext.state === "running";
    }));
    const before = await page.execute(() => window.outputPeak());
    const panel = await fixture.panel(page);
    await fixture.slider(panel, "rate", 1);
    await fixture.slider(panel, "mix", 0);
    await fixture.slider(panel, "bass", 6);
    await fixture.click(panel, "#enabled");
    await fixture.wait("Bass boost did not raise the output level", () => page.execute(before => {
      return window.outputPeak() > before * 1.35 && window.__lazyReverb?.get().graphCount === 1 && window.player.playbackRate === 1;
    }, before));
    await fixture.slider(panel, "mix", 1);
    await fixture.wait("The reverb impulse was not loaded", () => page.execute(() => {
      return window.impulses.some(node => node.buffer !== null) && window.__lazyReverb?.get().mix === 1;
    }));
    const wetStart = await page.execute(() => window.siteContext.currentTime);
    await fixture.wait("The wet route did not produce audio", () => page.execute(wetStart => {
      return window.siteContext.currentTime >= wetStart + 0.2 && window.outputPeak() > 0.001;
    }, wetStart));
    const tailPeak = await page.execute(async () => {
      const { player, siteSource, siteContext } = window;
      player.pause();
      siteSource.disconnect(siteContext.destination);
      const stoppedAt = siteContext.currentTime;
      const deadline = performance.now() + 3000;
      let peak = 0;
      while (performance.now() < deadline) {
        const elapsed = siteContext.currentTime - stoppedAt;
        if (elapsed > 0.35) return peak;
        // Let samples from before disconnection fall out of the analyser's history.
        if (elapsed >= 0.1) peak = Math.max(peak, window.outputPeak());
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error("The audio clock did not advance through the tail measurement window");
    });
    assert(tailPeak > 0.001, `Expected a reverb tail after disconnecting the source, got ${tailPeak}`);
    await fixture.click(panel, "#enabled");
    await fixture.wait("Disabling effects did not free the impulse or keep the context running", () => page.execute(() => {
      return window.impulses.every(node => node.buffer === null) && window.siteContext.state === "running";
    }));
    await page.execute(() => { window.siteSource.connect(window.siteContext.destination); });
    await fixture.play(page);
    await fixture.wait("Bypass did not restore the original level and playback rate", () => page.execute(before => {
      return window.outputPeak() > before * 0.7 && window.player.playbackRate === 1.25 && window.__lazyReverb?.get().graphCount === 1;
    }, before));
    assert(await page.execute(() => window.outputPeak()) < before * 1.3);
  });
});

await test("bypass preserves the level of mixed mono and 5.1 sources on load and after disabling effects", async () => {
  await scenario("bypass-channels", async fixture => {
    const page = await fixture.player(soundcloud);
    await page.execute(() => {
      const { player, siteSource, siteContext } = window;
      player.pause();
      siteSource.disconnect(siteContext.destination);
      const reference = new GainNode(siteContext, { channelCount: 2, channelCountMode: "explicit" });
      const referenceMeter = siteContext.createAnalyser();
      reference.connect(referenceMeter).connect(new GainNode(siteContext, { gain: 0 })).connect(siteContext.destination);
      window.referencePeak = () => window.outputPeak(referenceMeter);
      const mono = new ConstantSourceNode(siteContext, { offset: 0.25 });
      const surround = new ChannelMergerNode(siteContext, { numberOfInputs: 6 });
      const front = new ConstantSourceNode(siteContext, { offset: 0.03125 });
      front.connect(surround, 0, 0);
      front.connect(surround, 0, 1);
      for (const source of [mono, surround]) {
        source.connect(siteContext.destination);
        source.connect(reference);
      }
      const startsAt = siteContext.currentTime + 0.05;
      window.mixStartedAt = startsAt;
      mono.start(startsAt);
      front.start(startsAt);
    });
    await fixture.wait("The analyser did not reach the scheduled mix", () => page.execute(() => {
      return window.siteContext.currentTime > window.mixStartedAt + 0.12;
    }));
    assert.equal(await page.execute(() => window.__lazyReverb?.get().enabled), false);
    const nativePeak = await page.execute(() => window.referencePeak());
    assert.equal(nativePeak, 0.28125);
    assert.equal(await page.execute(() => window.outputPeak()), nativePeak);

    const panel = await fixture.panel(page);
    await fixture.slider(panel, "bass", 6);
    await fixture.slider(panel, "mix", 1);
    await fixture.click(panel, "#enabled");
    await fixture.wait("The effects did not change the output level", () => page.execute(nativePeak => {
      const state = window.__lazyReverb?.get();
      return state?.enabled === true && state.bass === 6 && state.mix === 1
        && window.impulses.some(node => node.buffer !== null) && Math.abs(window.outputPeak() - nativePeak) > 0.02;
    }, nativePeak));

    await fixture.click(panel, "#enabled");
    await fixture.wait("Bypass did not return to the direct stereo level", () => page.execute(nativePeak => {
      return window.__lazyReverb?.get().enabled === false && window.impulses.every(node => node.buffer === null)
        && Math.abs(window.outputPeak() - nativePeak) < 0.000001;
    }, nativePeak));
    assert.equal(await page.execute(() => window.referencePeak()), nativePeak);
  });
});
