"""No-addon control for live YouTube playback availability; no page hooks."""
import argparse
import json
import time
from browser_session import browser_session, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='YouTube URL to check without the addon')
    args = parser.parse_args()
    result = {'url': args.url, 'addon': 'uninstalled before navigation', 'samples': []}
    with browser_session('/opt/zen/zen') as client:
        client.command('Addon:Uninstall', {'id': 'lazy-reverb@local.example'})
        client.command('WebDriver:Navigate', {'url': result['url']})
        for _ in range(14):
            time.sleep(5)
            state = client.execute('''const m=document.querySelector('video'); return {
              extensionAbsent: window.__lazyReverb === undefined,
              title: document.title,
              media: m ? {paused:m.paused,ready:m.readyState,time:m.currentTime,error:m.error?.code || null} : null,
              playbackMessage: document.querySelector('.ytp-error-content-wrap')?.innerText || null
            };''')['value']
            result['samples'].append(state)
            print(json.dumps(state, ensure_ascii=False), flush=True)
            if state['playbackMessage']:
                break
    destination = ROOT / 'dist' / 'live-control-without-addon.json'
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print('Control report:', destination, flush=True)


if __name__ == '__main__':
    main()
