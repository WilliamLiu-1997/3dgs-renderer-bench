# 3DGS Renderer Bench

Instrumented benchmark of original PLY models, with rendering settings adjusted as closely as possible.

- Spark 2.2.0 / WebGL2: ExtSplats source and extended accumulator.
- PlayCanvas Engine **2.23.0-beta.20** / WebGL2 and native WebGPU: `dataFormat: 'large'`, CPU Worker and GPU sorting respectively.
- SuperSplat 3.4.2 / WebGPU, using PlayCanvas beta.20 and the vendored SuperSplat rendering pipeline.
- Gaussian Splat Lite 1.1.5 / WebGL2 and native WebGPU, with Three.js 0.186.1.
- Elevator: 2,796,503 splats. HotelFareza: 12,202,010 splats. Original published camera presets and complete PLY inputs with SH3.
- 1512 × 982 CSS pixels, DPR 2, **3024 × 1964 physical pixels**. No MSAA. FOV 45°, near 0.1, far 3000, background #101418.

## Run

Requires Node.js 22 or 24 and local Google Chrome. Put the PLY files in `../models/`, or set their local paths in `config.json`. Models are served only on localhost and are never uploaded.

```sh
cd harness
npm ci
npm run build
npm run pilot
# Move existing results aside before a fresh measurement:
mv results results-original
npm run bench
```

The runner uses port 5351 (`PORT` overrides it), starts/stops its own server, and launches a fresh Chrome process per model/backend/round. Three rounds rotate or reverse backend order. GSL always uses default sorting (`fastSort: true`). Completed results with the current protocol are skipped. Pilot data never enters the report.

```sh
node run.mjs hotel pc-gl pc-gpu
ROUNDS=1 node run.mjs elevator gsl-gpu
```

Backend IDs: `spark`, `pc-gl`, `pc-gpu`, `supersplat`, `gsl-gl`, `gsl-gpu`. `npm start` separately serves the canvas at port 5349; use `/?mode=pc-gpu&model=hotel`.

## Matched rendering presets

The build copies the lab config unchanged into `dist/lab-config.js`; the harness adapters read those presets. The pinned package versions match the lab.

| Setting | GSL | Spark | PlayCanvas |
| --- | --- | --- | --- |
| Attribute storage | 32-byte base / accumulator | Extended source + accumulator | `large`, 32-byte work buffer |
| Minimum radius / size | 1 | 2 | `minPixelSize: 2` |
| Maximum radius | 256 | 512 | No public equivalent |
| Pre-blur / compensated blur | 0.3 / 0 | 0.3 / 0 | Native 0.3; `antiAlias: false` |
| Focal adjustment | 2 | 2 | Native projection |
| Forward alpha threshold | 1/255 | 1/255 | 1/255 |
| Frustum margin | `clipXY: 1.25` | `clipXY: 1.25` | No public equivalent |
| Sorting | Camera-axis depth | Camera-axis depth | Camera-axis depth |

Spark's radius limits are focal-scaled; PlayCanvas's minimum projected size is matched on that basis. PlayCanvas extra contribution culling is disabled (`minContribution: 0`), with `colorUpdateAngle: 0`. Native support, projection, culling and sorting precision still differ: these presets do not guarantee identical images. The full source models contain no LOD hierarchy.

Every backend measures static main view, closer side view and moving main view. PlayCanvas WebGPU, SuperSplat and both GSL backends additionally measure raw stochastic rendering in static and moving views. PlayCanvas uses native blue noise (`stochastic: true`, `dither: 'bluenoise'`) without sorting or post-processing. SuperSplat and GSL additionally measure native spatial resolve. SuperSplat uses minPixelSize 2 with native pre-blur 0.3; native stochastic depth occlusion is enabled by default; motion-adaptive contribution culling, warp and temporal accumulation remain disabled. Other native projection, alpha and radius-limit differences remain. These cases are separate from sorted rendering; temporal accumulation is off. PlayCanvas WebGL2 does not support this stochastic switch.

## Measurement definitions

- **GPU frame time:** WebGL2 elapsed query; WebGPU earliest pass start to latest pass end. Summing pass durations can double-count overlapping work on Apple GPUs.
- **CPU submission:** synchronous draw-call wall time, excluding asynchronous work. PlayCanvas includes `app.update` + `app.render`.
- **Frame Completion P50/P95:** per-run median and 95th percentile, then the median of each percentile across three runs. Timing includes submission, GPU completion and query readback with one frame in flight. This is neither isolated GPU execution nor display FPS. The lab also measures completion, but has no timestamp-query readback instrumentation, so absolute values need not match the lab.
- **Worker execution:** instrumented Worker handler duration for Spark/GSL; native `sortTime` for PlayCanvas's JavaScript Worker. RPC round trip is recorded separately.
- **Async completion:** Spark/GSL native sort job start to delivery; PlayCanvas Worker request to response. Spark includes GPU depth readback. These have different preparation boundaries.
- **GPU radix:** separate diagnostic, 4 warm-up iterations and 16 samples. GSL separates projection/radix for this diagnostic only; main frame timing keeps its combined submission. PlayCanvas annotates existing compute dispatch boundaries, excluding projection and interval compaction. The report uses first-to-last radix span; raw `gpuSortMs` also retains the pass sum.
- **Motion/cache:** stationary tests continue drawing; native caches remain. Motion follows the same per-frame sinusoidal camera sequence with ±45° amplitude (90° total sweep), matching the lab amplitude. Asynchronous sorting stays active and timed draws do not await the latest sort. Preparation and captures await CPU sorting.
- **Visible/active counts:** GSL WebGPU projection survivors, Worker active sort records, or unavailable (`null`) for PlayCanvas WebGPU. These are not equivalent visibility counts.
- **JS heap + ArrayBuffer + WASM:** sum the post-GC main and live Worker JS heaps, main and Worker CDP backing storage, and live Worker WASM capacity. ArrayBuffer includes external-string backing storage. This is an accounting sum, not process RSS or deduplicated physical memory. Raw components remain in `results/*.json`.
- **GPU allocation:** live buffer, texture and renderbuffer capacity, excluding measurement-query buffers. Driver overhead, alignment, swapchain and residency are unmeasured. Apple uses unified memory.
- **Report memory:** sum CPU components within each snapshot first, take the largest sum across sorted cases per run, then the median across three runs. Aggregate explicit GPU allocation separately. GSL uses default sorting only; stochastic targets are excluded.
- **Process RSS:** raw diagnostic only; includes browser/GPU processes and may double-count shared pages.

## Sorting and color

Spark retains float32 depth keys and uses two 16-bit Worker/WASM radix digits. PlayCanvas CPU uses native weighted counting-sort bins (19 bits for Elevator, 20 for HotelFareza); GPU rounds its adaptive bit count to radix width (20 bits / five 4-bit digits on this device). Its depth range comes from active scene bounds, not directly from camera near/far.

GSL default sorting drops the lowest eight float32-key bits: one 24-bit counting pass on WebGL2, six 4-bit radix digits on WebGPU. The report measures this default sorting path only.

GSL native WebGPU uses an sRGB working space; WebGL uses Linear-sRGB internally and blends/outputs in sRGB, matching the lab. PlayCanvas uses linear tone mapping and native sRGB output. Native SH decoding and source encodings remain unchanged.

## Outputs

`results/*.json` contains per-frame/per-pass measurements, effective settings, versions, camera, memory and errors. Round-one captures enter the gallery. Build instrumentation measures timing and allocations without replacing rendering or sorting algorithms. `vendor/supersplat` is built through `supersplat.ts`; it measures the native rendering path without the application UI. The build narrows one resource import to the read-only loader and resolves all PlayCanvas imports to beta.20, without changing renderer algorithms.

From the repository root:

```sh
.venv/bin/python tools/analyze.py
.venv/bin/python tools/plot.py
.venv/bin/python tools/validate.py
```

Generated reports go to `outputs/`. Only matching-protocol data is accepted; validation expects 36 successful runs, 192 performance groups and 36 sorting groups.
