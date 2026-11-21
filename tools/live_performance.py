"""Paired observations on public live players in disposable Zen profiles.

This is a network-dependent diagnostic, not the deterministic DSP CI gate.
"""
import argparse
import json
import math
import statistics
import time

from browser_session import browser_session, ROOT
from performance import usage, cpu_delta

SITES = {
    'youtube': 'https://www.youtube.com/watch?v=K4DyBUG242c',
    'soundcloud': 'https://soundcloud.com/nocopyrightsounds/deaf-kev-invincible-ncs-release',
}

PROBE = '''
if (!window.__lrLiveProbe) {
  const probe = window.__lrLiveProbe = {media: document.querySelector('video,audio'), gaps: [], last: performance.now()};
  // YouTube exposes its video in the DOM. Do not wrap any of its playback
  // methods or add UI/timers: use read-only native media counters there.
  if (location.hostname.endsWith('youtube.com')) return;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) { probe.media = this; return play.apply(this, args); };
  window.setInterval(() => { const now = performance.now(); probe.gaps.push(now - probe.last); probe.last = now; if (probe.gaps.length > 2000) probe.gaps.shift(); }, 50);
  const button = document.createElement('button'); button.id = 'lazy-reverb-benchmark-control'; button.textContent = 'Test';
  button.style.cssText = 'position:fixed;top:4px;right:4px;z-index:2147483647;width:40px;height:24px';
  document.body.append(button);
}
'''

STATE = '''const m = document.querySelector('video') || window.__lrLiveProbe?.media || document.querySelector('audio');
return {
  title: document.title, url: location.href, visibility: document.visibilityState,
  engine: window.__lazyReverb?.get(), ad: Boolean(document.querySelector('.ad-showing')),
  media: m ? {paused:m.paused, ready:m.readyState, time:m.currentTime, duration:Number.isFinite(m.duration) ? m.duration : null, rate:m.playbackRate, pitch:m.preservesPitch, volume:m.volume, muted:m.muted, width:m.videoWidth || null, height:m.videoHeight || null, error:m.error?.code || null, frames:m.getVideoPlaybackQuality ? {total:m.getVideoPlaybackQuality().totalVideoFrames,dropped:m.getVideoPlaybackQuality().droppedVideoFrames} : null} : null
};'''


def get(client, source):
    return client.execute(source)['value']


def wait_for(predicate, description, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise RuntimeError('Timed out: ' + description)


def click(client, element):
    if not element:
        raise RuntimeError('Required page control missing')
    client.command('WebDriver:ElementClick', {'id': element['element-6066-11e4-a52e-4f735466cecf']})


def prepare(client, service):
    if service == 'soundcloud':
        reject = get(client, 'return [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Reject all" && b.getClientRects().length);')
        if reject:
            click(client, reject)
            time.sleep(3)
        close = get(client, '''return [...document.querySelectorAll('button')].find(b => b.getClientRects().length && (b.classList.contains('modal__close') || /^(close|dismiss|close dialog)$/i.test(b.getAttribute('aria-label') || b.title || b.innerText.trim())));''')
        if close:
            click(client, close)
    client.execute(PROBE)
    state = get(client, STATE)
    if not state['media'] or state['media']['paused']:
        button = wait_for(lambda: get(client, '''return [...document.querySelectorAll('button,a[role="button"],.playButton')].find(b => b.matches('.ytp-play-button') && b.getClientRects().length)
          || [...document.querySelectorAll('button,a[role="button"],.playButton')].find(b => !b.disabled && !b.classList.contains('disabled') && b.getClientRects().length && (b.classList.contains('playButton') || /^(play|play track|play current)$/i.test(b.getAttribute('aria-label') || b.title || b.innerText.trim())));'''), 'play control')
        click(client, button)
    wait_for(lambda: (s := get(client, STATE))['media'] and not s['media']['paused'] and s['media']['ready'] >= 3 and not s['ad'], 'live player playback')
    if service != 'youtube':
        client.execute('const m=document.querySelector("video") || window.__lrLiveProbe.media; m.volume=0.02; m.muted=false; m.playbackRate=1; m.preservesPitch=true;')


def activate(client):
    click(client, get(client, 'return document.querySelector("#lazy-reverb-benchmark-control") || document.querySelector("ytd-watch-metadata h1");'))


def addon_enabled(client, enabled):
    client.command('Marionette:SetContext', {'value': 'chrome'})
    result = client.execute('''const done = arguments[arguments.length-1];
      const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      AddonManager.getAddonByID('lazy-reverb@local.example').then(async addon => {
        await addon.'''+('enable' if enabled else 'disable')+'''();
        done({active:addon.isActive});
      }).catch(error=>done({error:String(error)}));''', asynchronous=True)['value']
    client.command('Marionette:SetContext', {'value': 'content'})
    if result.get('error'):
        raise RuntimeError(result['error'])
    return result


def measure(client, pid, mode):
    time.sleep(6)
    wait_for(lambda: (s:=get(client, STATE))['media'] and not s['media']['paused'] and s['media']['ready']>=3, 'stable playback before sampling', timeout=10)
    initial = get(client, STATE)
    if not initial['media'] or initial['media']['paused'] or initial['media']['ready'] < 3 or initial['ad']:
        raise RuntimeError(f'Invalid measurement state: {initial}')
    if mode == 'enabled' and (not initial['engine']['enabled'] or initial['engine']['suspended'] or initial['engine']['blockedCount']):
        raise RuntimeError(f'Effects not active: {initial}')
    client.execute('window.__lrLiveProbe.gaps.length=0; window.__lrLiveProbe.last=performance.now();')
    previous, _ = usage(pid)
    started = time.monotonic()
    samples = []
    for _ in range(4):
        time.sleep(3)
        after, memory = usage(pid)
        now = time.monotonic()
        samples.append(round(cpu_delta(previous, after, now-started), 2))
        previous, started = after, now
    final = get(client, STATE)
    gaps = sorted(get(client, 'return window.__lrLiveProbe.gaps;'))
    if final['ad'] or final['media']['paused'] or final['media']['time'] - initial['media']['time'] < 5:
        raise RuntimeError(f'Playback changed/stalled during measurement: {final}')
    row = {
        'mode': mode, 'cpu_percent_one_core': round(statistics.median(samples), 2),
        'cpu_samples': samples, 'pss_mib': memory,
        'main_thread_50ms_timer_p95_ms': round(gaps[max(0, math.ceil(len(gaps)*0.95)-1)], 2) if gaps else None,
        'state': final,
    }
    before_frames, after_frames = initial['media']['frames'], final['media']['frames']
    if before_frames and after_frames:
        frames = after_frames['total']-before_frames['total']
        row['video_dropped_fraction'] = (after_frames['dropped']-before_frames['dropped'])/frames if frames else None
    print(json.dumps(row, ensure_ascii=False), flush=True)
    return row


def run(service):
    result = {'service': service, 'url': SITES[service], 'results': []}
    with browser_session('/opt/zen/zen') as client:
        try:
            client.command('Marionette:SetContext', {'value': 'chrome'})
            pid = get(client, 'return Services.appinfo.processID;')
            client.command('Marionette:SetContext', {'value': 'content'})
            client.command('WebDriver:Navigate', {'url': SITES[service]})
            time.sleep(5)
            prepare(client, service)
            time.sleep(45 if service == 'youtube' else 20)
            phases = [
                ('cold_off', None),
                ('enabled', {'enabled': True, 'rate': 0.85, 'mix': 0.25, 'bass': 6}),
                ('neutral_settings', {'enabled': True, 'rate': 1, 'mix': 0, 'bass': 0}),
                ('power_off', {'enabled': False}),
            ]
            for mode, options in phases:
                if options is not None:
                    client.execute('window.__lazyReverb.set('+json.dumps(options)+');')
                    activate(client)
                result['results'].append(measure(client, pid, mode))
            # Check the distinct lifecycle case: disabling the addon while its
            # page-world graph is still enabled, then refreshing the document.
            client.execute('window.__lazyReverb.set({enabled:true,rate:0.85,mix:0.25,bass:6});')
            activate(client)
            result['addon_disable'] = addon_enabled(client, False)
            result['state_after_addon_disable_without_reload'] = get(client, STATE)
            client.command('WebDriver:Refresh')
            time.sleep(5)
            prepare(client, service)
            time.sleep(10)
            result['results'].append(measure(client, pid, 'addon_disabled_reloaded'))
            result['status'] = 'measured'
        except Exception as error:
            result['status'] = 'incomplete'
            result['error'] = str(error)
            try:
                result['last_state'] = get(client, STATE)
                result['page_message'] = get(client, 'return document.body?.innerText.slice(0,1000);')
            except Exception:
                pass
            print('Live measurement incomplete:', service, str(error), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', choices=['youtube','soundcloud','all'], default='all')
    args = parser.parse_args()
    services = list(SITES) if args.service == 'all' else [args.service]
    destination = ROOT / 'dist' / 'performance-live.json'
    report = {'method': 'Anonymous headless Zen, continuous real public playback, no forced seeking or quality changes; four 3-second CPU samples per mode after settling. 100% means one core. PSS is whole browser group. 50ms timer p95 is a page-main-thread scheduling proxy, not a UI/FPS guarantee. Live-network observations are not the deterministic DSP gate.', 'sites': []}
    for service in services:
        report['sites'].append(run(service))
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print('Live report:', destination, flush=True)


if __name__ == '__main__':
    main()
