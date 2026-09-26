# Browser benchmark lab

The test page at `/test/` runs entirely in the browser:

- Drop a local PLY or SPZ, or enter a direct HTTP(S) URL ending in `.ply` or `.spz` (query parameters are supported). Remote servers must allow CORS. Downloads can be stopped and happen once in the browser; all renderers share the downloaded file. Download time is excluded from renderer load time and recorded as `source.downloadMs` in JSON. Files are never uploaded to a server. SPZ is converted locally to a common PLY with `@playcanvas/splat-transform@3.6.4`, preserving SH; conversion time is reported separately. This is not a comparison of native SPZ loaders.
- Preview and orbit the model, or enter an exact shared camera. Configure physical resolution, warm-up, sampling time, and repeat count. Rendering parameters use fixed matched presets.
- All selected backends use camera-axis depth sorting without post-processing. Reports record the effective settings for each backend.
- Select Spark / WebGL2, PlayCanvas Engine / WebGL2 or WebGPU, and Gaussian Splat Lite / WebGL2 or WebGPU. This uses the Engine, not the SuperSplat Editor adapter from the historical report.
- Each visit automatically checks GitHub Releases and Tags, plus PlayCanvas package-version commits. Versions (including beta/alpha/rc) are cross-checked against published npm packages. Network errors or GitHub rate limits are shown; bundled versions and manual exact-version entry remain available. The selection is never silently upgraded.
- Run selected backends sequentially in fresh iframes, with separate results and screenshots for each backend. Export raw JSON and a multi-page PDF with matching on-page previews, settings, camera, screenshots, per-round results and failure details.
- Page and PDF tables mark the lowest displayed Frame P50 and Frame P95 in green, independently for each scenario. Values tied at two decimal places share the highlight; missing results are excluded.

## Rendering presets

Fixed public settings follow GSL's preset as closely as the renderers allow:

| Setting | GSL | Spark | PlayCanvas |
| --- | --- | --- | --- |
| Attribute storage | 32-byte base records / accumulator | Extended source + accumulator | `dataFormat: 'large'` (32-byte work buffer) |
| Minimum radius / size | `minPixelRadius: 1` | `minPixelRadius: 2` | `minPixelSize: 2` |
| Maximum radius | `maxPixelRadius: 256` | `maxPixelRadius: 512` | No equivalent public setting |
| Pre-blur / compensated blur | `0.3 / 0` | `0.3 / 0` | Native 0.3 blur, `antiAlias: false` |
| Focal adjustment | `2` | `2` | Native projection |
| Forward alpha threshold | `minAlpha: 1 / 255` | `minAlpha: 1 / 255` | `alphaClipForward: 1 / 255` |
| Sorting | Camera-axis depth | Camera-axis depth | Camera-axis depth |

Spark's radius limits are in focal-scaled units, so its limits are multiplied by GSL's focal adjustment. PlayCanvas's projected size threshold is matched on the same basis; its extra contribution culling is disabled (`minContribution: 0`). Spark and GSL use `clipXY: 1.25`. PlayCanvas has no equivalent public frustum-margin or maximum-radius control. Sorting precision, opacity-dependent support and other native projection details still differ, so these presets do not guarantee identical images. These parameters are fixed in the lab. See the [Spark parameters](https://sparkjs.dev/docs/spark-renderer/) and [PlayCanvas parameters](https://api.playcanvas.com/engine/classes/GSplatParams.html).

PlayCanvas uses `large` on both WebGL2 and WebGPU, and reports the effective `dataFormat`. This aligns attribute storage more closely with GSL and Spark Extended; their encodings still differ. It does not change framebuffer or sorting precision.

## Run locally

From the repository root, with Node.js 22 or 24:

```sh
npm ci
npm run dev
# http://127.0.0.1:5349/test/
```

The bundled PlayCanvas version is a pinned prerelease. A scoped npm override lets `@playcanvas/splat-transform` share that version despite its stable-only peer range.

The dev server tries the next port if 5349 is occupied; use the URL printed in the terminal. To require a specific port, run `PORT=5350 npm run dev`.

The dev server builds into a separate temporary directory, so `npm run build` does not interrupt loaded modules. Restart the dev server after source changes.

## Measurement and compatibility

The page measures **frame completion time** in milliseconds: immediately before drawing to completion of submitted GPU work. It reports Frame P50 and Frame P95, with one frame in flight. WebGL uses `fenceSync` / `clientWaitSync` with asynchronous polling; WebGPU uses `GPUQueue.onSubmittedWorkDone()`, obtaining the queue through the standard canvas `getConfiguration()` API. No renderer internals are accessed. Browsers missing this API cannot run WebGPU timing. `requestAnimationFrame` schedules samples outside the timer, so waiting for screen refresh is excluded. Completion includes CPU submission, GPU work and synchronization overhead; it is not isolated GPU execution time or display latency.

Public model-load completion time is reported separately. Before the first render and warm-up, GSL WebGPU awaits its public `update({ scene, camera })` method so the initial compute nodes are ready. This preparation is excluded from model-load and warm-up timing; remaining projection slots may still compile in the background. The timed draw call is Three.js `renderer.render` or PlayCanvas `app.update` + `app.render`. Camera updates are excluded. Native asynchronous sorting remains active; pending worker results are not awaited. Internal sort latency and GPU memory are not measured. JSON schema `splat-lab/4` identifies the `frame-completion-ms` metric and contains raw `frameTimes` samples plus a `backend` identifier for each result; these differ from the former rAF frame intervals.

The lab does not patch dependencies, shaders, workers, browser graphics APIs, or private renderer state. Pinned packages are copied unchanged from npm; selected alternate versions load their published ESM modules from jsDelivr. A version without the required public API fails explicitly. Older/newer combinations are not guaranteed compatible; Three.js is independently selectable and recorded. WebGPU needs a secure context (HTTPS or localhost), a supported browser and GPU. The historical instrumented harness remains separate.

SPZ conversion runs in a disposable Worker. Only one rendering iframe is active at a time. Hiding the page, resizing the window or pressing Stop ends a run; unfinished cases are not included as successful measurements. Browser/driver memory reclamation remains browser-managed. PDF pages are rasterized locally to match the preview; raw JSON retains the exact numeric samples and configuration.

See the [project README](../README.md) for historical results and reproduction.
