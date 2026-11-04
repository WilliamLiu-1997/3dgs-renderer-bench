# 3DGS Renderer Bench

Instrumented benchmark of original PLY models, with rendering settings adjusted as closely as possible.

- Spark 2.4.0 / WebGL2, extended source and accumulator.
- Radix 0.0.1 / WebGPU and WebGL2, EWA projection, extended source and native default 24-bit sorting.
- GSL 1.6.2 / WebGPU and WebGL2.
- SuperSplat Viewer 1.42.0 / WebGPU, created through its Viewer API and using sorted Engine rendering.
- PlayCanvas Engine 2.24.0-beta.30 / WebGPU and WebGL2, `dataFormat: 'large'`.
- Three.js 0.187.0 for GSL/Spark; 0.186.1 for Radix because its released WebGPU implementation is incompatible with r187.
- Elevator: 2,796,503 splats; HotelFareza: 12,202,010; WillaGlobalPoland: 14,469,103. Full PLY/SH3 inputs without generated LOD.
- 1512 × 982 CSS pixels, DPR 2, 3024 × 1964 physical pixels. No MSAA. Vertical FOV 45°, near 0.1, far 3000, background #101418.

## Run

Requires Node.js 22 or 24 and local Google Chrome. Put the PLY files in `../models/`, or set their local paths in `config.json`. Models are served only on localhost and are never uploaded. The harness shares the repository's single `package.json`; run everything from the repository root:

```sh
npm ci
npm run bench:build   # instrumented renderer Workers → harness/dist/
npm run bench:pilot   # quick smoke test → harness/pilot/
npm run bench         # formal runs → harness/results-current/
```

Formal frame cases use 2 seconds of warm-up, then 5 seconds static or 8 seconds moving (`warmupSeconds` / `sampleSeconds` in `config.json`). Chrome uses its normal frame scheduling without frame-rate/vsync disabling flags.

The runner uses port 5351 (`PORT` overrides it), starts/stops its own server, and launches a fresh Chrome process per model/backend/round. Paired rounds run forward/reverse order; the next pair rotates the starting backend. Each result records its execution order. GSL always uses default sorting (`fastSort: true`); Radix uses its default `sortBits: 24`. Completed results with the current protocol are skipped. `RESULTS_DIR` overrides the destination. The published `results/` contains the raw data behind `report/`.

Background activity: on macOS the runner keeps the system awake and declares user activity every 30 s, because idle-time maintenance on an idle Mac on AC power (media analysis, Photos indexing, Messages) slowed GPU-bound runs by up to 30% for 15–25 minutes. Other platforms skip this, so disable their idle maintenance and sleep before a run. Every 20 s the five busiest non-Chrome processes go to `activity.log` (skipped where `ps` is unavailable). After three full rounds, any run with a case more than 3% (`RETRY_PERCENT`) off the median FPS of its rounds is rerun once; the original moves to `outliers/` and the rerun records the deviation in `retry`. Retried runs are excluded from the execution-order check. `activity.log` and `outliers/` are published with the raw results.

```sh
node harness/run.mjs willa radix-gpu viewer-gpu pc-gpu
ROUNDS=1 node harness/run.mjs elevator gsl-gpu
```

Backend IDs (shared with the lab): `spark-gl`, `radix-gpu`, `radix-gl`, `gsl-gpu`, `gsl-gl`, `viewer-gpu`, `pc-gpu`, `pc-gl`. `npm run bench:serve` separately serves the canvas at port 5349; open `/?mode=pc-gpu&model=hotel`.

## Files

| File | Role |
| --- | --- |
| `config.json` | Protocol: resolution, models/cameras, backends, sample durations, pinned versions |
| `run.mjs` | Playwright runner, one Chrome per run; writes `results-current/<model>-<backend>-r<round>.json` |
| `run-sort.mjs` | Optional Radix sort-latency supplement (vsync disabled) |
| `server.mjs` | Local server: harness files, `/lab/`, `/node_modules/` and configured models |
| `index.html`, `client.js` | Benchmark page; exposes `benchmark`, `sortBenchmark`, `captureView`, `snapshot` |
| `instrument.js` | Error capture, Worker RPC timing and explicit GPU allocation accounting |
| `three-adapter.js`, `playcanvas-adapter.js`, `shared-adapter.js` | Renderer adapters (the shared one reuses the lab's Radix/Viewer adapters) |
| `timer.js`, `heap.mjs`, `radix-worker.js` | WebGPU timestamps, CDP heap snapshots, instrumented Radix Worker |
| `build.mjs` | Builds `dist/` and checks installed versions against `config.json` and `lab/config.js` |

## Matched rendering presets

The harness adapters import `lab/config.js` directly, so presets and pinned package versions always match the lab.

| Setting | GSL | Spark | PlayCanvas |
| --- | --- | --- | --- |
| Attribute storage | 32-byte base / accumulator | Extended source + accumulator | `large`, 32-byte work buffer |
| Minimum radius / size | 1 | 2 | `minPixelSize: 2` |
| Maximum radius | No public setting | 512 | No public equivalent |
| Pre-blur / compensated blur | 0.3 / 0 | 0.3 / 0 | Native 0.3; `antiAlias: false` |
| Focal adjustment | 2 | 2 | Native projection |
| Forward alpha threshold | 1/255 | 1/255 | 1/255 |
| Frustum margin | `clipXY: 1.25` | `clipXY: 1.25` | No public equivalent |
| Sorting | Radial distance | Radial distance | Radial distance |

Spark's radius limits are focal-scaled; PlayCanvas's minimum projected size is matched on that basis. PlayCanvas extra contribution culling is disabled (`minContribution: 0`), with `colorUpdateAngle: 0`. Native support, projection, culling and sorting precision still differ: these presets do not guarantee identical images. The full source models contain no LOD hierarchy.

Every backend measures static and moving versions of both the main and second views. Each model's `secondView` in `config.json` either orbits and scales the main offset (a closer side view) or sets its own target and offset (the entrance side of WillaGlobalPoland). PlayCanvas WebGPU and both GSL backends additionally measure raw stochastic rendering in the same four views. PlayCanvas uses native blue noise (`stochastic: true`, `dither: 'bluenoise'`) without sorting or post-processing. Spatial resolve is not measured. GSL 1.6.2 keeps its default 16-bit front-to-back stochastic sorting (`stochasticSort: true`). Other native projection, alpha and radius-limit differences remain. These cases are separate from sorted rendering; temporal accumulation is off. PlayCanvas WebGL2 does not support this stochastic switch.

Radix and Viewer use the [Lab presets and compatibility rules](../lab/README.md). The harness drives Viewer updates and draws at the fixed physical resolution. Its loading timer includes Viewer initialization, model loading and initial rendering, ending at the `firstFrame` event. Radix CPU reports native JavaScript Worker sorting, message round trip, and complete asynchronous sorting including GPU key projection/readback. Its isolated diagnostic awaits one completed sort per sample; frame tests retain native asynchronous sorting.

## Measurement definitions

- **GPU timestamps:** collected only in the separate WebGPU sorting diagnostic. Frame-ranking samples do not issue elapsed or timestamp queries. Summing pass durations can double-count overlapping work on Apple GPUs.
- **CPU submission:** synchronous draw-call wall time, excluding asynchronous work. PlayCanvas includes `app.update` + `app.render`.
- **Frame intervals / FPS:** the harness and lab share a sampler (`lab/frame-timing.js`). Frames are drawn with one GPU frame in flight: a new frame is submitted only after the previous frame's GPU work has completed (WebGL2 fence / WebGPU onSubmittedWorkDone); camera motion and asynchronous sorting keep running meanwhile. Each sample is the interval between consecutive frame submissions, measured with performance.now(). FPS = frames / sampled time. Each run reports FPS = frames / sampled time and P50/P95 frame intervals; across runs, each statistic is the median of the per-run values. Normal browser refresh-rate limits apply; this is the rate of GPU-completed frames, not display-present FPS.
- **Validation boundaries:** WebGL fences or `GPUQueue.onSubmittedWorkDone()` drain work outside sampling. WebGL errors, WebGPU validation errors and device loss fail the measurement. Separate sorting diagnostics retain their completion boundaries.
- **Worker execution:** instrumented Worker handler duration for Spark/GSL; native `sortTime` for PlayCanvas's JavaScript Worker; the native `SortKeys.sort` call for Radix's JavaScript Worker. RPC round trip is recorded separately.
- **Async completion:** Spark/GSL native sort job start to delivery; PlayCanvas Worker request to response. Spark and Radix include GPU key readback. These have different preparation boundaries.
- **GPU radix:** separate diagnostic, 4 warm-up iterations and 16 samples. GSL separates projection/radix for this diagnostic only; main frame timing keeps its combined submission. PlayCanvas annotates existing compute dispatch boundaries, excluding projection and interval compaction. The report uses first-to-last radix span; raw `gpuSortMs` also retains the pass sum.
- **Motion/cache:** stationary tests continue drawing; native caches remain. Motion follows the same real-time sinusoidal orbit as the lab: ±45° amplitude (90° total sweep), 8-second period, continuous across warm-up and sampling. Asynchronous sorting stays active and timed draws do not await the latest sort. Preparation and captures await CPU sorting.
- **Visible/active counts:** GSL WebGPU projection survivors, Worker active sort records, or unavailable (`null`) for PlayCanvas. These are not equivalent visibility counts.
- **JS heap + ArrayBuffer + WASM:** sum the post-GC main and live Worker JS heaps, main and Worker CDP backing storage, and live Worker WASM capacity. ArrayBuffer includes external-string backing storage. This is an accounting sum, not process RSS or deduplicated physical memory. Raw components remain in `results/*.json`.
- **GPU allocation:** live buffer, texture and renderbuffer capacity, excluding measurement-query buffers. Driver overhead, alignment, swapchain and residency are unmeasured. Apple uses unified memory.
- **Report memory:** sum CPU components within each snapshot first, take the largest sum across sorted cases per run, then the median across three runs. Aggregate explicit GPU allocation separately. GSL uses default sorting only; stochastic targets are excluded.
- **Process RSS:** raw diagnostic only; includes browser/GPU processes and may double-count shared pages.

## Sorting and color

Radix retains its native default 24-bit keys, discarding the lowest seven float32 distance bits (16 fraction bits remain). WebGL2 uses JavaScript Worker radix digits of 11 and 13 bits; WebGPU uses three 8-bit radix digits.

Spark retains float32 keys and uses two 16-bit Worker/WASM radix digits. PlayCanvas and Viewer map float32 squared-distance bits to approximately log-spaced radial keys. WebGL2 uses 16-bit counting keys; WebGPU selects 16–20 bits from the active count and rounds to the radix width. The mapped range starts at `nearClip / 1024` and ends at the active scene bound. This Apple GPU uses portable 4-bit radix.

GSL 1.6.2 uses camera distance for radial sorting on both backends. Default sorting drops the lowest eight float32-key bits: one counting pass over 23 effective bits on WebGL2 (32 MiB count table), three 8-bit radix digits on WebGPU. Ordinary depth-sorted cases use this default path. Raw stochastic cases retain GSL 1.6.2’s default 16-bit front-to-back ordering (two 8-bit GPU radix passes on WebGPU).

Aholo Viewer 1.12.0 sorts by view depth only (no radial option). It uses its high-precision options: 32-bit float keys (default: 16-bit half floats in one 65,536-bucket counting pass) sorted as two 16-bit radix digits in a Worker after a fenced GPU readback, and an fp32 GPU pack. Its Compressed source keeps float32 positions, half-float scale, color and opacity, 32-bit octahedral rotation and 11/10/11-bit SH clamped to ±1. It re-sorts after a 0.1 mm or ~0.16° camera change (defaults: 1 m and ~16°); tighter thresholds trip on float32 rounding of an unchanged pose. It never flushes GL itself, so the sort diagnostic flushes while waiting instead of drawing extra frames.

GSL native WebGPU uses an sRGB working space; WebGL uses Linear-sRGB internally and blends/outputs in sRGB, matching the lab. Radix uses an sRGB working space on both backends, so it also blends in sRGB. PlayCanvas uses linear tone mapping and native sRGB output. Native SH decoding and source encodings remain unchanged.

## Outputs

`results-current/*.json` contains per-frame/per-pass measurements, effective settings, versions, camera, memory and errors. Round-one captures enter the gallery. Test dates use Australia/Sydney. Measurements use the renderers' native shaders and sorting algorithms.

From the repository root:

```sh
npm run report          # validate → analyze → plot into outputs/
npm run report:publish  # same, then publish to report/ and harness/results/
```

Only matching-protocol data is accepted; full validation expects 81 successful runs across three models, nine backends and three rounds (432 frame-performance groups and 81 sorting groups). Publishing copies the raw runs and round-one captures to `harness/results/`, the report artifacts to `report/`, and regenerates `report/input-manifest.json` (hardware, model hashes, protocol, dates).

To refresh only Radix sorting after completed frame runs, run `npm run bench:sort`. It measures both Radix backends across three models and three interleaved rounds, with four warm-up iterations and 16 samples per run. Only the raw `sort` section is replaced; each supplement records its own timestamp, browser and execution order. Frame, memory and capture data remain from the original runs. Regenerate and publish the report afterward.
