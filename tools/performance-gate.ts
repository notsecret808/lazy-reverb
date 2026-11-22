import { readFile } from "node:fs/promises";

export const phases = ["native_before", "injected_disabled", "enabled", "disabled_after_use", "paused", "native_after"] as const;
export type Phase = typeof phases[number];

export interface Sample {
  cpu_percent_one_core: number;
  pss_mib: number;
  interval_seconds: number;
}

const limits = ["baseline_drift_cpu_points", "sample_drift_cpu_points", "disabled_cpu_overhead_points", "enabled_cpu_overhead_points", "memory_overhead_mib"] as const;
type Budget = Record<typeof limits[number], number>;

interface Verdict {
  status: "pass" | "fail" | "inconclusive";
  reasons: string[];
  baseline_cpu_percent_one_core?: number;
  baseline_pss_mib?: number;
}

export const exitCodes = { pass: 0, fail: 1, inconclusive: 2 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}

export async function readBudget(): Promise<Budget> {
  const parsed: unknown = JSON.parse(await readFile(new URL("../performance-budget.json", import.meta.url), "utf8"));
  if (!record(parsed)) throw new Error("Некорректный бюджет производительности");
  const data = parsed;
  function readLimit(name: typeof limits[number]) {
    const limit = data[name];
    if (!nonNegative(limit)) throw new Error(`Некорректный лимит ${name}`);
    return limit;
  }
  return {
    baseline_drift_cpu_points: readLimit("baseline_drift_cpu_points"),
    sample_drift_cpu_points: readLimit("sample_drift_cpu_points"),
    disabled_cpu_overhead_points: readLimit("disabled_cpu_overhead_points"),
    enabled_cpu_overhead_points: readLimit("enabled_cpu_overhead_points"),
    memory_overhead_mib: readLimit("memory_overhead_mib"),
  };
}

export function summarize(samples: Sample[]) {
  const cpu = samples.map(sample => sample.cpu_percent_one_core);
  return {
    cpu_percent_one_core: Math.round(median(cpu) * 100) / 100,
    cpu_mean_percent_one_core: Math.round(100 * cpu.reduce((sum, value) => sum + value, 0) / cpu.length) / 100,
    cpu_samples: cpu,
    pss_mib: Math.round(median(samples.map(sample => sample.pss_mib)) * 10) / 10,
    sample_seconds: samples.reduce((sum, sample) => sum + sample.interval_seconds, 0),
  };
}

export function assess(report: unknown, budget: Budget): Verdict {
  const incomplete = (reason: string): Verdict => ({ status: "inconclusive", reasons: [reason] });
  if (!record(report) || report.valid_playback !== true || !Array.isArray(report.results)) return incomplete("Playback validation failed or phases are missing");
  const rows: unknown[] = report.results;
  const normalized = new Map<string, ReturnType<typeof summarize>>();
  for (const row of rows) {
    if (!record(row) || typeof row.mode !== "string" || !phases.some(phase => phase === row.mode) || normalized.has(row.mode)) {
      return incomplete("Unknown, invalid or duplicate phase");
    }
    if (!Array.isArray(row.samples) || row.samples.length !== 4) return incomplete(`Expected four samples: ${row.mode}`);
    const raw: unknown[] = row.samples;
    const samples: Sample[] = [];
    for (const sample of raw) {
      if (!record(sample) || !nonNegative(sample.cpu_percent_one_core) || !nonNegative(sample.pss_mib)
        || !nonNegative(sample.interval_seconds) || sample.interval_seconds === 0) return incomplete(`Invalid raw sample: ${row.mode}`);
      samples.push({ cpu_percent_one_core: sample.cpu_percent_one_core, pss_mib: sample.pss_mib, interval_seconds: sample.interval_seconds });
    }
    const summary = summarize(samples);
    if (!nonNegative(row.cpu_percent_one_core) || Math.abs(summary.cpu_percent_one_core - row.cpu_percent_one_core) > 0.011
      || !nonNegative(row.pss_mib) || Math.abs(summary.pss_mib - row.pss_mib) > 0.051) return incomplete(`Summary differs from samples: ${row.mode}`);
    normalized.set(row.mode, summary);
  }
  if (normalized.size !== phases.length) return incomplete("Missing benchmark phases");
  const before = normalized.get("native_before");
  const after = normalized.get("native_after");
  if (!before || !after) return incomplete("Missing native controls");
  const reasons: string[] = [];
  if (Math.abs(before.cpu_percent_one_core - after.cpu_percent_one_core) > budget.baseline_drift_cpu_points) {
    reasons.push("Native playback baselines drifted too far apart");
  }
  for (const [name, summary] of normalized) {
    if (name === "paused") continue;
    const central = [...summary.cpu_samples].sort((left, right) => left - right);
    if (central[2] - central[1] > budget.sample_drift_cpu_points) reasons.push(`Unstable CPU samples: ${name}`);
  }
  if (reasons.length) return { status: "inconclusive", reasons };

  const baselineCpu = Math.max(before.cpu_percent_one_core, after.cpu_percent_one_core);
  const baselineMemory = before.pss_mib;
  for (const [name, summary] of normalized) {
    if (name === "paused" || name === "native_before") continue;
    const limit = name === "enabled" ? budget.enabled_cpu_overhead_points : budget.disabled_cpu_overhead_points;
    if (summary.cpu_percent_one_core - baselineCpu > limit) reasons.push(`CPU budget exceeded: ${name}`);
    if (summary.pss_mib - baselineMemory > budget.memory_overhead_mib) reasons.push(`Memory budget exceeded: ${name}`);
  }
  return { status: reasons.length ? "fail" : "pass", reasons, baseline_cpu_percent_one_core: baselineCpu, baseline_pss_mib: baselineMemory };
}
