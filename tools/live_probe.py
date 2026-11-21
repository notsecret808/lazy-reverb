"""Check whether anonymous live players are accessible before benchmarking."""
import argparse
import json
import time
from browser_session import browser_session, ROOT

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', action='append', required=True, help='Live player URL; repeat for multiple players')
    args = parser.parse_args()
    results = []
    with browser_session('/opt/zen/zen') as client:
        for url in args.url:
            item = {'requested_url': url}
            try:
                client.command('WebDriver:Navigate', {'url': url})
                time.sleep(5)
                if 'soundcloud.com' in url:
                    reject = client.execute('return [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Reject all");')['value']
                    if reject:
                        client.command('WebDriver:ElementClick', {'id': reject['element-6066-11e4-a52e-4f735466cecf']})
                        time.sleep(5)
                item.update(client.execute('''return {
                  url: location.href, title: document.title,
                  text: document.body?.innerText.slice(0, 3000),
                  engine: window.__lazyReverb?.get(),
                  media: [...document.querySelectorAll('audio,video')].map(m => ({paused:m.paused, ready:m.readyState, time:m.currentTime, error:m.error?.code})),
                  buttons: [...document.querySelectorAll('button')].map(b => ({text:b.innerText.slice(0,80),label:b.getAttribute('aria-label'),title:b.title,class:b.className})).filter(b => /play|воспро|accept|принять|reject|отклон|consent|agree/i.test(b.text+' '+b.label+' '+b.title)).slice(0,20)
                };''')['value'])
            except RuntimeError as error:
                item['error'] = str(error)
            results.append(item)
            print(json.dumps(item, ensure_ascii=False), flush=True)
    target = ROOT / 'dist' / 'live-probe.json'
    target.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
