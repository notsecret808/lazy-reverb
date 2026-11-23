# Lazy Reverb

Change playback speed and pitch, add reverb, and boost bass on YouTube, YouTube Music, and SoundCloud. Lazy Reverb builds for **Zen Browser**, Firefox 128+, and Chromium 128+. Audio stays in the browser.

## Build a ZIP for the browser

After installing the dependencies below, run this from the project directory:

```sh
pnpm run package --target all
```

WXT generates a fresh Manifest V3 build for each target. Both `pnpm run build` and `pnpm run package` take `--target firefox`, `--target chromium`, or `--target all`. Firefox is the default.

| Target | Build directory | Unsigned ZIP |
| --- | --- | --- |
| Firefox and Zen | `dist/firefox/` | `dist/lazy-reverb-0.3.0-firefox.zip` |
| Chromium | `dist/chromium/` | `dist/lazy-reverb-0.3.0-chromium.zip` |

## Install and update in Zen

1. Download and unpack the repository sources.
2. Open `about:debugging#/runtime/this-firefox` in Zen.
3. Run `pnpm run build`. Select **Load Temporary Add-on…** and choose `dist/firefox/manifest.json`.
4. Refresh your music tabs, start playback, and open **Lazy Reverb** from the extensions menu.
5. Select **Lazy** or switch on **Audio effects** and adjust the sliders.

The current version is **0.3.0**. For a directory installation, run `pnpm run build` after updating and select **Reload** in `about:debugging`. For a ZIP installation, run `pnpm run package` and select the fresh archive through **Load Temporary Add-on…**. Then refresh your music tabs.

If you installed the extension from the repository root before the TypeScript migration, Zen still loads the popup from that directory. Rebuild and select `dist/firefox/manifest.json` or the Firefox ZIP in `about:debugging`, then refresh your music tab.

Temporary add-ons are removed when the browser restarts. Permanent installation requires Mozilla signing.

## Install in Chromium

1. Build with `pnpm run build --target chromium` or extract the Chromium ZIP.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked** and choose the directory containing `manifest.json`.
4. Refresh your music tabs and open Lazy Reverb from the extensions menu.

These packages are for local installation. Store submission, signing, and published updates use a separate release process.

## Quick access

- To pin the icon, open the Zen extensions menu, right-click **Lazy Reverb**, and select **Pin to Toolbar**. [Zen extensions guide](https://docs.zen-browser.app/user-manual/extensions)
- The default is **Ctrl+Shift+F8** on Firefox and Zen, **Ctrl+Shift+Y** on Chromium, and **Command+Shift+Y** for Chromium on macOS. The popup shows the shortcut reported by the browser.
- On Firefox and Zen, select **Assign Ctrl+Shift+F8** to restore the default, or use **Manage Extension Shortcuts** from the gear menu in `about:addons` to choose another key.
- On Chromium, select **Open shortcut settings** to change the binding in the browser. A conflicting system shortcut can prevent the popup from opening.

## Controls

| Setting | Effect |
| --- | --- |
| Audio effects | Enables processing in the current tab. Turning it off restores the original rate and pitch setting. |
| Speed | 0.50× to 2.00×. Pitch follows speed. |
| Reverb | 0–100% wet signal. At 100%, only the reverberated signal is audible. The impulse lasts 2.8 seconds. |
| Bass boost | 0 to +12 dB using a 200 Hz low-shelf filter. There is no gain compensation, so a loud source may clip. The amount of distortion depends on the source and browser output path. |
| Soft / Lazy / Deep / Faster | Presets enable processing immediately and keep the selected bass level. **Faster** sets 1.25× speed and 0% reverb. |

Preferences are saved locally. New and reloaded tabs start with effects off. For bass boost alone, set speed to **1.00×** and reverb to **0%**.

## Overhead and cleanup

The extension has no background process, network requests, analytics, timer polling, or global `MutationObserver`. The engine loads on supported sites, listens for media events and `play()`, and scans for existing players when enabled.

The bass and convolution nodes are created on demand. At 0 dB bass, the filter is disconnected. At 0% reverb, the convolution branch is disconnected and its buffer is released. Turning effects off restores the original rate and pitch setting and bypasses both DSP branches. Playback-rate changes alone need no `AudioContext` for an ordinary media player.

After a player is routed into Web Audio, a unity-gain dry path keeps it audible. The input uses the output's channel settings at connection time so mono and surround sources mix as they do at the browser output. Browsers allow one `MediaElementAudioSourceNode` per element, and suspending its context would mute it. Reload a page after removing or disabling the extension to unload its injected engine.

Players and contexts are tracked through weak references. For paused players removed from the DOM, the engine restores the original settings and disconnects any extension-owned source. A detached `new Audio()` that is still playing stays active. Cleanup preserves site-owned contexts and sources.

## Limitations

- DRM-protected streams and cross-origin audio without CORS keep their original audio route, with speed control still available.
- If the browser suspends an `AudioContext`, press Play or click the page.
- Effects apply to the top-level page, including ads. Cross-origin frames are outside the supported scope.
- YouTube and SoundCloud can change how their players work. Local tests cover the scenarios below.

## Development and checks

WXT builds each target using the Node version in `.nvmrc` and the pnpm version in `packageManager`. Install pnpm into the selected Node environment with `npm install --global pnpm@11.6.0` if needed.

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test:unit
```

Native checks require GeckoDriver 0.37.1. Put it in `dist/drivers/geckodriver`, add it to `PATH`, or pass `--driver /path/to/geckodriver`. Run `pnpm test --browser /path/to/firefox` for the native scenarios. For the full functional gate with Zen, run:

```sh
pnpm run check --browser /opt/zen/zen
```

Use `rtk run` in environments that require RTK.

Oxlint checks the authored source, tools, configuration, and tests with type information. Warnings, violations, and backend errors fail the check. `tsc --noEmit` checks the browser and Node projects separately. Both run before the build and browser checks, without auto-fixing files or suppressing nonzero exit codes. Unit tests run the built JavaScript, including garbage-collection coverage with `--expose-gc`. [TypeScript migration test coverage](docs/typescript-migration-coverage.md)

The dependency install runs `prepare`, which enables Husky. Pre-commit runs `check:commit` for the OpenSpec boundary, source/index parity, lint, types, and unit tests. Commit-msg enforces Conventional Commits. Pre-push checks the tree being pushed against HEAD, then runs the native functional and local Zen DSP gates. A failing step blocks the push. If Zen is installed outside `/opt/zen/zen`, set `LAZY_REVERB_BROWSER` for native tests and `LAZY_REVERB_ZEN` for the DSP gate. For GUI commits, launch your Git client from the shell after `nvm use` or set the selected Node and pnpm paths in your `~/.config/husky/init.sh`. Install both tools before committing.

The functional gate builds the runtime and ZIP once. Native scenarios install that archive. Unit tests also cover garbage collection, player restoration, routing, and API delays. The native audio scenario measures the main output before enabling effects, with bass and reverb, and after bypass and resumed playback.

### End-to-end test isolation

For Chromium, install the pinned test browser with `pnpm exec playwright install chromium`, then run `pnpm run test:chromium`. The runner extracts the generated ZIP for a temporary browser profile and opens the real popup. It uses the same local HTML and WAV responses as the Firefox tests.

The end-to-end tests use local HTML from `tests/native/fixtures/player.html` and WAV data from `tests/native/player-fixture.ts`. BiDi substitutes responses before navigation and aborts other HTTP(S) requests. The `www.youtube.com` and `soundcloud.com` domains serve as test origins. Service workers are disabled. GeckoDriver uses a temporary profile and terminates the processes it owns.

The native WebdriverIO scenarios install the ZIP and load the real popup document while the music tab is active. They cover browser APIs, tab isolation, preferences, keyboard input, CORS, and audio output through the main route. On failure, the runner saves available screenshots, HTML, console output, driver logs, and the scenario step. Opening the popup from the toolbar and pressing its physical shortcut are manual checks.

GitHub Actions uses Firefox 159.0 and GeckoDriver 0.37.1, with a dedicated PulseAudio instance and virtual sink for native audio tests. CI checks the commit range, lint, types, unit tests including sampler and verdict fixtures, native Firefox, and packaging. Zen and the hardware-dependent CPU/PSS gate run locally. Native artifacts are written to `dist/native/`. Pass `--screenshot /path/to/popup.png` for a popup screenshot.

### Performance gate

After changing the audio graph or resource cleanup, run:

```sh
pnpm run check:perf --browser /opt/zen/zen
```

Method 2 measures DSP on Linux with one `AudioContext` and one stereo source. A real click starts playback. The harness checks the audio clock and output signal before and after each sampling window. After warmup, each phase records four CPU/PSS samples and their actual intervals of about 3 seconds. Both summaries use the median. The previous method used the final sample for PSS. Measurements include the browser root process and its descendants. 100% CPU means one core.

| Budget | Allowed overhead above baseline playback |
| --- | --- |
| CPU with effects off, including after use | 5 percentage points of one core |
| CPU with 25% reverb and +6 dB bass | 20 percentage points of one core |
| PSS memory | 64 MiB above the original native route |

Budgets are in `performance-budget.json`. Exit code `0` means pass, `1` means a regression, and `2` means noisy or incomplete data. The two control routes expose drift. Missing processes or samples prevent a pass. `dist/performance-zen.json` contains the versions, state, and results. The hardware benchmark is required locally before pushing. CI covers the sampler and verdict with deterministic fixtures.

The benchmark measures bass and convolution and the return toward baseline after bypass. Its scope excludes HTML media decoding, rate changes, and full YouTube or SoundCloud pages. Results vary by machine.

The historical 0.3.0 run in Zen 1.24.3b on November 21, 2026 passed with the previous method, which reported the final PSS sample in each phase:

| Mode | CPU, % of one core | Browser process group PSS, MiB |
| --- | ---: | ---: |
| Native route before effects | 5.00 | 485.5 |
| Engine disabled before use | 5.46 | 514.1 |
| 25% reverb, +6 dB bass | 15.89 | 534.9 |
| Disabled after use | 5.47 | 510.9 |
| Final native route | 5.62 | 509.0 |

CPU after bypass was close to the control. PSS stayed 25.4 MiB above the initial control and 1.9 MiB above the final control. The browser may retain pages and caches, so these readings cannot establish whether all memory was released.

### Live service diagnostics

Use `pnpm run live:probe`, `pnpm run live:control`, or `pnpm run live:perf` for manual diagnostics. Network runs require an explicit `--url`. Performance diagnostics also require `--service youtube` or `--service soundcloud`. The control run uses a fresh profile without the add-on. See `--help` for options.

Playback availability for signed-out users, sign-in requirements, ads, and service restrictions can make a sample incomplete. Such a result cannot pass the performance gate. Diagnostic reports can include URLs and page excerpts. They stay in the ignored `dist/` directory.

## Architecture

See the [architecture overview](ARCHITECTURE.md) and the project map and invariants in [AGENTS.md](AGENTS.md).
