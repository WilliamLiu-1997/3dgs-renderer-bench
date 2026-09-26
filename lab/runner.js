import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAdapter } from './adapters.js';
import { BACKENDS, summary } from './config.js';

let adapter, controls, camera, canvas, basePose, raf, fault, disposed = false, busy = false;
const send = message => parent.postMessage(message, location.origin);
addEventListener('error', event => { fault = event.message; send({ type: 'fatal', error: fault }); });
addEventListener('unhandledrejection', event => { fault = String(event.reason); send({ type: 'fatal', error: fault }); });
async function dispose() {
  disposed = true;
  cancelAnimationFrame(raf);
  controls?.dispose();
  const current = adapter; adapter = null;
  await current?.dispose();
}
addEventListener('pagehide', dispose);
const nextFrame = () => new Promise(resolve => { raf = requestAnimationFrame(resolve); });
function pose() {
  return { position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), fov: camera.fov, near: camera.near, far: camera.far };
}
function setPose(value) {
  const resetControls = !controls || !camera.up.equals(new THREE.Vector3().fromArray(value.up));
  camera.up.fromArray(value.up); camera.position.fromArray(value.position);
  // OrbitControls captures the up axis in its constructor.
  if (resetControls) {
    controls?.dispose();
    controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.enabled = !busy;
    controls.addEventListener('change', () => { if (!busy) { basePose = pose(); send({ type: 'camera', pose: basePose }); } });
  }
  controls.target.fromArray(value.target);
  camera.fov = value.fov; camera.near = value.near; camera.far = value.far;
  camera.updateProjectionMatrix(); camera.lookAt(controls.target); camera.updateMatrixWorld(); controls.update();
  basePose = pose(); send({ type: 'camera', pose: basePose });
}
function fit() {
  const { center, radius } = adapter.bounds;
  if (![...center, radius].every(Number.isFinite) || radius <= 0) throw Error('The model has no valid bounds');
  const fov = 45;
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(fov / 2)) * 1.12;
  setPose({ position: [center[0], center[1], center[2] + distance], target: center, up: [0, -1, 0], fov, near: Math.max(radius / 10000, 0.001), far: distance + radius * 10 });
}
function render(dt = 1 / 60) {
  if (disposed || fault) throw Error(fault || 'Renderer disposed');
  camera.updateMatrixWorld(); adapter.beforeDraw?.();
  const start = performance.now(); adapter.draw(dt); return start;
}
function previewLoop() {
  try { controls.update(); render(); raf = requestAnimationFrame(previewLoop); }
  catch (error) { send({ type: 'fatal', error: String(error) }); }
}
async function initialize(data) {
  const { size } = data;
  canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height; document.body.append(canvas);
  canvas.addEventListener('webglcontextlost', () => { if (disposed) return; fault = 'WebGL context lost. Sample discarded.'; send({ type: 'fatal', error: fault }); });
  camera = new THREE.PerspectiveCamera(45, size.width / size.height, 0.01, 10000);
  adapter = await createAdapter(BACKENDS.find(b => b.id === data.backend), data.versions, data.settings, canvas, camera, data.file, size);
  if (!adapter.count) throw Error('No splats found. Select a valid 3DGS model.');
  if (data.pose) setPose(data.pose); else fit();
  await adapter.prepare?.();
  render();
  if (data.preview) previewLoop();
  return { loadMs: adapter.loadMs, count: adapter.count, info: adapter.info, pose: pose(), bounds: adapter.bounds };
}
async function measure({ scenario, warmup, duration }) {
  // Use the canvas APIs, not private renderer/device fields.
  const gl = canvas.getContext('webgl2');
  const queue = gl ? null : canvas.getContext('webgpu')?.getConfiguration?.()?.device.queue;
  if (!gl && !queue) throw Error('This browser cannot expose GPU completion through the canvas API.');
  const channel = gl ? new MessageChannel() : null;
  function waitForCompletion() {
    if (queue) return queue.onSubmittedWorkDone();
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) throw Error('Could not create a GPU completion fence.');
    gl.flush();
    return new Promise((resolve, reject) => {
      channel.port1.onmessage = () => {
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) { channel.port2.postMessage(null); return; }
        gl.deleteSync(fence); channel.port1.onmessage = null;
        if (status === gl.WAIT_FAILED) reject(Error('GPU completion fence failed.'));
        else resolve();
      };
      // Yield to the event loop without setTimeout's nested-timer delay.
      channel.port2.postMessage(null);
    });
  }
  const completionMethod = gl ? 'WebGL2.fenceSync/clientWaitSync' : 'GPUQueue.onSubmittedWorkDone';
  cancelAnimationFrame(raf); busy = true; controls.enabled = false; fault = null;
  const fixed = structuredClone(basePose);
  const offset = new THREE.Vector3().fromArray(fixed.position).sub(new THREE.Vector3().fromArray(fixed.target));
  const axis = new THREE.Vector3().fromArray(fixed.up);
  function viewAt(seconds) {
    camera.position.copy(offset);
    if (scenario === 'moving') camera.position.applyAxisAngle(axis, (Math.PI / 4) * Math.sin(seconds * Math.PI / 4));
    camera.position.add(controls.target); camera.lookAt(controls.target); camera.updateMatrixWorld();
  }
  let motionStart;
  async function phase(seconds, collect) {
    const frameTimes = [];
    let previous = await nextFrame(), start = previous, lastProgress = previous;
    while (true) {
      const now = await nextFrame();
      if (document.hidden) throw Error('Tab hidden. Sample discarded.');
      if (now - start >= seconds * 1000) break;
      viewAt((now - motionStart) / 1000);
      const frameStart = render((now - previous) / 1000);
      await waitForCompletion();
      const frameMs = performance.now() - frameStart;
      if (fault || gl?.isContextLost()) throw Error(fault || 'WebGL context lost. Sample discarded.');
      if (document.hidden) throw Error('Tab hidden. Sample discarded.');
      if (collect) frameTimes.push(frameMs);
      previous = now;
      if (now - lastProgress >= 100) { send({ type: 'progress', phase: collect ? 'sampling' : 'warmup', scenario, elapsed: (now - start) / 1000, duration: seconds }); lastProgress = now; }
    }
    return { frameTimes, elapsedMs: performance.now() - start };
  }
  try {
    await waitForCompletion(); // Drain preview work before warm-up.
    motionStart = performance.now(); // Keep orbit motion continuous across both phases.
    await phase(warmup, false);
    const { frameTimes, elapsedMs } = await phase(duration, true);
    if (!frameTimes.length) throw Error('No valid samples');
    setPose(fixed); render();
    // Capture outside measurement, after a fresh render; no preserveDrawingBuffer override.
    const screenshot = canvas.toDataURL('image/jpeg', 0.88);
    const { p50, p95 } = summary(frameTimes);
    return { scenario, completionMethod, frameMs: { p50, p95 }, frames: frameTimes.length, elapsedMs, frameTimes, screenshot };
  } finally { channel?.port1.close(); channel?.port2.close(); busy = false; controls.enabled = true; setPose(fixed); }
}
addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const { id, type, data } = event.data;
  try {
    let result;
    if (type === 'init') result = await initialize(data);
    else if (type === 'measure') result = await measure(data);
    else if (type === 'camera') { setPose(data); result = pose(); }
    else if (type === 'fit') { fit(); result = pose(); }
    else if (type === 'dispose') await dispose();
    else return;
    send({ type: 'reply', id, result });
  } catch (error) { send({ type: 'reply', id, error: String(error) }); }
});
send({ type: 'ready' });
