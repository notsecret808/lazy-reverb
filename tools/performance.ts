import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dist } from "./build.js";
import { readExtensionFiles } from "./extension-files.js";
import { defaultDriver, evaluate, withBrowser } from "./browser-session.js";
import { assess, exitCodes, phases, readBudget, summarize } from "./performance-gate.js";
import type { Phase, Sample } from "./performance-gate.js";
import { browserPid, makeSampler, sampleDelta } from "./process-sampler.js";
import { packageExtension } from "./package.js";

interface Playback {
  context: string;
  currentTime: number;
  direct: boolean;
  outputs: number;
  peak: number;
  hasImpulse: boolean;
  bass: number;
  engine: { enabled: boolean; graphCount: number } | null;
}

function playback(value: unknown): value is Playback {
  return typeof value === "object" && value !== null
    && "context" in value && typeof value.context === "string"
    && "currentTime" in value && typeof value.currentTime === "number" && Number.isFinite(value.currentTime)
    && "direct" in value && typeof value.direct === "boolean"
    && "outputs" in value && typeof value.outputs === "number"
    && "peak" in value && typeof value.peak === "number" && Number.isFinite(value.peak)
    && "hasImpulse" in value && typeof value.hasImpulse === "boolean"
    && "bass" in value && typeof value.bass === "number" && Number.isFinite(value.bass)
    && "engine" in value && (value.engine === null || (typeof value.engine === "object"
      && "enabled" in value.engine && typeof value.engine.enabled === "boolean"
      && "graphCount" in value.engine && typeof value.engine.graphCount === "number"));
}

function checkPlayback(value: unknown, phase: Phase): Playback {
  const data: unknown = typeof value === "string" ? JSON.parse(value) : null;
  if (!playback(data) || data.context !== "running" || data.currentTime <= 0) throw new Error(`Audio clock is inactive: ${phase}`);
  const control = phase === "native_before" || phase === "native_after";
  if (data.direct !== control || data.outputs === 0 || (phase === "paused" ? data.peak > 0.000001 : data.peak < 0.00002)) {
    throw new Error(`Expected output signal is missing: ${phase} ${JSON.stringify(data)}`);
  }
  const enabled = phase === "enabled";
  if (data.hasImpulse !== enabled || (enabled && (!data.engine?.enabled || data.engine.graphCount !== 1 || Math.abs(data.bass - 6) >= 0.1 || data.outputs < 2))) {
    throw new Error(`Unexpected effects routing: ${phase} ${JSON.stringify(data)}`);
  }
  return data;
}

export interface PerformanceOptions { browser: string; driver: string; archive: string }

export async function runPerformance(runtime: string, { browser, driver, archive }: PerformanceOptions): Promise<number> {
  const report = {
    browser, logical_cpus: availableParallelism(), method_version: 2,
    method: "DSP-only, stereo AudioBufferSource, user-activated AudioContext; 10 s warmup, 2 s settling, four 3 s samples per phase, median CPU and PSS. CPU: percent of one core. PSS: Linux browser process group, MiB. Excludes real pages and HTML media decoding.",
    versions: { node: process.version, pnpm: process.env.npm_config_user_agent?.split(" ")[0], browser: "", driver: "" },
    results: [] as (ReturnType<typeof summarize> & { mode: Phase; samples: Sample[]; state: Playback; state_after: Playback })[],
    valid_playback: false,
  };
  let invalid: string | undefined;
  try {
    if (process.platform !== "linux") throw new Error("CPU/PSS benchmarking requires Linux");
    const { engine: entrypoint } = await readExtensionFiles(runtime);
    const [engine, fixture] = await Promise.all([
      readFile(join(runtime, entrypoint), "utf8"),
      readFile(new URL("./fixtures/performance.html", import.meta.url), "utf8"),
    ]);
    const scripts: Record<Phase, string | undefined> = {
      native_before: undefined,
      injected_disabled: `${engine}\nbench.source.disconnect(bench.context.destination); bench.source.connect(bench.context.destination);`,
      enabled: "__lazyReverb.set({ enabled: true, rate: 1, mix: 0.25, bass: 6 });",
      disabled_after_use: "__lazyReverb.set({ enabled: false });",
      paused: "bench.disconnect.call(bench.source);",
      native_after: "bench.direct.call(bench.source, bench.context.destination);",
    };
    await withBrowser({ browser, driver, artifacts: join(dist, "performance-artifacts"), timeout: 150_000 }, async session => {
      const { client } = session;
      await session.install(archive);
      await client.setMozContext("chrome");
      try {
        await client.executeScript("Services.io.manageOfflineStatus = false; Services.io.offline = true;", []);
      } finally {
        await client.setMozContext("content");
      }
      const capabilities: object = client.capabilities;
      report.versions.browser = client.capabilities.browserVersion ?? "";
      if ("moz:geckodriverVersion" in capabilities && typeof capabilities["moz:geckodriverVersion"] === "string") {
        report.versions.driver = capabilities["moz:geckodriverVersion"];
      }
      const sampler = makeSampler(browserPid(capabilities));
      const { context } = await client.browsingContextCreate({ type: "tab" });
      session.context = context;
      await client.browsingContextNavigate({
        context, url: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`, wait: "complete",
      });
      await client.switchToWindow(context);
      await client.$("#play").click();
      await delay(1000);
      checkPlayback(await evaluate(client, context, "verifyPlayback()"), "native_before");
      await delay(10_000);
      for (const mode of phases) {
        session.step = mode;
        const script = scripts[mode];
        if (script) await evaluate(client, context, script);
        await delay(2000);
        const state = checkPlayback(await evaluate(client, context, "verifyPlayback()"), mode);
        const samples: Sample[] = [];
        let before = sampler.snapshot();
        for (let index = 0; index < 4; index++) {
          await delay(3000);
          const after = sampler.snapshot();
          samples.push(sampleDelta(before, after, sampler.hz));
          before = after;
        }
        const stateAfter = checkPlayback(await evaluate(client, context, "verifyPlayback()"), mode);
        if (stateAfter.currentTime - state.currentTime < 6) throw new Error(`Audio clock stopped during ${mode}`);
        const row = { mode, ...summarize(samples), samples, state, state_after: stateAfter };
        report.results.push(row);
        console.log(`${mode}: ${row.cpu_percent_one_core}% CPU, ${row.pss_mib} MiB PSS`);
      }
      report.valid_playback = true;
    });
  } catch (error) {
    report.valid_playback = false;
    invalid = error instanceof Error ? error.message : String(error);
  }
  const gate = assess(report, await readBudget());
  if (invalid) gate.reasons.push(invalid);
  await mkdir(dist, { recursive: true });
  const output = join(dist, "performance-zen.json");
  await writeFile(output, `${JSON.stringify({ ...report, gate }, null, 2)}\n`);
  console.log(`Performance gate: ${JSON.stringify(gate)}\n${output}`);
  return exitCodes[gate.status];
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { browser: { type: "string" }, driver: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("pnpm run check:perf [--browser /opt/zen/zen] [--driver /path/to/geckodriver]");
  else {
    const { runtime, archive } = await packageExtension();
    process.exitCode = await runPerformance(runtime, {
      archive, browser: values.browser ?? "/opt/zen/zen", driver: values.driver ?? defaultDriver(),
    });
  }
}
