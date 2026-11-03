// Benchmark page driven by run.mjs through window.benchmark / sortBenchmark / captureView / snapshot.
// instrument.js runs first and provides the `errors`, `metrics` and `memorySnapshot` globals.
import * as THREE from 'three';
import { orbitAngle, sampleFrames, waitForGpu } from '/lab/frame-timing.js';
import { gpuTimer, sleep } from './timer.js';

const query = new URLSearchParams(location.search);
const mode = query.get('mode') || 'gsl-gl';
const model = query.get('model') || 'elevator';
const config = await (await fetch('/config.json')).json();
window.phase = 'loading';

let timer = null;
function onDevice(device) {
  if (!device.features.has('timestamp-query')) throw Error('GPU timestamp-query required');
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.lost.then(info => errors.push(`WebGPU device lost: ${info.message}`));
  timer = gpuTimer(device);
  return timer;
}

async function createAdapter() {
  if (mode.startsWith('radix-') || mode === 'viewer-gpu')
    return (await import('./shared-adapter.js')).createShared(config, mode, model, onDevice);
  if (mode.startsWith('pc-'))
    return (await import('./playcanvas-adapter.js')).createPlayCanvas(config, mode, model, onDevice);
  return (await import('./three-adapter.js')).createThree(config, mode, model, onDevice);
}
const adapter = await createAdapter();
window.api = adapter;
const { canvas, device, gl } = adapter;
canvas.addEventListener('webglcontextlost', () => errors.push('WebGL context lost. Sample discarded.'));
if (canvas.width !== config.width || canvas.height !== config.height)
  throw Error(`Unexpected resolution ${canvas.width}x${canvas.height}`);

let gpuInfo;
if (gl) {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  gpuInfo = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
} else {
  const { info } = await navigator.gpu.requestAdapter();
  gpuInfo = { vendor: info.vendor, architecture: info.architecture, description: info.description };
}

// All renderers receive the same world-space pose from this helper camera.
const viewCamera = new THREE.PerspectiveCamera(45, config.width / config.height, 0.1, 3000);
viewCamera.up.set(0, -1, 0);
const target = new THREE.Vector3(...config.models[model].target);
const offset = new THREE.Vector3(...config.models[model].offset);
const orbitAxis = new THREE.Vector3(0, 1, 0);
function setView(angle = 0, scale = 1) {
  viewCamera.position.copy(offset).multiplyScalar(scale).applyAxisAngle(orbitAxis, angle).add(target);
  viewCamera.lookAt(target);
  viewCamera.updateMatrixWorld();
  adapter.setView(viewCamera.position.toArray(), viewCamera.quaternion.toArray());
}

function checkErrors() {
  if (gl) {
    const code = gl.getError();
    if (code !== gl.NO_ERROR) errors.push(`WebGL error: 0x${code.toString(16)}`);
  }
  if (errors.length) throw Error(errors.join('\n'));
}

async function withValidation(run) {
  device?.pushErrorScope('validation');
  try {
    return await run();
  } finally {
    const error = await device?.popErrorScope();
    if (error) throw Error(`WebGPU validation failed: ${error.message}`);
    checkErrors();
  }
}

// One frame with an explicit GPU wait. Diagnostics and captures only; never inside sampled loops.
async function completedFrame({ diagnostic = false } = {}) {
  const row = {};
  const start = performance.now();
  if (diagnostic && timer) timer.start(row);
  adapter.draw();
  row.cpuSubmitMs = performance.now() - start;
  if (diagnostic && timer) await timer.finish();
  else await waitForGpu({ gl, device });
  row.completionMs = performance.now() - start;
  checkErrors();
  return row;
}

async function waitForAsyncSort() {
  if (adapter.gs) while (adapter.gs.sorting || adapter.gs.updateRunning) await sleep(1);
}

setView();
await adapter.update();
adapter.draw();
await waitForGpu({ gl, device });
if (adapter.count !== config.models[model].count) throw Error(`Wrong model count: ${adapter.count}`);
window.phase = 'ready';
window.ready = true;
document.getElementById('status').style.display = 'none';

// Continuous rendering with the shared lab sampler: one GPU frame in flight, native async sorting.
window.benchmark = ({
  variant = 'sorted',
  fast = true,
  moving = false,
  angle = 0,
  scale = 1,
  warmup = config.warmupSeconds,
  duration = config.sampleSeconds[moving ? 'moving' : 'static'],
} = {}) =>
  withValidation(async () => {
    window.phase = `${variant} ${moving ? 'moving' : 'static'}`;
    await adapter.setVariant(variant, fast);
    setView(angle, scale);
    await adapter.update();
    await waitForGpu({ gl, device });
    let rpcStart, jobStart;
    adapter.setAuto?.(true);
    try {
      const measured = await sampleFrames({
        warmup,
        duration,
        gpu: { gl, device },
        check() {
          if (errors.length) throw Error(errors.join('\n'));
        },
        onSampleStart() {
          rpcStart = metrics.rpc.length;
          jobStart = adapter.jobs?.().length ?? 0;
        },
        draw({ seconds, dt }) {
          const motion = moving ? orbitAngle(seconds, config.motionAmplitudeDegrees, config.motionPeriodSeconds) : 0;
          setView(angle - motion, scale);
          const start = performance.now();
          adapter.draw(dt);
          return { cpuSubmitMs: performance.now() - start, cameraAngle: angle - motion, motionSeconds: seconds };
        },
      });
      adapter.setAuto?.(false);
      await waitForAsyncSort();
      await waitForGpu({ gl, device });
      checkErrors();
      window.phase = 'ready';
      return {
        ...measured,
        variant,
        motionAmplitudeDegrees: moving ? config.motionAmplitudeDegrees : 0,
        motionPeriodSeconds: config.motionPeriodSeconds,
        fast: mode.startsWith('gsl') ? fast : null,
        moving,
        angle,
        scale,
        rpc: metrics.rpc.slice(rpcStart),
        sortJobs: adapter.jobs?.().slice(jobStart) ?? [],
        state: adapter.state(),
        visible: await adapter.visible(),
        errors: [...errors],
      };
    } finally {
      adapter.setAuto?.(false);
    }
  });

// Sort latency: alternate between two nearby poses and wait for each complete sort.
window.sortBenchmark = async ({ fast = true, n = 16, warmupSamples = 4 } = {}) => {
  await adapter.setVariant('sorted', fast);
  adapter.setAuto?.(false);
  setView();
  await adapter.update();
  await completedFrame();
  await adapter.sortProbe?.(true);
  const rows = [];
  try {
    await withValidation(async () => {
      for (let i = 0; i < n + warmupSamples; i++) {
        setView(i % 2 ? 0.1 : -0.1);
        const rpcStart = metrics.rpc.length;
        const jobStart = adapter.jobs?.().length ?? 0;
        const start = performance.now();
        await adapter.update();
        const updateMs = performance.now() - start;
        const measured = await completedFrame({ diagnostic: true });
        if (i < warmupSamples) continue;
        rows.push({
          updateMs,
          totalMs: performance.now() - start,
          ...measured,
          rpc: metrics.rpc.slice(rpcStart),
          sortJobs: adapter.jobs?.().slice(jobStart) ?? [],
        });
      }
    });
  } finally {
    await adapter.sortProbe?.(false);
  }
  return {
    fast: mode.startsWith('gsl') ? fast : null,
    rows,
    gpuIsolation:
      mode === 'gsl-gpu'
        ? 'Projection and radix are submitted as separate compute passes for this diagnostic only.'
        : 'Native pass boundaries.',
  };
};

window.captureView = async ({ variant = 'sorted', fast = true, angle = 0, scale = 1 } = {}) => {
  await adapter.setVariant(variant, fast);
  setView(angle, scale);
  await adapter.update();
  for (let i = 0; i < 5; i++) await completedFrame();
};

window.snapshot = () => ({
  mode,
  model,
  config,
  loadMs: adapter.loadMs,
  state: adapter.state(),
  resolution: [canvas.width, canvas.height],
  dpr: devicePixelRatio,
  gpuInfo,
  camera: {
    position: viewCamera.position.toArray(),
    quaternion: viewCamera.quaternion.toArray(),
    fov: 45,
    near: 0.1,
    far: 3000,
  },
  memory: memorySnapshot(adapter.roots()),
  rpc: metrics.rpc,
  errors: [...errors],
});
