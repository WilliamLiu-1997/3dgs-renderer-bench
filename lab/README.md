# Browser benchmark lab

The test page at `/test/` runs entirely in the browser:

- Drop a local PLY, SPZ or SOG, or enter a direct HTTP(S) URL ending in `.ply`, `.spz` or `.sog` (query parameters are supported). Remote servers must allow CORS. Downloads can be stopped and happen once in the browser; all renderers share the downloaded file. Download time is excluded from renderer load time and recorded as `source.downloadMs` in JSON. Files are never uploaded to a server. SPZ is converted locally to a common PLY with `@playcanvas/splat-transform@3.6.4`, preserving SH; conversion time is reported separately. This is not a comparison of native SPZ loaders. SOG files are loaded directly through each renderer’s native loader, preserving shared SH codebooks where supported. Radix 0.0.1 is disabled for SOG; Spark and Aholo decode into per-splat SH storage.
- Preview and orbit the model, or enter an exact shared camera. Configure physical resolution, warm-up, sampling time, and repeat count. Rendering parameters use fixed matched presets.
- All selected depth-sorted backends use radial distance sorting without post-processing. Reports record the effective settings for each backend.
- Select Spark / WebGL2, Radix / WebGPU or WebGL2, SuperSplat Viewer / WebGPU, PlayCanvas Engine / WebGL2 or WebGPU, and Gaussian Splat Lite / WebGL2 or WebGPU. The published main report records its exact tested versions and settings.
- Each visit automatically checks GitHub Releases and Tags, plus PlayCanvas package-version commits. Versions (including beta/alpha/rc) are cross-checked against published npm packages. Network errors or GitHub rate limits are shown; bundled versions and manual exact-version entry remain available. The selection is never silently upgraded.
- Run selected backends in fresh iframes, alternating forward/reverse order and then rotating the starting backend, with separate results and screenshots for each backend. Export raw JSON and a multi-page PDF with matching on-page previews, settings, camera, screenshots, per-round results and failure details.
- Page and PDF tables show FPS, P50 and P95; the page switches between Static and Orbit results. The highest FPS and lowest frame intervals are highlighted independently for each scenario. Values tied at two decimal places share the highlight; missing results and failed rounds are excluded.

## Rendering presets

Fixed public settings follow GSL's preset as closely as the renderers allow:

| Setting | GSL | Spark | PlayCanvas |
| --- | --- | --- | --- |
| Attribute storage | 32-byte base records / accumulator | Extended source + accumulator | `dataFormat: 'large'` (32-byte work buffer) |
| Minimum radius / size | `minPixelRadius: 1` | `minPixelRadius: 2` | `minPixelSize: 2` |
| Maximum radius | No public limit setting in 1.7.0 | `maxPixelRadius: 512` | No equivalent public setting |
| Pre-blur / compensated blur | `0.3 / 0` | `0.3 / 0` | Native 0.3 blur, `antiAlias: false` |
| Focal adjustment | `2` | `2` | Native projection |
| Forward alpha threshold | `minAlpha: 1 / 255` | `minAlpha: 1 / 255` | `alphaClipForward: 1 / 255` |
| Sorting | Radial distance | Radial distance | Radial distance |

Spark's minimum radius uses focal-scaled units, so it is multiplied by GSL's focal adjustment. Spark and Radix retain their 512-pixel maximum radius; GSL 1.7.0 does not expose that limit. PlayCanvas's projected size threshold is matched on the same basis; its extra contribution culling is disabled (`minContribution: 0`). Spark and GSL use `clipXY: 1.25`. PlayCanvas has no equivalent public frustum-margin or maximum-radius control. Sorting precision, opacity-dependent support and other native projection details still differ, so these presets do not guarantee identical images. These parameters are fixed in the lab. See the [Spark parameters](https://sparkjs.dev/docs/spark-renderer/) and [PlayCanvas parameters](https://api.playcanvas.com/engine/classes/GSplatParams.html).

PlayCanvas uses `large` on both WebGL2 and WebGPU, and reports the effective `dataFormat`. This aligns attribute storage more closely with GSL and Spark Extended; their encodings still differ. It does not change framebuffer or sorting precision.

Radix uses EWA projection, extended source data, SH up to degree 3, radial sorting with the native default 24-bit keys, `minAlpha: 1/255`, `preBlurAmount: 0.3`, `blurAmount: 0`, `clipXY: 1.25`, minimum radius 2 and maximum radius 512. Its WebGL2 backend uses Three.js WebGPURenderer's WebGL fallback.

Viewer is created through its public `createViewer` API. Sorted rendering, full input data and the Engine preset above are used; stochastic rendering, post effects and performance resolution scaling are disabled. Its automatic 180° model rotation is reset, and every draw uses the shared vertical FOV, clipping planes, pose and physical dimensions. The lab drives Viewer updates and draws explicitly at the fixed physical resolution through `app.update` and `app.render`. Its loading timer runs from `createViewer()` to the `firstFrame` event, including Viewer initialization, model loading and initial rendering. Other backends time their public loader calls, so these loading intervals are not directly comparable.

## Run locally

From the repository root, with Node.js 22 or 24:

```sh
npm ci
npm run dev
# http://127.0.0.1:5349/test/
```

Bundled versions: GSL 1.7.0, Spark 2.4.0, Radix 0.0.1, Viewer 1.42.0, PlayCanvas 2.24.0-beta.30. This Engine version is bundled locally. Scoped peer overrides keep Viewer and the converter on the same Engine.

GSL and Spark use Three.js 0.187.0. Radix uses a separate 0.186.1 selection because its published WebGPU implementation fails with r187. Each result records its actual Three.js revision. Radix 0.0.1 incorrectly lists unused development tools, including macOS-only fsevents, as runtime dependencies. The local package retains its official browser modules unchanged and removes only those dependency/build-script metadata entries so installation also works on Linux/Vercel.

The dev server tries the next port if 5349 is occupied; use the URL printed in the terminal. To require a specific port, run `PORT=5350 npm run dev`.

The dev server builds into a separate temporary directory, so `npm run build` does not interrupt loaded modules. Restart the dev server after source changes.

## Measurement and compatibility

The report and lab share one sampler. Frames are drawn with one GPU frame in flight: a new frame is submitted only after the previous frame's GPU work has completed (WebGL2 fence / WebGPU onSubmittedWorkDone); camera motion and asynchronous sorting keep running meanwhile. Each sample is the interval between consecutive frame submissions, measured with performance.now(). FPS = frames / sampled time. Browser refresh-rate limits apply.

Each run reports `FPS = frames / sampled time` and P50/P95 frame intervals. Across rounds, each statistic uses the median of its per-run values. Orbit motion advances by real elapsed time with ±45° amplitude and an 8-second period, continuously through warm-up and sampling. Static tests keep drawing with native caches. Asynchronous sorting keeps its native schedule.

Outside sampling, GPU completion is also awaited to drain earlier work and validate renders/captures. WebGL uses `fenceSync` / `clientWaitSync`; WebGPU uses the standard canvas configuration and `GPUQueue.onSubmittedWorkDone()`. Graphics errors invalidate the run. Public loader time is separate. GSL WebGPU awaits its public `update({ scene, camera })` before warm-up so the initial compute nodes are ready. JSON schema `splat-lab/8` identifies `frame-interval-ms` with `framesInFlight: 1` and includes raw `frameTimes`, timed rows, `frames`, `elapsedMs`, `fps` and `frameMs.mean/p50/p95`.

The lab does not patch dependencies, shaders, workers, browser graphics APIs, or private renderer state. Published renderer modules are copied unchanged; PlayCanvas is built from the pinned official commit; selected alternate versions load their published ESM modules from jsDelivr. A version without the required public API fails explicitly. Compatibility depends on the selected renderer and Three.js versions; Three.js is independently selectable and recorded. WebGPU needs a secure context (HTTPS or localhost), a supported browser and GPU. The instrumented harness uses the same sampler and separately records sorting and memory. GPU timestamps are confined to its isolated sorting diagnostic.

SPZ conversion runs in a disposable Worker. Only one rendering iframe is active at a time. Viewer updates and draws are driven by the lab at the selected physical resolution. WebGPU validation errors and device loss fail the round and exclude it from ranking. Hiding the page, resizing the window or pressing Stop ends a run; unfinished cases are not included as successful measurements. Browser/driver memory reclamation remains browser-managed. PDF pages are rasterized locally to match the preview; raw JSON retains the exact numeric samples and configuration.

See the [project README](../README.md) for measured results and reproduction.
