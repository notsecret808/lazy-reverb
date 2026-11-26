import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dist } from "./build.js";
import { defaultDriver, evaluate, withBrowser } from "./browser-session.js";
import type { BrowserSession } from "./browser-session.js";
import { packageExtension } from "./package.js";

export type Service = "youtube" | "soundcloud";
type Mode = "probe" | "control" | "perf";

function matches(url: URL, service: Service): boolean {
  const host = service === "youtube" ? "youtube.com" : "soundcloud.com";
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

export function liveArguments(mode: Mode) {
  const { values } = parseArgs({ options: {
    url: { type: "string", multiple: mode === "probe" }, service: { type: "string" }, browser: { type: "string" },
    driver: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`pnpm run live:${mode} --url HTTPS_URL${mode === "perf" ? " --service youtube|soundcloud" : ""} [--browser /opt/zen/zen] [--driver PATH]`);
    return undefined;
  }
  const urls = typeof values.url === "string" ? [values.url] : values.url ?? [];
  if (!urls.length) throw new Error("Live diagnostics require an explicit --url.");
  const service = values.service;
  if (mode === "perf" && service !== "youtube" && service !== "soundcloud") throw new Error("Specify --service youtube or --service soundcloud.");
  for (const value of urls) {
    const url = new URL(value);
    const allowed = mode === "control" ? ["youtube"] : service === "youtube" || service === "soundcloud" ? [service] : ["youtube", "soundcloud"];
    if (url.protocol !== "https:" || !allowed.some(name => (name === "youtube" || name === "soundcloud") && matches(url, name))) {
      throw new Error("Provide an HTTPS URL for the selected music service.");
    }
  }
  return { urls, service, browser: values.browser ?? "/opt/zen/zen", driver: values.driver ?? defaultDriver() };
}

export async function liveSession<T>(mode: Mode, options: { browser: string; driver: string }, run: (session: BrowserSession, id?: string) => Promise<T>): Promise<T> {
  const archive = mode === "control" ? undefined : (await packageExtension()).archive;
  return withBrowser({ ...options, artifacts: join(dist, `live-artifacts-${mode}`), timeout: 360_000 }, async session => {
    const id = archive ? await session.install(archive) : undefined;
    return run(session, id);
  });
}

export async function openLive(session: BrowserSession, url: string): Promise<string> {
  const { context } = await session.client.browsingContextCreate({ type: "tab" });
  session.context = context;
  await session.client.browsingContextNavigate({ context, url, wait: "interactive" });
  return context;
}

export async function readLive(session: BrowserSession, context: string, expression: string): Promise<unknown> {
  const serialized = await evaluate(session.client, context, `JSON.stringify(${expression})`);
  if (typeof serialized !== "string") return null;
  const value: unknown = JSON.parse(serialized);
  return value;
}

export async function liveReport(file: string, value: unknown): Promise<void> {
  await mkdir(dist, { recursive: true });
  const output = join(dist, file);
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  console.log(`Local report ${output}`);
}
