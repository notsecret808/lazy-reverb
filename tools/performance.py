"""Measure DSP overhead on one continuously running native Web Audio graph."""
import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import time

from browser_session import browser_session, ROOT
from performance_gate import assess


SETUP = '''
window.bench = {connected: false, convolvers: []};
const originalConvolver = AudioContext.prototype.createConvolver;
AudioContext.prototype.createConvolver = function() {
  const node = originalConvolver.call(this); bench.convolvers.push(node); return node;
};
const button = document.createElement('button'); button.textContent = 'Play';
button.onclick = async () => {
  if (!bench.context) {
    const context = new AudioContext();
    const buffer = context.createBuffer(2, context.sampleRate, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 2 * Math.PI * (220 + channel * 110) / context.sampleRate) * 0.0003;
    }
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
    bench.context = context; bench.source = source;
    bench.nativeConnect = AudioNode.prototype.connect; bench.nativeDisconnect = AudioNode.prototype.disconnect;
    source.connect(context.destination); source.start(); bench.connected = true;
  }
  await bench.context.resume();
};
document.body.append(button);
'''

STATE = '''return {
  context: window.bench.context?.state,
  currentTime: window.bench.context?.currentTime,
  connected: window.bench.connected,
  rate: window.bench.source?.playbackRate.value,
  hasImpulse: window.bench.convolvers.some(node => node.buffer !== null),
  engine: window.__lazyReverb?.get()
};'''


def usage(root_pid):
    processes = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(path.name)] = (int(fields[1]), int(fields[11]) + int(fields[12]))
        except (OSError, ValueError, IndexError):
            continue
    owned = {root_pid}
    while True:
        children = {pid for pid, (parent, _) in processes.items() if parent in owned}
        expanded = owned | children
        if expanded == owned:
            break
        owned = expanded
    pss = 0
    missing = 0
    ticks = {}
    for pid in owned:
        if pid not in processes:
            continue
        ticks[pid] = processes[pid][1]
        try:
            lines = Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines()
            pss += next(int(line.split()[1]) for line in lines if line.startswith('Pss:'))
        except (OSError, StopIteration):
            missing += 1
    return ticks, round(pss / 1024, 1) if not missing else None


def cpu_delta(before, after, elapsed):
    return sum(max(0, ticks - before.get(pid, 0)) for pid, ticks in after.items()) / os.sysconf('SC_CLK_TCK') / elapsed * 100


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', default='/opt/zen/zen')
    args = parser.parse_args()
    with browser_session(args.browser) as client:
        client.command('Marionette:SetContext', {'value': 'chrome'})
        root_pid = client.execute('return Services.appinfo.processID;')['value']
        # A local DSP benchmark must not include fresh-profile background
        # downloads, updates, or telemetry. No user profile is modified.
        client.execute('Services.io.manageOfflineStatus = false; Services.io.offline = true;')
        client.command('Marionette:SetContext', {'value': 'content'})
        def click_play():
            element = client.execute('return document.querySelector("button");')['value']
            client.command('WebDriver:ElementClick', {'id': element['element-6066-11e4-a52e-4f735466cecf']})
        client.command('WebDriver:Navigate', {'url': 'data:text/html,<html><title>DSP performance fixture</title><body></body></html>'})
        client.inject_page_script(SETUP)
        click_play()
        engine_code = (ROOT / 'engine.js').read_text()
        time.sleep(1)
        preflight = client.execute(STATE)['value']
        valid = preflight['context'] == 'running' and preflight['currentTime'] > 0 and preflight['connected']
        print('Preflight:', json.dumps(preflight), flush=True)
        if valid:
            time.sleep(10)
        phases = [
            ('native_before', None),
            ('injected_disabled', engine_code + '\nbench.source.disconnect(bench.context.destination); bench.source.connect(bench.context.destination);'),
            ('enabled', '__lazyReverb.set({enabled:true, rate:1, mix:0.25, bass:6});'),
            ('disabled_after_use', '__lazyReverb.set({enabled:false});'),
            ('paused', 'bench.nativeDisconnect.call(bench.source); bench.connected = false;'),
            ('native_after', 'bench.nativeConnect.call(bench.source, bench.context.destination); bench.connected = true;'),
        ]
        results = []
        invalid_reason = None if valid else 'Audio preflight failed; no performance samples were taken'
        if not valid:
            phases = []
        for name, script in phases:
            if script:
                client.inject_page_script(script)
            time.sleep(2)
            state = client.execute(STATE)['value']
            if state['context'] != 'running' or state['connected'] != (name != 'paused'):
                invalid_reason = f'Invalid playback state: {name}: {state}'
                break
            if name == 'enabled' and (not state['hasImpulse'] or state['engine']['suspended'] or state['engine']['graphCount'] != 1):
                invalid_reason = f'Effects did not start: {state}'
                break
            before, _ = usage(root_pid)
            started = time.monotonic()
            samples = []
            previous = before
            sampled = started
            for _ in range(4):
                time.sleep(3)
                after, pss_mib = usage(root_pid)
                now = time.monotonic()
                samples.append(round(cpu_delta(previous, after, now - sampled), 2))
                previous, sampled = after, now
            elapsed = time.monotonic() - started
            cpu = statistics.median(samples)
            by_process = []
            for pid, ticks in after.items():
                try:
                    name_of_process = Path(f'/proc/{pid}/comm').read_text().strip()
                except OSError:
                    continue
                by_process.append({'name': name_of_process, 'cpu_percent_one_core': round(cpu_delta({pid: before.get(pid, 0)}, {pid: ticks}, elapsed), 2)})
            row = {'mode': name, 'cpu_percent_one_core': round(cpu, 2), 'cpu_mean_percent_one_core': round(cpu_delta(before, after, elapsed), 2), 'cpu_samples': samples, 'pss_mib': pss_mib, 'sample_seconds': round(elapsed, 2), 'processes': by_process, 'state': state}
            results.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        report = {'browser': args.browser, 'logical_cpus': os.cpu_count(), 'method': 'DSP-only stereo AudioBufferSource loop in one user-activated AudioContext; ten seconds startup warmup, median of four three-second samples per phase after two seconds settling; direct native routing before/after; CPU covers browser and all child processes, 100 percent means one CPU core. Does not measure HTML media decoding, slowing or live websites.', 'results': results}
        budget = json.loads((ROOT / 'performance-budget.json').read_text())
        report['gate'] = assess(report, budget)
        if invalid_reason:
            report['gate']['reasons'].append(invalid_reason)
        destination = ROOT / 'dist' / 'performance-zen.json'
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print('Report:', destination, flush=True)
        print('Performance gate:', json.dumps(report['gate']), flush=True)
        return {'pass': 0, 'fail': 1, 'inconclusive': 2}[report['gate']['status']]


if __name__ == '__main__':
    sys.exit(main())
