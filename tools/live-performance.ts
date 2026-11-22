import { setTimeout as delay } from "node:timers/promises";
import { evaluate } from "./browser-session.js";
import type { BrowserSession } from "./browser-session.js";
import { liveArguments, liveReport, liveSession, openLive, readLive } from "./live-session.js";
import type { Service } from "./live-session.js";
import { summarize } from "./performance-gate.js";
import { browserPid, makeSampler, sampleDelta } from "./process-sampler.js";

const mediaState = `(() => {
  const media = document.querySelector('video') || window.__lrLiveProbe?.media || document.querySelector('audio');
  const frames = media?.getVideoPlaybackQuality?.();
  return {title:document.title,url:location.href,visibility:document.visibilityState,
    engine:window.__lazyReverb?.get(),ad:Boolean(document.querySelector('.ad-showing')),
    media: media && {paused:media.paused,ready:media.readyState,time:media.currentTime,error:media.error?.code ?? null,
      rate:media.playbackRate,pitch:media.preservesPitch,volume:media.volume,muted:media.muted,
      duration:Number.isFinite(media.duration) ? media.duration : null,
      frames:frames && {total:frames.totalVideoFrames,dropped:frames.droppedVideoFrames}}};
})()`;

const setup = `(() => {
  if (globalThis.__lrLiveProbe) return;
  const probe = globalThis.__lrLiveProbe = {media:document.querySelector('video,audio'),gaps:[],last:0};
  if (location.hostname.endsWith('youtube.com')) return;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { probe.media = this; return play.apply(this,args); };
  setInterval(() => {
    const now = performance.now();
    if (probe.last) probe.gaps.push(now - probe.last);
    probe.last = now;
    if (probe.gaps.length > 2000) probe.gaps.shift();
  }, 50);
})()`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timeOf(value: unknown): number {
  if (!record(value) || value.ad !== false || !record(value.media) || value.media.paused !== false
    || typeof value.media.ready !== "number" || value.media.ready < 3 || typeof value.media.time !== "number") {
    throw new Error("Живое воспроизведение не готово или изменилось во время измерения");
  }
  return value.media.time;
}

function framesOf(value: unknown) {
  if (!record(value) || !record(value.media) || !record(value.media.frames)) return undefined;
  const { total, dropped } = value.media.frames;
  return typeof total === "number" && typeof dropped === "number" ? { total, dropped } : undefined;
}

async function prepare(session: BrowserSession, context: string, service: Service) {
  const { client } = session;
  await client.switchToWindow(context);
  if (service === "soundcloud") {
    for (const selector of ["button=Reject all", "button.modal__close"]) {
      const button = await client.$(selector);
      if (await button.isExisting() && await button.isDisplayed()) await button.click();
    }
  }
  await evaluate(client, context, setup);
  const initial = await readLive(session, context, mediaState);
  if (!record(initial) || !record(initial.media) || initial.media.paused !== false) {
    const play = await client.$(service === "youtube" ? ".ytp-play-button" : ".playButton:not(.disabled), button[aria-label='Play']");
    await play.waitForDisplayed({ timeout: 20_000 });
    await play.click();
  }
  await client.waitUntil(async () => {
    try { timeOf(await readLive(session, context, mediaState)); return true; }
    catch { return false; }
  }, { timeout: 20_000, timeoutMsg: "Анонимное воспроизведение не началось" });
  if (service === "soundcloud") {
    await evaluate(client, context, `(() => {
      const media = window.__lrLiveProbe.media || document.querySelector('audio');
      media.volume = 0.02; media.muted = false; media.playbackRate = 1; media.preservesPitch = true;
    })()`);
  }
}

async function measure(session: BrowserSession, context: string, sampler: ReturnType<typeof makeSampler>, mode: string) {
  await delay(6000);
  const initial = await readLive(session, context, mediaState);
  const start = timeOf(initial);
  if (mode === "enabled" && (!record(initial) || !record(initial.engine) || initial.engine.enabled !== true || initial.engine.suspended || initial.engine.blockedCount !== 0)) {
    throw new Error("DSP на странице не включился");
  }
  await evaluate(session.client, context, "window.__lrLiveProbe.gaps.length=0; window.__lrLiveProbe.last=performance.now();");
  const samples = [];
  let before = sampler.snapshot();
  for (let index = 0; index < 4; index++) {
    await delay(3000);
    const after = sampler.snapshot();
    samples.push(sampleDelta(before, after, sampler.hz));
    before = after;
  }
  const state = await readLive(session, context, mediaState);
  if (timeOf(state) - start < 5) throw new Error("Аудиочасы живой страницы не продвинулись");
  const rawGaps = await readLive(session, context, "window.__lrLiveProbe.gaps");
  const seenGaps: unknown[] = Array.isArray(rawGaps) ? rawGaps : [];
  const gaps = seenGaps.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).sort((left, right) => left - right);
  const firstFrames = framesOf(initial);
  const finalFrames = framesOf(state);
  const total = firstFrames && finalFrames ? finalFrames.total - firstFrames.total : 0;
  return {
    mode, ...summarize(samples), samples, state,
    main_thread_50ms_timer_p95_ms: gaps.length ? gaps[Math.ceil(gaps.length * 0.95) - 1] : null,
    video_dropped_fraction: firstFrames && finalFrames && total > 0 ? (finalFrames.dropped - firstFrames.dropped) / total : null,
  };
}

const options = liveArguments("perf");
if (options && (options.service === "youtube" || options.service === "soundcloud")) {
  const { service, urls: [url] } = options;
  const result = await liveSession("perf", options, async (session, id) => {
    if (!id) throw new Error("Расширение не установилось");
    const { client } = session;
    const context = await openLive(session, url);
    const results = [];
    let afterDisable: unknown;
    try {
      const sampler = makeSampler(browserPid(client.capabilities));
      await delay(5000);
      await prepare(session, context, service);
      await delay(service === "youtube" ? 45_000 : 20_000);
      const enabled = { enabled: true, rate: 0.85, mix: 0.25, bass: 6 };
      for (const [mode, settings] of [
        ["cold_off", null], ["enabled", enabled], ["neutral_settings", { enabled: true, rate: 1, mix: 0, bass: 0 }],
        ["power_off", { enabled: false }],
      ] as const) {
        if (settings) await evaluate(client, context, `window.__lazyReverb.set(${JSON.stringify(settings)})`);
        results.push(await measure(session, context, sampler, mode));
      }
      await evaluate(client, context, `window.__lazyReverb.set(${JSON.stringify(enabled)})`);
      await client.setMozContext("chrome");
      try {
        const disabled: unknown = await client.executeAsyncScript(`
          const [id, done] = arguments;
          const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
          AddonManager.getAddonByID(id).then(async addon => { await addon.disable(); done(!addon.isActive); }).catch(() => done(false));
        `, [id]);
        if (disabled !== true) throw new Error("Не удалось отключить дополнение");
      } finally { await client.setMozContext("content"); }
      afterDisable = await readLive(session, context, mediaState);
      await client.browsingContextReload({ context, wait: "interactive" });
      await delay(5000);
      await prepare(session, context, service);
      await delay(10_000);
      results.push(await measure(session, context, sampler, "addon_disabled_reloaded"));
      return { status: "measured", service, url, results, state_after_addon_disable_without_reload: afterDisable };
    } catch (error) {
      const last = await readLive(session, context, mediaState).catch(() => null);
      const message = await evaluate(client, context, "document.body?.innerText.slice(0,1000)").catch(() => null);
      return { status: "incomplete", service, url, results, state_after_addon_disable_without_reload: afterDisable,
        error: error instanceof Error ? error.message : String(error), last_state: last, page_message: message };
    }
  });
  await liveReport("performance-live.json", {
    method: "Анонимное воспроизведение в отдельном профиле Zen. Четыре CPU/PSS-пробы по 3 с. Таймер 50 мс оценивает задержку основной нити для SoundCloud. Результат зависит от сети и состояния страницы.",
    sites: [result],
  });
  if (result.status === "incomplete") process.exitCode = 2;
}
