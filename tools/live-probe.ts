import { setTimeout as delay } from "node:timers/promises";
import { liveArguments, liveReport, liveSession, openLive, readLive } from "./live-session.js";

const options = liveArguments("probe");
if (options) {
  const results = await liveSession("probe", options, async session => {
    const rows: { requested_url: string; state?: unknown; error?: string }[] = [];
    for (const url of options.urls) {
      try {
        const context = await openLive(session, url);
        await delay(5000);
        if (new URL(url).hostname.endsWith("soundcloud.com")) {
          await session.client.switchToWindow(context);
          const reject = await session.client.$("button=Reject all");
          if (await reject.isExisting()) { await reject.click(); await delay(5000); }
        }
        const state = await readLive(session, context, `({
          url: location.href, title: document.title, text: document.body?.innerText.slice(0,3000),
          engine: window.__lazyReverb?.get(),
          media: [...document.querySelectorAll('audio,video')].map(m => ({paused:m.paused,ready:m.readyState,time:m.currentTime,error:m.error?.code})),
          buttons: [...document.querySelectorAll('button')]
            .map(b => ({text:b.innerText.slice(0,80),label:b.getAttribute('aria-label'),title:b.title,class:b.className}))
            .filter(b => /play|воспро|accept|принять|reject|отклон|consent|agree/i.test(b.text+' '+b.label+' '+b.title)).slice(0,20)
        })`);
        rows.push({ requested_url: url, state });
        await session.client.browsingContextClose({ context });
      } catch (error) {
        rows.push({ requested_url: url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return rows;
  });
  await liveReport("live-probe.json", results);
}
