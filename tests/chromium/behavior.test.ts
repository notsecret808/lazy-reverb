import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { dist } from "../../tools/build.js";
import { withChromium } from "../../tools/chromium-session.js";
import { packageExtension } from "../../tools/package.js";
import { fixtureResponses } from "../native/player-fixture.js";
import { testStandaloneRack } from "./effects-rack.js";

const archive = process.env.LAZY_REVERB_CHROMIUM_ARCHIVE ?? (await packageExtension("chromium")).archive;

async function slider(panel: Page, id: string, value: number) {
  await panel.locator("#" + id).evaluate((element, setting) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("Missing popup slider");
    element.value = String(setting);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

await test("Chromium installs the production ZIP and controls a hidden SoundCloud graph", { timeout: 60_000 }, async () => {
  const artifacts = join(dist, "native-chromium");
  await mkdir(artifacts, { recursive: true });
  const journal: { url: string; action: string }[] = [];
  await withChromium(archive, async session => {
    const { context, version } = session;
    await writeFile(join(artifacts, "versions.json"), JSON.stringify({ browser: version }, null, 2));
    const respond = await fixtureResponses();
    await context.route(/^https?:\/\//i, async route => {
      const url = route.request().url();
      const response = respond(url);
      journal.push({ url, action: response ? "local" : "abort" });
      if (response) await route.fulfill(response);
      else await route.abort();
    });
    const page = context.pages()[0];
    try {
      await page.goto("https://soundcloud.com/player");
      assert.equal(await page.evaluate(() => window.earlyEngine), true);
      assert.equal(await page.evaluate(() => window.__lazyReverb?.get().enabled), false);
      await page.locator("#play").click();
      await page.waitForFunction(() => window.outputPeak() > 0.025 && !window.player.isConnected && window.siteContext.state === "running");
      const dry = await page.evaluate(() => window.outputPeak());
      const panel = await session.openPanel(page);
      await panel.waitForFunction(() => document.querySelector<HTMLInputElement>("#enabled")?.disabled === false);
      assert.match(await panel.locator("#shortcut").textContent() ?? "", /open the popup|No keyboard shortcut assigned/);
      await panel.getByRole("button", { name: "Faster" }).click();
      await slider(panel, "rate", 1);
      await slider(panel, "bass", 6);
      await page.waitForFunction(before => window.outputPeak() > before * 1.35 && window.player.playbackRate === 1, dry);
      await slider(panel, "mix", 1);
      await page.waitForFunction(() =>
        window.outputPeak() > 0.001 && window.impulses.some(node => node.buffer !== null) && window.__lazyReverb?.get().mix === 1);
      await panel.locator("#enabled").uncheck();
      await page.waitForFunction(before =>
        window.outputPeak() > before * 0.7 && window.player.playbackRate === 1.25 && window.player.preservesPitch
        && window.impulses.every(node => node.buffer === null) && window.siteContext.state === "running", dry);
      await panel.close();
      const second = await context.newPage();
      await second.goto("https://www.youtube.com/player");
      const reopened = await session.openPanel(second);
      await reopened.waitForFunction(() => document.querySelector<HTMLInputElement>("#enabled")?.disabled === false);
      assert.equal(await reopened.locator("#bass").inputValue(), "6");
      assert.equal(await second.evaluate(() => window.__lazyReverb?.get().enabled), false);
      await second.locator("#play").click();
      await reopened.locator("#enabled").check();
      await second.waitForFunction(() => {
        const state = window.__lazyReverb?.get();
        return state?.enabled && state.graphCount === 1 && state.blockedCount === 0 && !window.player.paused;
      });
      const blocked = await context.newPage();
      await blocked.goto("https://www.youtube.com/player?blocked=1");
      const blockedPanel = await session.openPanel(blocked);
      await blockedPanel.waitForFunction(() => document.querySelector<HTMLInputElement>("#enabled")?.disabled === false);
      await blocked.locator("#play").click();
      await slider(blockedPanel, "rate", 0.85);
      await blockedPanel.locator("#enabled").check();
      await blocked.waitForFunction(() => {
        const state = window.__lazyReverb?.get();
        return state?.enabled && state.graphCount === 0 && state.blockedCount === 1
          && !window.player.paused && window.player.playbackRate === 0.85;
      });
      const unrelated = await context.newPage();
      await unrelated.goto("https://unsupported.test/player");
      assert.equal(await unrelated.evaluate(() => window.earlyEngine), false);
      assert(journal.some(entry => entry.url.endsWith("/tone.wav") && entry.action === "local"));
    } catch (error) {
      await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined);
      throw error;
    } finally {
      await writeFile(join(artifacts, "network.json"), JSON.stringify(journal, null, 2));
    }
  });
});

await testStandaloneRack(archive);
