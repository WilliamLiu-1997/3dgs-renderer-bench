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

Requires Node.js 22 or 24 and local Google Chrome. Put the PLY files in `../models/`, or set their local paths in `config.json`. Models are served only on localhost and are never uploaded.

```sh
cd harness
npm ci
npm run build
npm run pilot
npm run bench
```

The runner uses port 5351 (`PORT` overrides it), starts/stops its own server, and launches a fresh Chrome process per model/backend/round. Paired rounds run forward/reverse order; the next pair rotates the starting backend. Each result records its execution order. GSL always uses default sorting (`fastSort: true`); Radix uses its default `sortBits: 24`. Completed results with the current protocol are skipped. Pilot data goes to `pilot/`; new formal results go to `results-current/`. `RESULTS_DIR` overrides either destination. The published `results/` contains the raw data behind the current main report.

```sh
node run.mjs willa radix-gpu viewer-gpu pc-gpu
ROUNDS=1 node run.mjs elevator gsl-gpu
```

Backend IDs: `spark`, `radix-gpu`, `radix-gl`, `gsl-gpu`, `gsl-gl`, `viewer-gpu`, `pc-gpu`, `pc-gl`. `npm start` separately serves the canvas at port 5349; use `/?mode=pc-gpu&model=hotel`.

## Matched rendering presets

The build copies the lab config unchanged into `dist/lab-config.js`; the harness adapters read those presets. The pinned package versions match the lab.

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

Every backend measures static and moving versions of both the main and closer side views. PlayCanvas WebGPU and both GSL backends additionally measure raw stochastic rendering in the same four views. PlayCanvas uses native blue noise (`stochastic: true`, `dither: 'bluenoise'`) without sorting or post-processing. Spatial resolve is not measured. GSL 1.6.2 keeps its default 16-bit front-to-back stochastic sorting (`stochasticSort: true`). Other native projection, alpha and radius-limit differences remain. These cases are separate from sorted rendering; temporal accumulation is off. PlayCanvas WebGL2 does not support this stochastic switch.

Radix and Viewer use the [Lab presets and compatibility rules](../lab/README.md). Viewer retains its update loop but suppresses automatic draws. Its loading timer includes Viewer initialization, model loading and initial rendering, ending at the `firstFrame` event. Radix CPU reports native JavaScript Worker sorting, message round trip, and complete asynchronous sorting including GPU key projection/readback. Its isolated diagnostic awaits one completed sort per sample; frame tests retain native asynchronous sorting.

## Measurement definitions

- **GPU frame time:** WebGL2 elapsed query; WebGPU earliest pass start to latest pass end. Summing pass durations can double-count overlapping work on Apple GPUs.
- **CPU submission:** synchronous draw-call wall time, excluding asynchronous work. PlayCanvas includes `app.update` + `app.render`.
- **Frame Completion P50/P95:** per-run median and 95th percentile, then the median of each percentile across three runs. Timing includes submission, GPU completion and query readback with one frame in flight. This is neither isolated GPU execution nor display FPS. The lab also measures completion, but has no timestamp-query readback instrumentation, so absolute values need not match the lab.
- **Worker execution:** instrumented Worker handler duration for Spark/GSL; native `sortTime` for PlayCanvas's JavaScript Worker; the native `SortKeys.sort` call for Radix's JavaScript Worker. RPC round trip is recorded separately.
- **Async completion:** Spark/GSL native sort job start to delivery; PlayCanvas Worker request to response. Spark and Radix include GPU key readback. These have different preparation boundaries.
- **GPU radix:** separate diagnostic, 4 warm-up iterations and 16 samples. GSL separates projection/radix for this diagnostic only; main frame timing keeps its combined submission. PlayCanvas annotates existing compute dispatch boundaries, excluding projection and interval compaction. The report uses first-to-last radix span; raw `gpuSortMs` also retains the pass sum.
- **Motion/cache:** stationary tests continue drawing; native caches remain. Motion follows the same per-frame sinusoidal camera sequence with ±45° amplitude (90° total sweep), matching the lab amplitude. Asynchronous sorting stays active and timed draws do not await the latest sort. Preparation and captures await CPU sorting.
- **Visible/active counts:** GSL WebGPU projection survivors, Worker active sort records, or unavailable (`null`) for PlayCanvas WebGPU. These are not equivalent visibility counts.
- **JS heap + ArrayBuffer + WASM:** sum the post-GC main and live Worker JS heaps, main and Worker CDP backing storage, and live Worker WASM capacity. ArrayBuffer includes external-string backing storage. This is an accounting sum, not process RSS or deduplicated physical memory. Raw components remain in `results/*.json`.
- **GPU allocation:** live buffer, texture and renderbuffer capacity, excluding measurement-query buffers. Driver overhead, alignment, swapchain and residency are unmeasured. Apple uses unified memory.
- **Report memory:** sum CPU components within each snapshot first, take the largest sum across sorted cases per run, then the median across three runs. Aggregate explicit GPU allocation separately. GSL uses default sorting only; stochastic targets are excluded.
- **Process RSS:** raw diagnostic only; includes browser/GPU processes and may double-count shared pages.

## Sorting and color

Radix retains its native default 24-bit keys, discarding the lowest seven float32 distance bits (16 fraction bits remain). WebGL2 uses JavaScript Worker radix digits of 11 and 13 bits; WebGPU uses three 8-bit radix digits.

Spark retains float32 keys and uses two 16-bit Worker/WASM radix digits. PlayCanvas and Viewer map float32 squared-distance bits to approximately log-spaced radial keys. WebGL2 uses 16-bit counting keys; WebGPU selects 16–20 bits from the active count and rounds to the radix width. The mapped range starts at `nearClip / 1024` and ends at the active scene bound. This Apple GPU uses portable 4-bit radix.

GSL 1.6.2 uses camera distance for radial sorting on both backends. Default sorting drops the lowest eight float32-key bits: one counting pass over 23 effective bits on WebGL2 (32 MiB count table), three 8-bit radix digits on WebGPU. Ordinary depth-sorted cases use this default path. Raw stochastic cases retain GSL 1.6.2’s default 16-bit front-to-back ordering (two 8-bit GPU radix passes on WebGPU).

GSL native WebGPU uses an sRGB working space; WebGL uses Linear-sRGB internally and blends/outputs in sRGB, matching the lab. PlayCanvas uses linear tone mapping and native sRGB output. Native SH decoding and source encodings remain unchanged.

## Outputs

`results-current/*.json` contains per-frame/per-pass measurements, effective settings, versions, camera, memory and errors. Round-one captures enter the gallery. Test dates use Australia/Sydney. Measurements use the renderers' native shaders and sorting algorithms.

From the repository root:

```sh
.venv/bin/python tools/analyze.py
.venv/bin/python tools/plot.py
.venv/bin/python tools/validate.py
```

Generated reports go to `outputs/`. Only matching-protocol data is accepted; full validation expects 72 successful runs across three models, eight backends and three rounds (396 frame-performance groups and 72 sorting groups).

To refresh only Radix sorting after completed frame runs, run `node run-sort.mjs` from `harness/`. It measures both Radix backends across three models and three interleaved rounds, with four warm-up iterations and 16 samples per run. Only the raw `sort` section is replaced; each supplement records its own timestamp, browser and execution order. Frame, memory and capture data remain from the original runs. Regenerate and publish the report snapshot afterward.
