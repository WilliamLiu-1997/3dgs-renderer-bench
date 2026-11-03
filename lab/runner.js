import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAdapter } from './adapters.js';
import { BACKENDS } from './config.js';
import { createFrameGate, orbitAngle, sampleFrames, waitForGpu } from './frame-timing.js';

let adapter,
  controls,
  camera,
  canvas,
  basePose,
  raf,
  gpu,
  previewGate,
  fault,
  disposed = false,
  busy = false;
const send = message => parent.postMessage(message, location.origin);
function fail(message) {
  if (disposed || fault) return;
  fault = message;
  send({ type: 'fatal', error: fault });
}
addEventListener('error', event => fail(event.message));
addEventListener('unhandledrejection', event => fail(String(event.reason)));
function stopPreview() {
  cancelAnimationFrame(raf);
  previewGate?.dispose();
  previewGate = null;
}
async function dispose() {
  disposed = true;
  stopPreview();
  controls?.dispose();
  const current = adapter;
  adapter = null;
  await current?.dispose();
}
addEventListener('pagehide', dispose);
function pose() {
  return {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };
}
function setPose(value) {
  const resetControls = !controls || !camera.up.equals(new THREE.Vector3().fromArray(value.up));
  camera.up.fromArray(value.up);
  camera.position.fromArray(value.position);
  // OrbitControls captures the up axis in its constructor.
  if (resetControls) {
    controls?.dispose();
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.enabled = !busy;
    controls.addEventListener('change', () => {
      if (!busy) {
        basePose = pose();
        send({ type: 'camera', pose: basePose });
      }
    });
  }
  controls.target.fromArray(value.target);
  camera.fov = value.fov;
  camera.near = value.near;
  camera.far = value.far;
  camera.updateProjectionMatrix();
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  controls.update();
  basePose = pose();
  send({ type: 'camera', pose: basePose });
}
function fit() {
  const { center, radius } = adapter.bounds;
  if (![...center, radius].every(Number.isFinite) || radius <= 0) throw Error('The model has no valid bounds');
  const fov = 45;
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(fov / 2))) * 1.12;
  setPose({
    position: [center[0], center[1], center[2] + distance],
    target: center,
    up: [0, -1, 0],
    fov,
    near: Math.max(radius / 10000, 0.001),
    far: distance + radius * 10,
  });
}
function render(dt = 1 / 60) {
  if (disposed || fault) throw Error(fault || 'Renderer disposed');
  camera.updateMatrixWorld();
  adapter.beforeDraw?.();
  const start = performance.now();
  adapter.draw(dt);
  return performance.now() - start;
}
// The preview keeps one GPU frame in flight, like the measurement: controls update every animation
// frame and a draw blocked on the GPU runs as soon as the previous frame completes.
function previewFrame() {
  try {
    render();
    previewGate.submitted();
  } catch (error) {
    stopPreview();
    send({ type: 'fatal', error: String(error) });
  }
}
function previewLoop() {
  if (!previewGate) return;
  raf = requestAnimationFrame(previewLoop);
  controls.update();
  if (previewGate.isReady(previewFrame)) previewFrame();
}
function startPreview() {
  previewGate = createFrameGate(gpu);
  previewLoop();
}
async function initialize(data) {
  const { size } = data;
  canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  document.body.append(canvas);
  canvas.addEventListener('webglcontextlost', () => fail('WebGL context lost. Sample discarded.'));
  camera = new THREE.PerspectiveCamera(45, size.width / size.height, 0.01, 10000);
  adapter = await createAdapter(
    BACKENDS.find(b => b.id === data.backend),
    data.versions,
    data.settings,
    canvas,
    camera,
    data.file,
    size,
  );
  canvas = adapter.canvas ?? canvas;
  if (!adapter.count) throw Error('No splats found. Select a valid 3DGS model.');
  if (data.pose) setPose(data.pose);
  else fit();
  await adapter.prepare?.();
  render();
  // Some renderers create their canvas context lazily on the first draw. Query it only afterwards,
  // WebGPU first: getContext() with the wrong type would otherwise create a second context.
  const device = canvas.getContext('webgpu')?.getConfiguration?.()?.device;
  const gl = device ? null : canvas.getContext('webgl2');
  if (!gl && !device) throw Error('GPU completion is unavailable for this canvas.');
  gpu = { gl, device };
  if (device) {
    device.addEventListener('uncapturederror', event => fail(`WebGPU error: ${event.error.message}`));
    device.lost.then(info => fail(`WebGPU device lost: ${info.message}`));
  }
  await waitForGpu(gpu);
  if (data.preview) startPreview();
  return { loadMs: adapter.loadMs, count: adapter.count, info: adapter.info, pose: pose(), bounds: adapter.bounds };
}
async function measure({ scenario, warmup, duration }) {
  const { gl, device } = gpu;
  stopPreview();
  busy = true;
  controls.enabled = false;
  const fixed = structuredClone(basePose);
  const offset = new THREE.Vector3().fromArray(fixed.position).sub(new THREE.Vector3().fromArray(fixed.target));
  const axis = new THREE.Vector3().fromArray(fixed.up);
  device?.pushErrorScope('validation');
  try {
    await waitForGpu({ gl, device });
    const result = await sampleFrames({
      warmup,
      duration,
      gpu: { gl, device },
      check() {
        if (fault || disposed) throw Error(fault || 'Renderer disposed');
      },
      draw({ seconds, dt }) {
        const angle = scenario === 'moving' ? orbitAngle(seconds) : 0;
        camera.position.copy(offset).applyAxisAngle(axis, angle).add(controls.target);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
        return { cpuSubmitMs: render(dt), cameraAngle: angle, motionSeconds: seconds };
      },
      progress(value) {
        send({ type: 'progress', scenario, ...value });
      },
    });
    await waitForGpu({ gl, device });
    setPose(fixed);
    render();
    const screenshot = canvas.toDataURL('image/jpeg', 0.88);
    await waitForGpu({ gl, device });
    if (fault) throw Error(fault);
    if (gl) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw Error(`WebGL error 0x${error.toString(16)}. Sample discarded.`);
    }
    return {
      scenario,
      ...result,
      motionAmplitudeDegrees: scenario === 'moving' ? 45 : 0,
      motionPeriodSeconds: 8,
      frameTimes: result.rows.map(row => row.frameMs),
      screenshot,
    };
  } finally {
    busy = false;
    controls.enabled = true;
    setPose(fixed);
    const error = await device?.popErrorScope();
    if (error) throw Error(`WebGPU validation failed. Sample discarded: ${error.message}`);
  }
}
addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const { id, type, data } = event.data;
  try {
    let result;
    if (type === 'init') result = await initialize(data);
    else if (type === 'measure') result = await measure(data);
    else if (type === 'camera') {
      setPose(data);
      result = pose();
    } else if (type === 'fit') {
      fit();
      result = pose();
    } else if (type === 'dispose') await dispose();
    else return;
    send({ type: 'reply', id, result });
  } catch (error) {
    send({ type: 'reply', id, error: String(error) });
  }
});
send({ type: 'ready' });
