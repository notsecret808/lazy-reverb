import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, exitCodes, phases, readBudget, summarize } from "../tools/performance-gate.js";

const budget = await readBudget();
function row(mode: typeof phases[number], cpu: number, pss: number, cpuSamples = [cpu, cpu, cpu, cpu]) {
  const samples = cpuSamples.map(value => ({ cpu_percent_one_core: value, pss_mib: pss, interval_seconds: 3 }));
  return { mode, ...summarize(samples), samples };
}
function report() {
  return { valid_playback: true, results: [
    row("native_before", 10, 400), row("injected_disabled", 11, 402), row("enabled", 20, 425),
    row("disabled_after_use", 12, 415), row("paused", 7, 400), row("native_after", 11, 405),
  ] };
}

await test("стабильный отчёт проходит и сохраняет коды выхода", () => {
  assert.equal(assess(report(), budget).status, "pass");
  assert.deepEqual(exitCodes, { pass: 0, fail: 1, inconclusive: 2 });
});

await test("границы бюджета выключенного режима, активного DSP и памяти", () => {
  const input = report();
  input.results[3] = row("disabled_after_use", 16, 464);
  input.results[2] = row("enabled", 31, 464);
  assert.equal(assess(input, budget).status, "pass");
  input.results[3] = row("disabled_after_use", 16.01, 464);
  assert.match(assess(input, budget).reasons.join(), /CPU budget exceeded: disabled_after_use/);
  input.results[2] = row("enabled", 31.01, 465);
  const failed = assess(input, budget);
  assert.equal(failed.status, "fail");
  assert.match(failed.reasons.join(), /CPU budget exceeded: enabled/);
  assert.match(failed.reasons.join(), /Memory budget exceeded: enabled/);
  input.results[5] = row("native_after", 11, 465);
  assert.match(assess(input, budget).reasons.join(), /Memory budget exceeded: native_after/);
});

await test("дрейф фаз и шум центральных проб дают inconclusive, единичный выброс переносится", () => {
  const input = report();
  input.results[5] = row("native_after", 30, 405);
  assert.match(assess(input, budget).reasons.join(), /baseline.*drift/i);
  input.results[5] = row("native_after", 11, 405);
  input.results[2] = row("enabled", 20, 425, [1, 2, 38, 39]);
  assert.equal(assess(input, budget).status, "inconclusive");
  input.results[2] = row("enabled", 20, 425);
  input.results[0] = row("native_before", 10, 400, [9, 10, 10, 40]);
  assert.equal(assess(input, budget).status, "pass");
});

await test("неполные, противоречивые и нечисловые отчёты отвергаются", () => {
  for (const bad of [NaN, Infinity, "12", null, undefined, -1]) {
    for (const field of ["cpu_percent_one_core", "pss_mib", "interval_seconds"]) {
      const input = report();
      Object.assign(input.results[0].samples[0], { [field]: bad });
      assert.equal(assess(input, budget).status, "inconclusive", `${field} ${String(bad)}`);
    }
  }
  for (const edit of [
    (input: ReturnType<typeof report>) => input.results.pop(),
    (input: ReturnType<typeof report>) => input.results.push(input.results[0]),
    (input: ReturnType<typeof report>) => input.results[0].samples.splice(2),
    (input: ReturnType<typeof report>) => { input.results[0].samples[0].interval_seconds = 0; },
    (input: ReturnType<typeof report>) => { input.results[0].cpu_percent_one_core += 1; },
    (input: ReturnType<typeof report>) => { input.results[0].pss_mib += 1; },
    (input: ReturnType<typeof report>) => { input.valid_playback = false; },
  ]) {
    const input = report();
    edit(input);
    assert.equal(assess(input, budget).status, "inconclusive");
  }
});

await test("PSS агрегируется медианой четырёх проб", () => {
  const samples = [301, 410, 415, 900].map(pss_mib => ({ pss_mib, cpu_percent_one_core: 10, interval_seconds: 3 }));
  assert.equal(summarize(samples).pss_mib, 412.5);
});
