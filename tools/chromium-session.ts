import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { chromium } from "playwright";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { archivePopup, localPath } from "./extension-files.js";

export interface ChromiumSession {
  context: BrowserContext;
  browser: CDPSession;
  version: string;
  openPanel(player: Page): Promise<Page>;
}

export async function withChromium<T>(archive: string, run: (session: ChromiumSession) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lazy-reverb-chromium-"));
  let context: BrowserContext | undefined;
  try {
    const extension = join(root, "extension");
    const bytes = await readFile(archive);
    const popup = archivePopup(bytes);
    for (const [name, contents] of Object.entries(unzipSync(bytes))) {
      const file = join(extension, localPath(name));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, { flag: "wx" });
    }
    const active = await chromium.launchPersistentContext(join(root, "profile"), {
      channel: "chromium",
      headless: true,
      serviceWorkers: "block",
      args: [
        "--disable-background-networking",
        "--enable-unsafe-extension-debugging",
        "--disable-extensions-except=" + extension,
        "--load-extension=" + extension,
      ],
    });
    context = active;
    const process = active.browser();
    if (!process) throw new Error("Chromium did not expose a browser session");
    const browser = await process.newBrowserCDPSession();
    const { extensions } = await browser.send("Extensions.getExtensions");
    const installed = extensions.find(item => item.path === extension);
    if (!installed) throw new Error("Chromium did not load the unpacked extension");
    const url = "chrome-extension://" + installed.id + "/" + popup;
    return await run({
      context: active, browser, version: process.version(),
      async openPanel(player) {
        await player.bringToFront();
        const [page] = await Promise.all([
          active.waitForEvent("page"),
          browser.send("Target.createTarget", { url, background: true }),
        ]);
        await page.locator("#status").waitFor();
        return page;
      },
    });
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
