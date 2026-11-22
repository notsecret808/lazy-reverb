import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { evaluate, withBrowser } from "../../tools/browser-session.js";
import { interceptFixture } from "./player-fixture.js";

const browser = process.env.LAZY_REVERB_BROWSER ?? "/usr/bin/firefox";
const driver = process.env.LAZY_REVERB_GECKODRIVER ?? resolve("dist/drivers/geckodriver");
const archive = process.env.LAZY_REVERB_ARCHIVE ?? resolve("dist/lazy-reverb-0.3.0.zip");
const artifacts = process.env.LAZY_REVERB_ARTIFACTS ?? "dist/native";
const fixture = "https://www.youtube.com/player";

await test("the temporary add-on loads in MAIN and controls the active tab from the real popup", async () => {
  await withBrowser({ browser, driver, artifacts: resolve(artifacts, "entry") }, async session => {
    const { client } = session;
    const routes = await interceptFixture(session);
    try {
      session.step = "temporary ZIP installation";
      const id = await session.install(archive);
      assert.equal(id, "lazy-reverb@local.example");
      const { context } = await client.browsingContextCreate({ type: "tab" });
      session.context = context;
      session.step = "automatic bootstrap and local WAV";
      await client.browsingContextNavigate({ context, url: fixture, wait: "complete" });
      assert.equal(await evaluate(client, context, "window.earlyEngine"), true);
      await client.waitUntil(async () => await evaluate(client, context, "player.readyState >= 2"), { timeout: 5000 });
      session.step = "opening the real popup and applying a preset";
      const panel = await session.openPanel(context, id);
      session.context = panel;
      assert.equal(await evaluate(client, panel, "browser.tabs.query({active:true,currentWindow:true}).then(tabs => tabs[0]?.url)"), fixture);
      await client.waitUntil(async () => await evaluate(client, panel, "!document.querySelector('#enabled').disabled"), { timeout: 5000 });
      await evaluate(client, panel, `document.querySelector('button[data-rate="0.85"]').click()`);
      await client.waitUntil(async () => await evaluate(client, context, "window.__lazyReverb.get().enabled && player.playbackRate === 0.85"), { timeout: 5000 });
      session.step = "negative HTTP(S) interception check";
      const denied = "https://invalid.example/should-abort";
      assert.equal(await evaluate(client, context, `fetch(${JSON.stringify(denied)}).then(() => false, () => true)`), true);
      assert(routes.journal.some(row => row.url === denied && row.action === "abort"));
      assert(routes.journal.some(row => row.url === "https://www.youtube.com/tone.wav" && row.action === "local"));
      if (process.env.LAZY_REVERB_SCREENSHOT) {
        const { data } = await client.browsingContextCaptureScreenshot({ context: panel });
        await writeFile(process.env.LAZY_REVERB_SCREENSHOT, Buffer.from(data, "base64"));
      }
    } finally {
      await routes.verify();
    }
  });
});

await test("an allowed origin has no engine without the add-on installed", async () => {
  await withBrowser({ browser, driver, artifacts: resolve(artifacts, "no-addon") }, async session => {
    const routes = await interceptFixture(session);
    const { context } = await session.client.browsingContextCreate({ type: "tab" });
    try {
      session.context = context;
      await session.client.browsingContextNavigate({ context, url: fixture, wait: "complete" });
      assert.equal(await evaluate(session.client, context, "window.earlyEngine"), false);
    } finally {
      await routes.verify();
    }
  });
});
