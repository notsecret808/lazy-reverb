import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { evaluate, withBrowser } from "../../tools/browser-session.js";
import type { BrowserSession } from "../../tools/browser-session.js";
import { interceptFixture } from "./player-fixture.js";

const browser = process.env.LAZY_REVERB_BROWSER ?? "/usr/bin/firefox";
const driver = process.env.LAZY_REVERB_GECKODRIVER ?? resolve("dist/drivers/geckodriver");
const archive = process.env.LAZY_REVERB_ARCHIVE ?? resolve("dist/lazy-reverb-0.3.0.zip");
const artifacts = process.env.LAZY_REVERB_ARTIFACTS ?? "dist/native";
const youtube = "https://www.youtube.com/player";
const soundcloud = "https://soundcloud.com/player";

function lab(session: BrowserSession, id: string) {
  const { client } = session;
  const read = (context: string, expression: string) => evaluate(client, context, expression);
  async function wait(context: string, expression: string) {
    await client.waitUntil(async () => await read(context, expression) === true, { timeout: 6000, timeoutMsg: expression });
  }
  async function play(context: string) {
    await client.switchToWindow(context);
    await client.$("#play").click();
    await wait(context, "!player.paused && player.currentTime > 0");
  }
  return {
    read, wait, play,
    async player(url = youtube) {
      const { context } = await client.browsingContextCreate({ type: "tab" });
      session.context = context;
      await client.browsingContextNavigate({ context, url, wait: "complete" });
      await play(context);
      return context;
    },
    async panel(context: string, supported = true) {
      const panel = await session.openPanel(context, id);
      session.context = panel;
      const ready = supported ? "!document.querySelector('#enabled').disabled" : "document.querySelector('#status').textContent.includes('Open YouTube')";
      await wait(panel, ready);
      return panel;
    },
    async click(context: string, selector: string) {
      await read(context, `document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async slider(context: string, name: "bass" | "mix" | "rate", value: number) {
      await read(context, `(() => {
        const input = document.getElementById(${JSON.stringify(name)});
        input.value = ${value}; input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
    },
    async arrowRight(context: string, name: string) {
      await read(context, `document.getElementById(${JSON.stringify(name)}).focus()`);
      const key = "\uE014";
      await client.inputPerformActions({ context, actions: [{ type: "key", id: "keyboard", actions: [
        { type: "keyDown", value: key }, { type: "keyUp", value: key },
      ] }] });
      await client.inputReleaseActions({ context });
    },
  };
}

async function scenario(name: string, run: (fixture: ReturnType<typeof lab>, session: BrowserSession) => Promise<void>) {
  await withBrowser({ browser, driver, artifacts: resolve(artifacts, name) }, async session => {
    session.step = name;
    const routes = await interceptFixture(session);
    try { await run(lab(session, await session.install(archive)), session); }
    finally { await routes.verify(); }
  });
}

await test("the popup handles presets, keyboard input, and the shortcut", async () => {
  await scenario("controls", async fixture => {
    const page = await fixture.player();
    await fixture.wait(page, "!__lazyReverb.get().enabled && player.playbackRate === 1.25 && player.preservesPitch && __lazyReverb.get().graphCount === 0");
    const panel = await fixture.panel(page);
    assert.equal(await fixture.read(panel, "document.querySelector('#enabled').checked"), false);
    await fixture.click(panel, 'button[data-rate="0.85"]');
    await fixture.wait(page, "__lazyReverb.get().enabled && __lazyReverb.get().mix === 0.25 && player.playbackRate === 0.85 && !player.preservesPitch");
    await fixture.arrowRight(panel, "bass");
    await fixture.wait(page, "__lazyReverb.get().bass === 1");
    assert.equal(await fixture.read(panel, "document.querySelector('#bass-value').value"), "+1 dB");
    await fixture.click(panel, "#enabled");
    await fixture.wait(page, "!__lazyReverb.get().enabled && player.playbackRate === 1.25 && player.preservesPitch && !player.paused");
    await fixture.read(panel, "browser.commands.reset('_execute_action')");
    await fixture.click(panel, "#shortcut-reset");
    await fixture.wait(panel, "browser.commands.getAll().then(commands => commands.find(command => command.name === '_execute_action')?.shortcut === 'Ctrl+Shift+F8')");
    assert.equal(await fixture.read(page, "__lazyReverb.get().enabled"), false);
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
    await fixture.wait(first, "__lazyReverb.get().bass === 7 && __lazyReverb.get().rate === 0.72 && __lazyReverb.get().mix === 0.4");
    await fixture.wait(firstPanel, "browser.storage.local.get('preferences').then(({preferences:p}) => p.bass === 7 && p.rate === 0.72 && p.mix === 0.4)");
    await session.client.browsingContextClose({ context: firstPanel });
    const reopened = await fixture.panel(first);
    assert.equal(await fixture.read(reopened, "document.querySelector('#bass').value"), "7");
    assert.equal(await fixture.read(reopened, "document.querySelector('#enabled').checked"), true);

    const second = await fixture.player();
    const secondPanel = await fixture.panel(second);
    assert.equal(await fixture.read(secondPanel, "document.querySelector('#bass').value"), "7");
    await fixture.wait(second, "!__lazyReverb.get().enabled && player.playbackRate === 1.25 && __lazyReverb.get().graphCount === 0");
    await fixture.click(secondPanel, "#enabled");
    await fixture.slider(secondPanel, "bass", 3);
    await fixture.wait(second, "__lazyReverb.get().enabled && __lazyReverb.get().bass === 3");
    await fixture.wait(first, "__lazyReverb.get().enabled && __lazyReverb.get().bass === 7");
    await fixture.wait(secondPanel, "browser.storage.local.get('preferences').then(({preferences}) => preferences.bass === 3)");
    await session.client.browsingContextReload({ context: second, wait: "complete" });
    const reloaded = await fixture.panel(second);
    assert.equal(await fixture.read(reloaded, "document.querySelector('#bass').value"), "3");
    await fixture.wait(second, "!__lazyReverb.get().enabled && player.playbackRate === 1.25 && __lazyReverb.get().graphCount === 0");
  });
});

await test("SPA player replacement, control limits, and speed-only mode", async () => {
  await scenario("spa-speed", async fixture => {
    const context = await fixture.player();
    const panel = await fixture.panel(context);
    await fixture.click(panel, 'button[data-rate="1.25"]');
    await fixture.wait(context, "__lazyReverb.get().enabled && __lazyReverb.get().mix === 0 && __lazyReverb.get().graphCount === 0 && player.playbackRate === 1.25");
    await fixture.slider(panel, "rate", 2);
    await fixture.slider(panel, "mix", 1);
    await fixture.wait(context, "player.playbackRate === 2 && __lazyReverb.get().mix === 1");
    assert.equal(await fixture.read(panel, "document.querySelector('#rate-value').value"), "2.00×");
    assert.equal(await fixture.read(panel, "document.querySelector('#mix-value').value"), "100 %");
    await fixture.read(context, `(() => {
      player.pause(); player.remove();
      window.player = document.createElement('video'); player.src = '/tone.wav';
      player.loop = true; player.playbackRate = 1.5; player.preservesPitch = true; document.body.append(player);
    })()`);
    await fixture.play(context);
    await fixture.wait(context, "player.playbackRate === 2 && !player.preservesPitch");
    await fixture.click(panel, "#enabled");
    await fixture.wait(context, "player.playbackRate === 1.5 && player.preservesPitch && !player.paused");
  });
});

await test("no CORS leaves speed controls available and unsupported URLs get no engine", async () => {
  await scenario("restricted-pages", async fixture => {
    const context = await fixture.player(`${youtube}?blocked=1`);
    const panel = await fixture.panel(context);
    await fixture.click(panel, 'button[data-rate="0.85"]');
    await fixture.wait(context, "__lazyReverb.get().blockedCount === 1 && __lazyReverb.get().graphCount === 0 && player.playbackRate === 0.85 && !player.paused");
    await fixture.wait(panel, "document.querySelector('#status').textContent.includes('audio protection')");
    const unsupported = await fixture.player("https://unsupported.test/player");
    const unsupportedPanel = await fixture.panel(unsupported, false);
    assert.equal(await fixture.read(unsupported, "typeof __lazyReverb"), "undefined");
    assert.equal(await fixture.read(unsupportedPanel, "document.querySelector('#enabled').disabled"), true);
  });
});

await test("the hidden SoundCloud graph outputs audio in dry, bass, wet, and restored bypass modes", async () => {
  await scenario("audio-output", async fixture => {
    const page = await fixture.player(soundcloud);
    const peak = async () => {
      const value = await fixture.read(page, "window.outputPeak()");
      assert(typeof value === "number");
      return value;
    };
    await fixture.wait(page, "window.outputPeak() > 0.025 && !player.isConnected && siteContext.state === 'running'");
    const before = await peak();
    const panel = await fixture.panel(page);
    await fixture.slider(panel, "rate", 1);
    await fixture.slider(panel, "mix", 0);
    await fixture.slider(panel, "bass", 6);
    await fixture.click(panel, "#enabled");
    await fixture.wait(page, `window.outputPeak() > ${before * 1.35} && __lazyReverb.get().graphCount === 1 && player.playbackRate === 1`);
    await fixture.slider(panel, "mix", 1);
    await fixture.wait(page, "window.outputPeak() > 0.003 && window.impulses.some(node => node.buffer !== null) && __lazyReverb.get().mix === 1");
    await fixture.wait(page, "(async () => { player.pause(); await new Promise(resolve => setTimeout(resolve, 130)); return window.outputPeak() > 0.001; })()");
    await fixture.click(panel, "#enabled");
    await fixture.wait(page, "window.impulses.every(node => node.buffer === null) && siteContext.state === 'running'");
    await fixture.play(page);
    await fixture.wait(page, `window.outputPeak() > ${before * 0.7} && player.playbackRate === 1.25 && __lazyReverb.get().graphCount === 1`);
    assert(await peak() < before * 1.3);
  });
});

await test("bypass preserves the level of mixed mono and 5.1 sources on load and after disabling effects", async () => {
  await scenario("bypass-channels", async fixture => {
    const page = await fixture.player(soundcloud);
    await fixture.read(page, `(() => {
      player.pause();
      siteSource.disconnect(siteContext.destination);
      const reference = new GainNode(siteContext, { channelCount: 2, channelCountMode: 'explicit' });
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
      window.mixStartedAt = siteContext.currentTime + 0.05;
      mono.start(window.mixStartedAt);
      front.start(window.mixStartedAt);
    })()`);
    await fixture.wait(page, "siteContext.currentTime > window.mixStartedAt + 0.12");
    assert.equal(await fixture.read(page, "__lazyReverb.get().enabled"), false);
    const native = await fixture.read(page, "window.referencePeak()");
    assert.equal(native, 0.28125);
    assert.equal(await fixture.read(page, "window.outputPeak()"), native);

    const panel = await fixture.panel(page);
    await fixture.slider(panel, "bass", 6);
    await fixture.slider(panel, "mix", 1);
    await fixture.click(panel, "#enabled");
    await fixture.wait(page, `__lazyReverb.get().enabled && __lazyReverb.get().bass === 6 && __lazyReverb.get().mix === 1
      && window.impulses.some(node => node.buffer !== null) && Math.abs(window.outputPeak() - ${native}) > 0.02`);

    await fixture.click(panel, "#enabled");
    await fixture.wait(page, `!__lazyReverb.get().enabled && window.impulses.every(node => node.buffer === null)
      && Math.abs(window.outputPeak() - ${native}) < 0.000001`);
    assert.equal(await fixture.read(page, "window.referencePeak()"), native);
  });
});
