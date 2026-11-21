"""Real browser Web Audio and extension-page checks."""
import argparse
import base64
import json
from pathlib import Path
import time

from browser_session import browser_session, ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', default='firefox')
    parser.add_argument('--screenshot', type=Path)
    args = parser.parse_args()
    with browser_session(args.browser) as client:
        client.command('WebDriver:Navigate', {'url': 'data:text/html,<html lang="ru"><title>Lazy Reverb test</title><body>Audio test</body></html>'})
        # Keep the genuine browser convolver accessible to inspect its tail.
        client.inject_page_script('window.testConvolvers = []; window.testFilters = []; const create = AudioContext.prototype.createConvolver; AudioContext.prototype.createConvolver = function() { const node = create.call(this); testConvolvers.push(node); return node; }; const filter = AudioContext.prototype.createBiquadFilter; AudioContext.prototype.createBiquadFilter = function() { const node = filter.call(this); testFilters.push(node); return node; }; window.testConnect = AudioNode.prototype.connect;')
        client.inject_page_script((ROOT / 'engine.js').read_text())
        result = client.execute('''
const done = arguments[arguments.length - 1];
(async () => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const player = document.createElement('audio');
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  player.playbackRate = 1.25; player.preservesPitch = true;
  document.body.append(player);
  __lazyReverb.set({ enabled: true, rate: 0.8, mix: 0.4 });
  check(player.playbackRate === 0.8 && !player.preservesPitch, 'speed/pitch not applied');
  __lazyReverb.set({ enabled: false });
  check(player.playbackRate === 1.25 && player.preservesPitch, 'bypass did not restore media');
  const ctx = new AudioContext();
  const source = ctx.createBufferSource();
  const inputBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.06), ctx.sampleRate);
  const input = inputBuffer.getChannelData(0);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 2 * Math.PI * 440 / ctx.sampleRate) * 0.5;
  // Gecko acquires buffer contents on assignment: fill before handing it over.
  source.buffer = inputBuffer;
  const convolverCount = testConvolvers.length;
  source.connect(ctx.destination);
  check(testConvolvers.length === convolverCount, 'disabled graph created a convolver');
  check(testFilters.length === 0, 'disabled graph created a bass filter');
  __lazyReverb.set({ enabled: true, mix: 0.4 });
  const convolver = testConvolvers.at(-1);
  const meter = ctx.createAnalyser(); meter.fftSize = 2048;
  testConnect.call(convolver, meter);
  const silent = ctx.createGain(); silent.gain.value = 0;
  testConnect.call(meter, silent); testConnect.call(silent, ctx.destination);
  check(convolver.buffer?.numberOfChannels === 2, 'no stereo impulse');
  check(Math.abs(convolver.buffer.duration - 2.8) < 0.001, 'wrong impulse duration');
  await ctx.resume();
  const direct = ctx.createAnalyser(); direct.fftSize = 2048;
  testConnect.call(source, direct); testConnect.call(direct, silent);
  source.start(ctx.currentTime + 0.05);
  const readings = [];
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
    const raw = new Float32Array(direct.fftSize); direct.getFloatTimeDomainData(raw);
    readings.push({ time: ctx.currentTime, wet: Math.max(...samples.map(Math.abs)), dry: Math.max(...raw.map(Math.abs)) });
  }
  const peak = Math.max(...readings.filter(row => row.time > 0.2).map(row => row.wet));
  const offline = new OfflineAudioContext(2, ctx.sampleRate, ctx.sampleRate);
  const offlineSource = offline.createBufferSource(); offlineSource.buffer = source.buffer;
  const offlineReverb = offline.createConvolver(); offlineReverb.buffer = convolver.buffer;
  offlineSource.connect(offlineReverb); offlineReverb.connect(offline.destination);
  offlineSource.start();
  const rendered = await offline.startRendering();
  const offlinePeak = Math.max(...rendered.getChannelData(0).slice(Math.floor(ctx.sampleRate * 0.2)).map(Math.abs));
  check(peak > 0.000001, `no real-time reverb tail: readings=${JSON.stringify(readings)}, offlinePeak=${offlinePeak}`);
  __lazyReverb.set({ mix: 0, bass: 9, rate: 1 });
  check(convolver.buffer === null, 'zero mix did not release convolution buffer');
  const bassFilter = testFilters.find(filter => filter.context === ctx);
  check(bassFilter?.type === 'lowshelf', 'no bass shelf');
  await new Promise(resolve => setTimeout(resolve, 150));
  const frequencies = new Float32Array([50, 2000]);
  const magnitudes = new Float32Array(2); const phases = new Float32Array(2);
  bassFilter.getFrequencyResponse(frequencies, magnitudes, phases);
  const bassRatio = magnitudes[0] / magnitudes[1];
  check(bassRatio > 2, `bass shelf did not boost low frequencies: ${bassRatio}`);
  __lazyReverb.set({ enabled: false });
  check(convolver.buffer === null && ctx.state === 'running', 'disabled FX must free the impulse without suspending page audio');
  source.disconnect(ctx.destination);
  await ctx.close();
  return { speed: 'ok', pitch: 'ok', bypass: 'ok', realConvolution: 'ok', bassBoost: 'ok', lazyNodes: 'ok', disconnect: 'ok', tailPeak: peak, offlinePeak, bassRatio };
})().then(result => done({ ok: true, ...result }), error => done({ ok: false, error: error.message }));
''', asynchronous=True)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        value = result.get('value', result)
        if not value.get('ok'):
            raise RuntimeError('Audio smoke test failed')
        # WebDriver Navigate disallows moz-extension URLs even with
        # system access. Load the real popup through the browser UI.
        client.command('Marionette:SetContext', {'value': 'chrome'})
        client.execute(f'window.gBrowser.selectedBrowser.loadURI(Services.io.newURI("moz-extension://{client.extension_uuid}/popup.html"), {{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}});')
        client.command('Marionette:SetContext', {'value': 'content'})
        popup = None
        for _ in range(30):
            popup = client.execute('return {title: document.querySelector("h1")?.textContent, status: document.querySelector("#status")?.textContent, disabled: document.querySelector("#enabled")?.disabled};').get('value')
            if popup and popup['title'] == 'Lazy Reverb' and popup['status'] != 'Подключение к вкладке…':
                break
            time.sleep(0.1)
        if not popup or popup['title'] != 'Lazy Reverb' or popup['status'] != 'Откройте YouTube или SoundCloud, чтобы включить эффект.' or not popup['disabled']:
            raise RuntimeError(f'Popup test failed: {popup}')
        print('Popup: real extension page and unsupported-tab handling OK')
        ui = client.execute('return {bass: document.querySelector("#bass")?.max, shortcut: document.querySelector("footer")?.textContent, height: document.body.getBoundingClientRect().height};').get('value')
        if ui['bass'] != '12' or 'Alt+Shift+L' not in ui['shortcut'] or ui['height'] > 600:
            raise RuntimeError(f'Bass/shortcut/layout test failed: {ui}')
        if args.screenshot:
            element = client.command('WebDriver:FindElement', {'using': 'css selector', 'value': 'body'})
            element_id = element['value']['element-6066-11e4-a52e-4f735466cecf']
            screenshot = client.command('WebDriver:TakeScreenshot', {'id': element_id, 'full': False, 'scroll': True})
            args.screenshot.write_bytes(base64.b64decode(screenshot['value']))
            print('Screenshot:', args.screenshot)


if __name__ == '__main__':
    main()
