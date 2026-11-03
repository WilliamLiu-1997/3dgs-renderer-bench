export const PACKAGES = {
  spark: { name: '@sparkjsdev/spark', version: '2.4.0' },
  radix: { name: '@sparkjsdev/radix', version: '0.0.1' },
  viewer: { name: '@playcanvas/supersplat-viewer', version: '1.42.0', entry: 'dist/viewer.js' },
  playcanvas: { name: 'playcanvas', version: '2.24.0-beta.30', commit: '876ba2e7dffc246b1008695f23f60ac1a9b96109' },
  gsl: { name: 'gaussian-splat-lite', version: '1.6.2' },
  threeRadix: { name: 'three', installName: 'three-radix', version: '0.186.1' },
  three: { name: 'three', version: '0.187.0' },
};
export const BACKENDS = [
  { id: 'spark-gl', lib: 'spark', name: 'Spark', backend: 'WebGL2' },
  { id: 'radix-gpu', lib: 'radix', name: 'Radix', backend: 'WebGPU' },
  { id: 'radix-gl', lib: 'radix', name: 'Radix', backend: 'WebGL2' },
  { id: 'gsl-gpu', lib: 'gsl', name: 'Gaussian Splat Lite', backend: 'WebGPU' },
  { id: 'gsl-gl', lib: 'gsl', name: 'Gaussian Splat Lite', backend: 'WebGL2' },
  { id: 'viewer-gpu', lib: 'viewer', name: 'SuperSplat Viewer', backend: 'WebGPU' },
  { id: 'pc-gpu', lib: 'playcanvas', name: 'PlayCanvas', backend: 'WebGPU' },
  { id: 'pc-gl', lib: 'playcanvas', name: 'PlayCanvas', backend: 'WebGL2' },
];
// GSL's baseline. Spark's radius limits use focal-scaled units; PlayCanvas's
// minPixelSize uses the same projected units. Alpha matches PlayCanvas's WebGPU
// visibility floor. Other culling details still differ.
const baseline = {
  minPixelRadius: 1,
  minAlpha: 1 / 255,
  preBlurAmount: 0.3,
  blurAmount: 0,
  focalAdjustment: 2,
  clipXY: 1.25,
  sortRadial: true,
};
const playcanvas = {
  minPixelSize: baseline.minPixelRadius * baseline.focalAdjustment,
  minContribution: 0,
  alphaClipForward: baseline.minAlpha,
  colorUpdateAngle: 0,
  radialSorting: baseline.sortRadial,
  antiAlias: false,
};
export const PRESETS = {
  radix: {
    method: 'ewa',
    sortBits: 24,
    params: { minAlpha: baseline.minAlpha, maxStdDev: Math.sqrt(8), falloff: 1 },
    objectParams: {
      minPixelRadius: 2,
      maxPixelRadius: 512,
      preBlurAmount: 0.3,
      blurAmount: 0,
      clipXY: 1.25,
      minContribution: 0,
      maxShDegree: 3,
    },
  },
  viewer: { ...playcanvas },
  spark: {
    ...baseline,
    minPixelRadius: baseline.minPixelRadius * baseline.focalAdjustment,
    maxPixelRadius: 512,
    extended: true,
  },
  gsl: { ...baseline, fastSort: true, stochastic: false },
  playcanvas,
};
export const FRAME_METRIC = 'frame-interval-ms';
// Shared by the lab table and PDF. `higher` marks metrics where larger values are better.
export const FRAME_COLUMNS = [
  { key: 'fps', label: 'FPS', higher: true },
  { key: 'p50', label: 'Frame P50 (ms)' },
  { key: 'p95', label: 'Frame P95 (ms)' },
];
export const isBest = (value, values, higher = false) =>
  Number.isFinite(value) &&
  Number(value.toFixed(2)) ===
    (higher ? Math.max : Math.min)(...values.filter(Number.isFinite).map(v => Number(v.toFixed(2))));
export const exactVersion = value => /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(value);
export const median = values => percentile(values, 0.5);
// Linear interpolation between closest ranks; matches numpy.percentile's default.
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p,
    lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}
export function summary(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}
// Medians of the per-round values.
export function aggregate(rows, scenario) {
  const cases = rows
    .filter(r => !r.error)
    .flatMap(r => r.cases)
    .filter(c => c.scenario === scenario && c.metric === FRAME_METRIC);
  if (!cases.length) return { rounds: 0, metrics: null };
  const metrics = {
    fps: median(cases.map(c => c.fps)),
    p50: median(cases.map(c => c.frameMs.p50)),
    p95: median(cases.map(c => c.frameMs.p95)),
  };
  return { rounds: cases.length, metrics };
}

export function roundOrder(backends, round) {
  const offset = Math.floor((round - 1) / 2) % backends.length;
  const order = [...backends.slice(offset), ...backends.slice(0, offset)];
  return round % 2 === 0 ? order.reverse() : order;
}
