import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";
import { archivePopup } from "./extension-files.js";

type Client = Awaited<ReturnType<typeof remote>>;

export function defaultDriver(): string {
  const local = fileURLToPath(new URL("../dist/drivers/geckodriver", import.meta.url));
  return process.env.LAZY_REVERB_GECKODRIVER ?? (existsSync(local) ? local : "geckodriver");
}

export interface BrowserOptions {
  browser: string;
  driver: string;
  artifacts: string;
  timeout?: number;
  prefs?: Record<string, string | number | boolean>;
}

export interface BrowserSession {
  client: Client;
  artifacts: string;
  context?: string;
  step: string;
  install(archive: string): Promise<string>;
  openPanel(player: string, extensionId: string): Promise<string>;
}

export async function evaluate(client: Client, context: string, expression: string): Promise<unknown> {
  const value = await client.scriptEvaluate({ target: { context }, expression, awaitPromise: true });
  if (value.type === "exception") throw new Error(value.exceptionDetails.text);
  return "value" in value.result ? value.result.value : undefined;
}

async function openPanel(client: Client, player: string, extensionId: string, popup: string): Promise<string> {
  const { context } = await client.browsingContextCreate({ type: "tab", background: true, referenceContext: player });
  const marker = `data:text/html,${randomUUID()}`;
  await client.browsingContextNavigate({ context, url: marker, wait: "complete" });
  await client.browsingContextActivate({ context: player });
  // Gecko blocks moz-extension: navigation through BiDi. Load the installed
  // document into its own background browser under the system principal.
  await client.setMozContext("chrome");
  try {
    await client.executeScript(`
      const [id, marker, popup] = arguments;
      const target = gBrowser.tabs.find(tab => tab.linkedBrowser.currentURI.spec === marker);
      const uri = Services.io.newURI(WebExtensionPolicy.getByID(id).getURL(popup));
      target.linkedBrowser.loadURI(uri, {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
    `, [extensionId, marker, popup]);
  } finally {
    await client.setMozContext("content");
  }
  await client.waitUntil(async () => await evaluate(client, context, "Boolean(document.querySelector('#status') && globalThis.browser)"), {
    timeout: 5000, timeoutMsg: "The installed popup document did not load",
  });
  return context;
}

export async function withBrowser<T>(options: BrowserOptions, run: (session: BrowserSession) => Promise<T>): Promise<T> {
  await mkdir(options.artifacts, { recursive: true });
  const profiles = await mkdtemp(join(tmpdir(), "lazy-reverb-webdriver-"));
  const driverLog = join(options.artifacts, "driver.log");
  const consoleLog = join(options.artifacts, "console.log");
  const detached = process.platform !== "win32";
  const driver = spawn(options.driver, ["--host", "127.0.0.1", "--port", "0", "--websocket-port", "0",
    "--profile-root", profiles, "--allow-system-access"], { stdio: ["ignore", "pipe", "pipe"], detached });
  const exited = once(driver, "close");
  const lines = createInterface({ input: driver.stdout });
  let session: BrowserSession | undefined;
  let client: Client | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      lines.on("line", line => {
        appendFileSync(driverLog, `${line}\n`);
        const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(line);
        if (match) resolve(Number(match[1]));
      });
      driver.stderr.on("data", (bytes: Buffer) => appendFileSync(driverLog, bytes));
      exited.then(() => reject(new Error("GeckoDriver exited before opening its port")), reject).catch(reject);
      AbortSignal.timeout(5000).addEventListener("abort", () => reject(new Error("GeckoDriver did not open its port")), { once: true });
    });
    client = await remote({
      hostname: "127.0.0.1", port, path: "/", logLevel: "warn", connectionRetryCount: 0, connectionRetryTimeout: 20_000,
      capabilities: {
        browserName: "firefox", webSocketUrl: true,
        "moz:firefoxOptions": { binary: options.browser, args: ["-headless", "-no-remote"], prefs: {
          "browser.startup.page": 0,
          "browser.newtabpage.enabled": false,
          "dom.serviceWorkers.enabled": false,
          "network.dns.disablePrefetch": true,
          "network.prefetch-next": false,
          "zen.welcome-screen.seen": true,
          "zen.welcome-screen.always-show": false,
          ...options.prefs,
        } },
      },
    });
    const connection = client;
    await connection.sessionSubscribe({ events: ["log.entryAdded"] });
    connection.on("log.entryAdded", entry => appendFileSync(consoleLog, `${JSON.stringify(entry)}\n`));
    await writeFile(join(options.artifacts, "versions.json"), `${JSON.stringify(connection.capabilities, null, 2)}\n`);
    let popup: string | undefined;
    session = {
      client: connection, artifacts: options.artifacts, step: "starting the scenario",
      async install(archive) {
        const bytes = await readFile(archive);
        const id = await connection.installAddOn(bytes.toString("base64"), true);
        popup = archivePopup(bytes);
        return id;
      },
      openPanel(player, extensionId) {
        if (!popup) throw new Error("Install the extension before opening its popup");
        return openPanel(connection, player, extensionId, popup);
      },
    };
    const lifetime = AbortSignal.timeout(options.timeout ?? 60_000);
    return await Promise.race([
      run(session),
      exited.then(() => { throw new Error("GeckoDriver exited during the scenario"); }),
      once(lifetime, "abort").then(() => { throw new Error("Native scenario timed out"); }),
    ]);
  } catch (error) {
    await writeFile(join(options.artifacts, "failure.txt"), `${session?.step ?? "starting the browser"}\n${String(error)}\n`);
    const context = session?.context;
    if (client && context) {
      const connection = client;
      await Promise.race([Promise.allSettled([
        connection.browsingContextCaptureScreenshot({ context }).then(({ data }) => writeFile(join(options.artifacts, "screenshot.png"), Buffer.from(data, "base64"))),
        evaluate(connection, context, "document.documentElement.outerHTML").then(async html => {
          if (typeof html === "string") await writeFile(join(options.artifacts, "page.html"), html);
        }),
      ]), delay(1500)]);
    }
    throw error;
  } finally {
    // Use the process group only for the driver and browser we started.
    if (client) await Promise.race([client.deleteSession().catch(() => undefined), delay(1500)]);
    stopDriver(driver, detached);
    await exited.catch(() => undefined);
    await rm(profiles, { recursive: true, force: true });
  }
}

function stopDriver(driver: ReturnType<typeof spawn>, detached: boolean): void {
  if (!driver.pid) return;
  try { if (detached) process.kill(-driver.pid, "SIGKILL"); else driver.kill(); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}
