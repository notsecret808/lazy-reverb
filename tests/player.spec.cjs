const { test, expect } = require('./browser-fixture.cjs');

test('native playback is untouched until the effect is enabled', async ({ lab }) => {
  const page = await lab.player();
  expect(await lab.state(page)).toMatchObject({ enabled: false, rateNow: 1.25, pitchNow: true, graphCount: 0 });
  const panel = await lab.open(page);
  await expect(panel.getByRole('switch')).not.toBeChecked();
  await expect(panel.locator('#status')).toContainText('Эффект выключен');
});

test('preset enables slowing and pitch change; disabling restores native playback', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Лениво' }).click();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true, rateNow: 0.85, pitchNow: false, mix: 0.25 });
  await panel.getByRole('switch').uncheck();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: false, rateNow: 1.25, pitchNow: true, paused: false });
});

test('bass slider supports keyboard input and exposes its value', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await panel.getByRole('switch').check();
  await panel.getByRole('slider', { name: 'Бас-буст' }).focus();
  await panel.keyboard.press('ArrowRight');
  await expect.poll(() => lab.state(page)).toMatchObject({ bass: 1 });
  await expect(panel.locator('#bass-value')).toHaveText('+1 дБ');
});

test('latest slider values win and survive reopening the panel', async ({ lab }) => {
  const page = await lab.player(); let panel = await lab.open(page);
  await panel.getByRole('switch').check();
  await lab.slider(panel, 'bass', 7); await lab.slider(panel, 'rate', 0.72);
  for (const value of [0.1, 0.2, 0.3, 0.4]) await lab.slider(panel, 'mix', value);
  await expect.poll(() => lab.state(page)).toMatchObject({ bass: 7, rate: 0.72, mix: 0.4 });
  await expect.poll(() => lab.writes.at(-1)).toEqual({ bass: 7, rate: 0.72, mix: 0.4 });
  panel = await lab.open(page);
  await expect(panel.getByRole('switch')).toBeChecked();
  await expect(panel.locator('#bass')).toHaveValue('7');
});

test('saved preferences load into a new tab without enabling effects', async ({ lab }) => {
  lab.seedPreferences({ rate: 0.8, mix: 0.4, bass: 6 });
  const page = await lab.player(); const panel = await lab.open(page);
  await expect(panel.locator('#bass')).toHaveValue('6');
  expect(await lab.state(page)).toMatchObject({ enabled: false, rate: 0.8, bass: 6, rateNow: 1.25, graphCount: 0 });
});

test('hidden SoundCloud-style player reuses the site-owned graph', async ({ lab }) => {
  const page = await lab.player('soundcloud.com'); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Лениво' }).click();
  await lab.slider(panel, 'bass', 6);
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true, bass: 6, rateNow: 0.85, graphCount: 1, blockedCount: 0 });
  await panel.getByRole('switch').uncheck();
  await expect.poll(() => lab.state(page)).toMatchObject({ rateNow: 1.25, paused: false });
});

test('changes in one tab do not affect another active tab', async ({ lab }) => {
  const first = await lab.player(); let panel = await lab.open(first);
  await panel.getByRole('button', { name: 'Лениво' }).click(); await lab.slider(panel, 'bass', 7);
  await expect.poll(() => lab.state(first)).toMatchObject({ enabled: true, bass: 7 });
  const second = await lab.player('soundcloud.com'); panel = await lab.open(second);
  await panel.getByRole('switch').check(); await lab.slider(panel, 'bass', 3);
  await expect.poll(() => lab.state(second)).toMatchObject({ bass: 3, enabled: true });
  expect(await lab.state(first)).toMatchObject({ bass: 7, enabled: true });
});

test('SPA player replacement keeps the effect and restores its own original rate', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Лениво' }).click();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true });
  await page.evaluate(async () => {
    player.pause(); player.remove();
    window.player = document.createElement('video'); player.src = '/tone.wav'; player.volume = 0; player.loop = true;
    player.playbackRate = 1.5; player.preservesPitch = true; document.body.append(player); await player.play();
  });
  await expect.poll(() => lab.state(page)).toMatchObject({ rateNow: 0.85, paused: false });
  await panel.getByRole('switch').uncheck();
  await expect.poll(() => lab.state(page)).toMatchObject({ rateNow: 1.5, pitchNow: true, paused: false });
});

test('reload leaves effects off and restores saved controls on opening', async ({ lab }) => {
  const page = await lab.player(); let panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Лениво' }).click(); await lab.slider(panel, 'bass', 5);
  await expect.poll(() => lab.writes.at(-1)?.bass).toBe(5);
  await page.reload(); panel = await lab.open(page);
  await expect(panel.getByRole('switch')).not.toBeChecked();
  await expect(panel.locator('#bass')).toHaveValue('5');
  expect(await lab.state(page)).toMatchObject({ enabled: false, rateNow: 1.25, graphCount: 0 });
});

test('non-CORS stream keeps playing with speed-only fallback and a clear status', async ({ lab }) => {
  const page = await lab.player('www.youtube.com', '?blocked=1'); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Лениво' }).click();
  await expect.poll(() => lab.state(page)).toMatchObject({ blockedCount: 1, graphCount: 0, rateNow: 0.85, paused: false });
  await expect(panel.locator('#status')).toContainText('защиты аудио');
});

test('speed-only mode never creates a Web Audio context for a plain player', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await lab.slider(panel, 'mix', 0); await lab.slider(panel, 'bass', 0);
  await panel.getByRole('switch').check();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true, mix: 0, bass: 0, graphCount: 0 });
});

test('unsupported site has no engine and the panel cannot enable effects', async ({ lab }) => {
  const page = await lab.player('unsupported.test'); const panel = await lab.open(page, false);
  await expect(panel.getByRole('switch')).toBeDisabled();
  expect(await page.evaluate(() => window.__lazyReverb === undefined)).toBe(true);
});

test('speed up to 2x and reverb to 100 percent are available from the panel', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await lab.slider(panel, 'rate', 2); await lab.slider(panel, 'mix', 1);
  await panel.getByRole('switch').check();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true, rate: 2, rateNow: 2, mix: 1, pitchNow: false });
  await expect(panel.locator('#rate-value')).toHaveText('2,00×');
  await expect(panel.locator('#mix-value')).toHaveText('100 %');
  await panel.getByRole('switch').uncheck();
  await expect.poll(() => lab.state(page)).toMatchObject({ rateNow: 1.25, pitchNow: true, paused: false });
});

test('faster preset enables playback above normal speed without adding reverb', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Быстрее' }).click();
  await expect.poll(() => lab.state(page)).toMatchObject({ enabled: true, rate: 1.25, mix: 0, graphCount: 0 });
});

test('shortcut binding can be reset from the panel without affecting playback', async ({ lab }) => {
  const page = await lab.player(); const panel = await lab.open(page);
  await panel.getByRole('button', { name: 'Назначить Ctrl+Shift+F8' }).click();
  await expect(panel.locator('#shortcut')).toContainText('Ctrl+Shift+F8');
  expect(await lab.state(page)).toMatchObject({ enabled: false, rateNow: 1.25 });
});
