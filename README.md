# 3DGS Renderer Bench

Measured comparisons of [Radix](https://github.com/sparkjsdev/radix), [Spark](https://github.com/sparkjsdev/spark), [PlayCanvas Engine](https://github.com/playcanvas/engine), [SuperSplat Viewer](https://github.com/playcanvas/supersplat-viewer), and [Gaussian Splat Lite](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite).

[Benchmark website](https://3dgs-renderer-bench.vercel.app) · [Interactive local report](report/3DGS-Renderer-Bench.html) · [Browser lab](https://3dgs-renderer-bench.vercel.app/test/)

## Current test configuration

The preserved PLY cohort uses GSL 1.6.2; the SOG supplement uses GSL 1.7.0. Both use Spark 2.4.0, Radix 0.0.1, Aholo Viewer 1.12.0, SuperSplat Viewer 1.42.0 and [PlayCanvas 2.24.0-beta.30](https://github.com/playcanvas/engine/commit/876ba2e7dffc246b1008695f23f60ac1a9b96109). Radix runs on WebGPU and WebGL2 with its native default 24-bit sorting, using Three.js 0.186.1; GSL and Spark use 0.187.0. Tests alternate forward/reverse order, then rotate the starting backend. The three local inputs are Elevator, HotelFareza and WillaGlobalPoland.

- Nine PLY backends: Spark WebGL2; Radix WebGL2/WebGPU; GSL WebGL2/WebGPU; SuperSplat Viewer WebGPU; PlayCanvas Engine WebGL2/WebGPU; Aholo Viewer WebGL2.
- Full original PLY inputs and matched SOG v2 conversions with SH3 and no generated LOD hierarchy: Elevator (2,796,503), HotelFareza (12,202,010), WillaGlobalPoland (14,469,103 splats).
- Shared cameras, radial sorting (Aholo Viewer: view depth only), resolution, background and aligned size/blur/alpha settings. Native projection, culling, precision and caching still differ; exact settings are recorded per run.
- MacBook Pro 14, Apple M5 Pro (16 GPU cores), 48 GiB unified memory, macOS 26.7, Chrome 156. Canvas: 1512 × 982 CSS pixels, DPR 2, **3024 × 1964 physical pixels**.
- Three independent runs per model/backend: **141 successful runs and 780 performance groups** (81 preserved PLY runs + 60 SOG supplement runs). The three scheduled WillaGlobalPoland / Spark SOG rounds are excluded after native loading failed. Each round runs every backend once per model, then reverses the order for the next round and rotates the starting backend for the following pair. Real start timestamps are checked against this schedule.
- All compatible backends measure static (5 s) and moving (8 s, ±45° orbit) versions of both the main and second views (a closer side view; the entrance side for WillaGlobalPoland) after a 2 s warm-up. Additional raw stochastic cases compare PlayCanvas WebGPU and both GSL backends; GSL retains default 16-bit front-to-back stochastic sorting. Spatial resolve and temporal accumulation are off. Sorted and stochastic results have separate winners.
- Test dates are derived from raw run timestamps (Australia/Sydney) and recorded in `report/input-manifest.json`.

## SOG codebook supplement

All three models are converted with `@playcanvas/splat-transform@3.6.4`, GPU 0, 10 SH clustering iterations, retaining the full splat counts, SH3 and 65,536-entry SH codebooks. The report's input-format selector keeps PLY and SOG rankings separate; the overview includes both. Conversion metadata and source/output hashes are in `report/input-manifest.json`.

Seven backends participate in SOG testing: Spark, GSL WebGL2/WebGPU, SuperSplat Viewer, PlayCanvas WebGL2/WebGPU and Aholo Viewer. Radix 0.0.1 rejects SOG on both backends and is excluded. Spark 2.4.0 fails to load WillaGlobalPoland SOG with WASM `unreachable`, so that model is compared across six SOG backends. GSL, PlayCanvas and Viewer retain shared SH source codebooks; Spark and Aholo expand SH per splat. Renderer work buffers remain part of the measured allocation. The report records the actual source storage and GSL palette/label bytes.

PLY results retain their original GSL 1.6.2 version and dates; SOG uses GSL 1.7.0. Quantization, versions and measurement dates differ, so cross-format differences are not an isolated codebook speedup or quality measurement.

## How frames are measured

The report and lab share one sampler (`lab/frame-timing.js`). Frames are drawn with one GPU frame in flight: a new frame is submitted only after the previous frame's GPU work has completed (WebGL2 fence / WebGPU onSubmittedWorkDone); camera motion and asynchronous sorting keep running meanwhile. Each sample is the interval between consecutive frame submissions, measured with performance.now(). FPS = frames / sampled time. Normal browser refresh-rate limits apply.

| Metric | Meaning |
| --- | --- |
| FPS | Frames / sampled time: rendering-loop throughput |
| Frame P50 / P95 | 50th / 95th percentile of the same frame intervals |

Across runs, each statistic is the median of the per-run values.

Sorting latency, combined JS heap + ArrayBuffer + WASM and explicit GPU allocation are defined in [the measurement guide](harness/README.md). Adjusting rendering settings does not remove instrumentation overhead or guarantee pixel-identical images.

## Repository layout

| Path | Contents |
| --- | --- |
| `report/` | Published report: `3DGS-Renderer-Bench.html`, summary JSON/CSV, overview PNG/SVG, validation and input manifest |
| `harness/` | Instrumented Playwright benchmark; `harness/results/` holds the raw runs and captures behind `report/` |
| `lab/` | Browser lab served at `/test/`; `lab/config.js` and `lab/frame-timing.js` are shared with the harness |
| `tools/` | Report pipeline (validate → analyze → plot → publish) and site/lab builds |
| `models/`, `vendor/`, `licenses/` | Local model inputs (not committed), pinned package snapshots, third-party licenses |

## View the results

Open `report/3DGS-Renderer-Bench.html`. It includes English/Chinese controls, per-round comparisons and embedded screenshot previews; original captures link to `harness/results/`. No model files are required to read the report.

`report/benchmark-data.json` and `report/benchmark-summary.csv` contain summary measurements; `report/validation.json` records the completed checks. `harness/results/` contains the 141 successful raw run JSON files and excluded loading records and round-one captures.

## Test your own model

Open the [browser lab](https://3dgs-renderer-bench.vercel.app/test/) to compare Spark, Radix, SuperSplat Viewer, PlayCanvas, GSL and Aholo Viewer across nine backends on a PLY, SPZ or SOG. Drop a local file or enter a direct HTTP(S) `.ply`/`.spz`/`.sog` URL with CORS enabled. Files stay in the browser; SPZ is converted to a shared PLY before testing. SOG is loaded directly; incompatible backends are disabled. Downloads happen once, before renderer loading, and are timed separately.

Choose versions, camera, resolution and sampling settings; run sequentially and export JSON/PDF with screenshots. Results show FPS and P50/P95 frame intervals for both static and orbit runs. Match the model, camera, physical resolution and browser settings when comparing results.

With Node.js 22 or 24:

```sh
npm ci
npm run dev
# Open the printed URL (default: http://127.0.0.1:5349/test/).
```

Restart after source changes. WebGPU requires HTTPS or localhost and a supported browser/GPU. See the [lab guide](lab/README.md).

## Reproduce the measurements

Requires Python 3, Node.js 22 or 24, and local Google Chrome with native WebGPU and timestamp queries. Process-memory diagnostics use Unix `ps`.

1. Place `Elevator.ply`, `HotelFareza.ply` and `WillaGlobalPoland.ply` in `models/`, or edit `harness/config.json` paths. Verify the hashes in `report/input-manifest.json`.
2. From the repository root:

```sh
npm ci
npm run bench:build
npm run models:sog
npm run bench:pilot -- --format=sog
npm run bench -- --fresh
```

By default, completed results with the same configuration and SOG input hash are skipped. `--fresh` runs the entire PLY + SOG matrix again. New data goes to `harness/results-current` (`RESULTS_DIR` overrides it). A native SOG loading failure excludes that model/backend pair from ranking and is retained in the report with its error. The runner manages its own server on port 5351, configurable through `PORT`.

Backend IDs are `spark-gl`, `radix-gpu`, `radix-gl`, `gsl-gpu`, `gsl-gl`, `viewer-gpu`, `pc-gpu`, `pc-gl`, `aholo-gl`. For example, `node harness/run.mjs hotel pc-gl pc-gpu`; `ROUNDS=1` selects a diagnostic round. Full validation expects three rounds across all three models, nine PLY backends and seven SOG backends.

For an SOG-only supplement that imports the published baseline and never runs PLY:

```sh
npm run models:sog
npm run bench:build
npm run bench:sog
```

`--supplement` copies missing published raw files into the result directory without replacing existing files. Outlier retries only consider runs newly measured by the current invocation. `node harness/run.mjs --format=sog --dry-run` previews the schedule. `harness/baseline-ply-v5.json` records the original PLY configuration so report validation can accept that preserved cohort without rewriting it. For a future complete comparison, use a fresh directory, for example `RESULTS_DIR=results-full npm run bench -- --fresh`, then `RESULTS_DIR=results-full npm run report:publish`. Relative result directories are resolved from `harness/` by both the runner and report tools; absolute paths also work.

## Regenerate the report

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
npm run report          # validate → analyze → plot into outputs/
npm run report:publish  # also publish to report/ and harness/results/
```

`report:publish` refuses incomplete or stale data. It copies the raw runs and round-one captures to `harness/results/`, the report artifacts to `report/`, and regenerates `report/input-manifest.json` with model hashes, hardware, protocol and test dates.

## Build the website

```sh
npm run build
```

Builds the report, its original captures, and `/test/` into `site/`. Models and the instrumented harness are not deployed. `vercel.json` configures the build with no required environment variables.

## Development

`npm run format` applies Prettier (JavaScript/HTML/CSS) and Ruff (Python); `npm run lint` checks both.

## License

Benchmark code is MIT licensed. Renderer code retains its licenses in `licenses/`. The pinned Engine snapshot and its license are in `vendor/`; Viewer and Radix retain their package licenses.
