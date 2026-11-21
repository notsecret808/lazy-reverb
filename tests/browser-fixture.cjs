// Playwright does not support Firefox extension APIs. This test-only bridge
// runs the unchanged popup injection function in a real Firefox player page.
// Service hostnames exercise the production allowlist without live requests;
// every response is fulfilled below from local HTML, assets or generated PCM.
const { test: base, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const engine = readFileSync(path.join(root, 'engine.js'), 'utf8');
const panelHost = 'lazy-reverb.test';
const files = new Set(['popup.html', 'popup.js', 'popup.css', 'icon.svg']);

const playerHtml = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Player fixture</title>
<button id="play">Play</button><script>
const hidden = location.hostname === 'soundcloud.com';
window.player = document.createElement(hidden ? 'audio' : 'video');
player.src = location.search.includes('blocked') ? 'https://audio.test/tone.wav' : '/tone.wav';
player.volume = 0; player.loop = true; player.playbackRate = 1.25; player.preservesPitch = true;
if (!hidden) document.body.append(player);
if (hidden) {
  window.siteContext = new AudioContext();
  siteContext.createMediaElementSource(player).connect(siteContext.destination);
}
document.querySelector('#play').onclick = () => player.play();
</script></html>`;

const wave = Buffer.alloc(44 + 16000 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 0; i < 16000; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 8000) * 2000), 44 + i * 2);

const test = base.extend({
  lab: async ({ context }, use) => {
    const pages = new Map();
    let currentTab;
    let currentPanel;
    let preferences;
    let shortcut = 'Ctrl+Shift+F8';
    const writes = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === panelHost) {
        const name = url.pathname.slice(1);
        if (!files.has(name)) return route.abort();
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript';
        return route.fulfill({ contentType: type, body: readFileSync(path.join(root, name)) });
      }
      if (['www.youtube.com', 'soundcloud.com', 'audio.test', 'unsupported.test'].includes(url.hostname)) {
        if (url.pathname === '/tone.wav') return route.fulfill({ contentType: 'audio/wav', body: wave });
        return route.fulfill({ contentType: 'text/html', body: playerHtml });
      }
      return route.abort('blockedbyclient');
    });
    await context.addInitScript({ content: `if (['www.youtube.com', 'soundcloud.com'].includes(location.hostname)) {\n${engine}\n}` });
    await context.exposeBinding('__extensionCall', async (_source, method, request) => {
      if (method === 'tabs') return [{ id: currentTab, url: pages.get(currentTab).url() }];
      if (method === 'get') return { preferences: structuredClone(preferences) };
      if (method === 'set') { preferences = structuredClone(request.preferences); writes.push(preferences); return; }
      if (method === 'shortcuts-get') return [{ name: '_execute_action', shortcut }];
      if (method === 'shortcuts-set') { shortcut = request.shortcut; return; }
      if (method === 'execute') {
        if (request.world !== 'MAIN' || !pages.has(request.target.tabId)) throw Error('Invalid injection target');
        const result = await pages.get(request.target.tabId).evaluate(({ source, args }) => {
          const inject = (0, eval)(`(${source})`);
          return inject(...args);
        }, { source: request.source, args: request.args });
        return [{ result }];
      }
      throw Error(`Unknown bridge method: ${method}`);
    });
    await context.addInitScript(({ panelHost }) => {
      if (location.hostname !== panelHost) return;
      window.browser = {
        commands: {
          getAll: () => window.__extensionCall('shortcuts-get'),
          update: request => window.__extensionCall('shortcuts-set', request),
        },
        tabs: { query: () => window.__extensionCall('tabs') },
        scripting: { executeScript: request => window.__extensionCall('execute', {
          target: request.target, world: request.world, args: request.args, source: request.func.toString(),
        }) },
        storage: { local: {
          get: () => window.__extensionCall('get'),
          set: request => window.__extensionCall('set', request),
        } },
      };
    }, { panelHost });
    const lab = {
      writes,
      seedPreferences(value) { preferences = structuredClone(value); },
      async player(host = 'www.youtube.com', query = '') {
        const page = await context.newPage();
        pages.set(pages.size + 1, page);
        await page.goto(`https://${host}/player${query}`);
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect.poll(() => page.evaluate(() => player.paused)).toBe(false);
        return page;
      },
      async open(target, supported = true) {
        currentTab = [...pages].find(([, page]) => page === target)[0];
        if (currentPanel) await currentPanel.close();
        currentPanel = await context.newPage();
        await currentPanel.goto(`https://${panelHost}/popup.html`);
        if (supported) await expect(currentPanel.getByRole('switch')).toBeEnabled();
        else await expect(currentPanel.locator('#status')).toContainText('Откройте YouTube');
        return currentPanel;
      },
      async state(page) {
        return page.evaluate(() => ({ ...window.__lazyReverb?.get(), rateNow: player.playbackRate, pitchNow: player.preservesPitch, paused: player.paused }));
      },
      async slider(panel, name, value) {
        await panel.locator(`#${name}`).fill(String(value));
      },
    };
    await use(lab);
  },
});

module.exports = { test, expect };
