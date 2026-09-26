# 3DGS Renderer Bench

A local benchmark using original PLY models, matching cameras and the MacBook Pro 14 display dimensions: 1512 × 982 CSS pixels, DPR 2, 3024 × 1964 physical pixels.

- Spark 2.2.0 / WebGL2: ExtSplats source and extended accumulator.
- SuperSplat Editor 3.4.2 / WebGPU: pinned original projector, resources, radix sorter and shaders.
- Gaussian Splat Lite 1.1.5 / WebGL2 and native WebGPU: default and full-precision sorting.
- Elevator: 2,796,503 splats. HotelFareza: 12,202,010 splats, retaining the original published camera with the complete building visible.
- The report opens in English with HotelFareza, Moving main view and Frame completion selected. The global language control at the top also offers Chinese.

## Run

Requires Node.js 20+ and local Google Chrome. Set the local PLY paths in `config.json`; models are served only on localhost and are never uploaded.

```sh
cd harness
npm ci
npm run build
npm run pilot
npm run bench
```

The benchmark defaults to three independent browser processes per backend/model, rotating or reversing backend order. This report uses three independent runs per backend/model; Spark was remeasured in a separate batch with non-radial sorting. Raw timestamps retain the actual collection order. Successful existing results are skipped; rename `results` to repeat measurements. Set `ROUNDS=1` for one run. To select a model or backend:

```sh
node run.mjs elevator gsl-gpu
node run.mjs hotel spark supersplat
```

`npm start` serves the measurement canvas at 127.0.0.1:5349. For example, open `/?mode=gsl-gpu&model=hotel`. The interactive report is the separate HTML file at the kit root.

## Measurement definitions

- GPU frame time: WebGL2 elapsed query, or the earliest GPU pass start through the latest pass end on WebGPU. Individual pass durations are retained, but summing them can double-count overlapping work on Apple GPUs.
- CPU submission: synchronous wall time of the draw call, excluding asynchronous work.
- Frame completion: submission, GPU completion and query readback with one frame in flight. This is not display FPS.
- Worker execution: time inside the Worker handler. RPC round-trip time is measured separately.
- Async completion: native sorting job start through result delivery. Spark includes GPU depth readback; Gaussian Splat Lite WebGL2 uses CPU center data and Worker sorting. Previous orderings may remain in use while a new result is pending.
- GPU radix: a separate diagnostic measures its first-to-last pass span. Gaussian Splat Lite projection and radix are separated only for this diagnostic; main frame measurements retain the original combined submission. Raw `gpuSortMs` is a sum of pass times, while the report uses the span.
- Static cases still draw continuously and retain native projection caches. Moving cases advance along matching camera sequences per frame, not per second.
- `visible` means projection survivors on WebGPU and active sort records on Worker backends; these counts are not equivalent.
- JS heap: post-GC `Runtime.getHeapUsage.usedSize` for the page's main-thread V8 isolate. Worker JS heaps are not included. `backingStorageSize` reports main-thread ArrayBuffer and external-string storage. Live Worker WASM linear-memory capacity is instrumented separately. These quantities are not a complete CPU memory total and must not be blindly added.
- GPU allocation: live buffer, texture and renderbuffer capacity, excluding measurement-query buffers. Driver overhead, alignment, swapchain and physical residency are not measured. Apple uses unified memory.
- Report memory values: the largest post-GC snapshot across each run's sorted cases, followed by the median across three runs. Gaussian Splat Lite retains caches from both sorting modes, so this is not an isolated per-mode memory comparison.
- Browser process-tree RSS remains raw diagnostics only. It includes browser and GPU-process memory and may double-count shared pages; the report does not use it as library memory.
- Stochastic raw sampling and spatial resolve are measured separately. Temporal accumulation is off. SuperSplat retains its native 12 ms stochastic motion budget and cross-frame occlusion culling. Its original depth-reduction pass is scheduled after splat rasterization; native reportStochasticFrame receives the benchmark GPU span. Stochastic groups warm for at least six seconds so adaptive contribution reduction can settle. Warp is off for the explicitly selected raw/spatial test modes. Spark has no native stochastic path in the pinned version.

## Native rendering defaults

The adapters leave projection, filtering and size culling at each pinned library's defaults. All renderers use camera-axis depth (`sortRadial: false`):

| Renderer | Size filter | Filtering | Projection | Sorting |
| --- | --- | --- | --- | --- |
| Spark | minPixelRadius 0; maxPixelRadius 512 | preBlurAmount 0; blurAmount 0.3 | focalAdjustment 1; clipXY 1.4 | Camera-axis depth |
| SuperSplat | minPixelSize 2 | Native covariance diagonal +0.3 | Native projector | Camera-axis depth |
| Gaussian Splat Lite | minPixelRadius 1; maxPixelRadius 256 | preBlurAmount 0.3; blurAmount 0 | focalAdjustment 2; clipXY 1.25 | Camera-axis depth |

These size thresholds are not equivalent formulas. Native defaults can differ in visible count and image appearance. Spark keeps the requested extended source and accumulator. Its renderer LOD switch remains at the default true, but the input has no LOD hierarchy. SuperSplat retains motionBudgetMs 12 and occlusionCull true. Gaussian Splat Lite uses the viewer's reversed-depth renderer configuration; WebGL does not preserve the drawing buffer. Its default and full-precision sorting modes are both tested.

Shared benchmark controls still fix the full models, camera, resolution and rendering mode. The raw PLY files contain no generated LOD hierarchy. Spark keeps its default LOD setting, with no LOD data to select. SuperSplat stochastic modes retain native adaptive contribution reduction and occlusion culling; these can change quality and survivor counts. Temporal accumulation, editor overlays and on-demand drawing are excluded. The stochastic groups explicitly select raw sampling or spatial-only resolve; this is not a benchmark of each application's automatic mode switching. Raw `state.renderParameters`, `state.sortRadial` and camera snapshots record the actual values.

To reproduce this local retest exactly, run the following sequentially after moving existing results aside:

```sh
node run.mjs
```

Three runs per backend/model rotate or reverse backend order; the two Gaussian Splat Lite sorting modes reverse on even rounds. Both camera presets match the original published report. Gaussian Splat Lite WebGPU lets Three initialize its default supported device features, matching the viewer. Opposite-façade and parameter-diagnostic runs are not included in these results.

## Color configuration

Gaussian Splat Lite native WebGPU uses `THREE.SRGBColorSpace` as its working space, matching the local viewer. WebGL keeps `THREE.LinearSRGBColorSpace` internally and blends/outputs in sRGB. Both display sRGB. The native WebGPU measurements were rerun after aligning this setting. Spatial resolve uses `StochasticResolvePass` with temporal accumulation disabled; `StochasticTAAPass` is not instantiated. The former Linear-sRGB WebGPU configuration changed blending and filtering brightness and is excluded from the report.

## Source and processing precision

Gaussian Splat Lite 1.1.5 uses 32-byte base records: float32 positions; float16 RGB, alpha and log-scale; a 10/10-bit octahedral rotation axis plus a 12-bit angle. SH3 remains enabled; each RGB coefficient uses 32 bits (8-bit channel magnitudes, 3 sign bits and a shared 5-bit exponent). WebGL2 uses highp shader arithmetic and a 32-byte accumulator with the same attribute layout.

Native WebGPU computes projection in float32 and stores 32-byte projected records: screen centers use 16-bit signed normalized values; axes, axis ratio and RGB use float16; view depth, alpha, support radius and kernel power use float32. Full-precision sorting retains the complete 32-bit depth key; it does not change source encoding or projection-cache precision.

Both backends use an RGBA16F color input for spatial resolve; normal and raw stochastic rendering draw to the canvas. The package source maps (`data/splatCodec.ts`, `rendering/webgl/shaders/splatDefines.glsl`, `rendering/tsl/GenerateProgram.ts`, `rendering/webgpu/ProjectionCache.ts` and `resolve/StochasticResolvePass.ts`) define these formats. The run allocation snapshots confirm the RGBA16F resolve target.

## Sorting precision

All renderers use camera-axis depth (non-radial sorting). Spark sets `sortRadial: false` and keeps the full float32 depth key and sorts in Worker/WASM using two 16-bit radix digits. SuperSplat quantizes the near-to-far range linearly to 20 bits and uses five 4-bit GPU radix digits on this Apple GPU.

Gaussian Splat Lite default sorting removes the lowest eight bits of the float32 key. WebGL2 uses a single 24-bit counting pass; WebGPU uses six 4-bit radix digits. Full precision keeps all 32 bits, using two 16-bit Worker radix digits or eight 4-bit GPU radix digits. This switch does not change source geometry, SH data or splat count. These digit counts do not equal the number of GPU compute passes.

Depth-key quantization is separate from source encoding and asynchronous result age. Full float32 keys still contain floating-point rounding and order Gaussian centers rather than individual pixels.

## Source and reproduction

`../vendor/supersplat` contains commit `f76e67633f21b298846c29eceab48ae20579fb4e`. The build narrows an IO barrel import to the original read-only loader, avoiding editor write UI dependencies. Rendering and sorting algorithms are unchanged.

Spark and Gaussian Splat Lite use locked npm releases. Build-time instrumentation adds Worker timing and WASM capacity measurements without replacing their algorithms. The instrumented `dist` bundles are benchmark artifacts, not library releases.

Native SH decoding, colors and projection rules are retained. Source model files, dependency installations and browser profiles are not included. Formal per-frame results are in `results/*.json`; round-one screenshots are 3024 × 1964. Pilot measurements do not enter the report. Both models were remeasured using native renderer defaults. Elevator retains its camera; HotelFareza retains the original published façade and shows the complete building. Exact camera presets are in `config.json`.
