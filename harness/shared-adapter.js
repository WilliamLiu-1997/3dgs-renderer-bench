import * as THREE from 'three';
import { createRadix } from '../lab/radix-adapter.js';
import { createViewerAdapter } from '../lab/viewer-adapter.js';
import { createAholo } from '../lab/aholo-adapter.js';
import { PACKAGES, PRESETS } from '../lab/config.js';
import { sleep, tagPlayCanvasSort } from './timer.js';

// Radix (WebGPU / WebGL2), SuperSplat Viewer and Aholo Viewer reuse the lab adapters with harness instrumentation.
export async function createShared(config, mode, model, onDevice) {
  const radix = mode.startsWith('radix-'),
    aholo = mode.startsWith('aholo-'),
    gpu = mode.endsWith('-gpu');
  const key = radix ? 'radix' : aholo ? 'aholo' : 'viewer';
  const pkg = PACKAGES[key];
  const moduleURL = new URL(`/node_modules/${pkg.name}/${pkg.entry ?? 'dist/radix.module.js'}`, location.href).href;
  const lib = await import(moduleURL);
  if (radix && !gpu) {
    const worker = new URL('/radix-worker.js', location.href);
    Object.defineProperty(lib.WorkerPool, 'coreUrl', { get: () => worker.href });
  }
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  document.body.append(canvas);
  const camera = new THREE.PerspectiveCamera(45, config.width / config.height, 0.1, 3000);
  const loaded = { version: pkg.version, moduleURL };
  const args = [canvas, camera, `/models/${model}.ply`, `${model}.ply`, config, PRESETS[key], loaded];
  const adapter = radix
    ? await createRadix(lib, gpu, ...args)
    : aholo
      ? await createAholo(lib, ...args)
      : await createViewerAdapter(lib, await import('playcanvas'), ...args);
  const view = radix && !gpu ? adapter.gs.viewFor(camera) : null;
  const jobs = [];
  let autoSort;
  // Aholo Viewer sorts asynchronously: GPU keys, fenced readback, Worker sort, then the order is applied on a
  // later frame. It never flushes GL itself, so flush while waiting instead of drawing extra frames. A splat is
  // stable after a frame drawn with no sort in flight.
  async function aholoUpdate() {
    const { splat, gl } = adapter;
    const start = performance.now();
    adapter.draw();
    let sorted = false;
    while (!splat.isRenderingStability) {
      let done = false;
      splat.once(lib.Events.SplatSortedEvent, () => (done = true));
      while (!done) {
        if (performance.now() - start > 60000) throw Error('Aholo Viewer sort did not complete');
        gl.flush();
        await sleep(1);
      }
      sorted = true;
      adapter.draw();
    }
    if (sorted) jobs.push({ ms: performance.now() - start, at: performance.now() });
  }

  const output = adapter.canvas ?? canvas;
  const device = gpu
    ? radix
      ? adapter.renderer.backend.device
      : output.getContext('webgpu').getConfiguration().device
    : null;
  if (device) {
    const timer = onDevice(device);
    if (radix)
      adapter.gs.phase = (name, run) => {
        timer.stage = name === 'sort' ? 'sort' : 'projection';
        try {
          return run();
        } finally {
          timer.stage = null;
        }
      };
    else tagPlayCanvasSort(adapter.app.graphicsDevice, timer);
  }
  return {
    canvas: output,
    device,
    gl: gpu ? null : output.getContext('webgl2'),
    loadMs: adapter.loadMs,
    count: adapter.count,
    setView(position, quaternion) {
      camera.position.fromArray(position);
      camera.quaternion.fromArray(quaternion);
      camera.updateMatrixWorld();
    },
    async update() {
      if (aholo) return aholoUpdate();
      if (!view) return;
      while (view.autoSorting) await sleep(1);
      const start = performance.now();
      const order = await view.sort(camera);
      jobs.push({ ms: performance.now() - start, at: performance.now(), keysMs: order.keysMs, sortMs: order.sortMs });
      view.apply(order);
    },
    jobs: () => jobs,
    async sortProbe(enabled) {
      if (!view) return;
      if (enabled) {
        autoSort = adapter.gs.autoSort;
        adapter.gs.autoSort = false;
        while (view.autoSorting) await sleep(1);
      } else adapter.gs.autoSort = autoSort;
    },
    draw(dt = 1 / 60) {
      adapter.draw(dt);
    },
    async setVariant(variant) {
      if (variant !== 'sorted') throw Error('This adapter measures sorted rendering only');
    },
    roots: () =>
      radix
        ? { arrays: adapter.arrays, gs: adapter.gs }
        : aholo
          ? { data: adapter.data, viewer: adapter.viewer }
          : { app: adapter.app },
    visible: async () => (radix && gpu ? adapter.gs.readSortedCount() : null),
    state() {
      const settings = radix
        ? { ...adapter.info.settings, sortBits: adapter.gs.sortBits }
        : aholo
          ? adapter.info.settings
          : {
              ...adapter.info.settings,
              ...Object.fromEntries(Object.keys(PRESETS.viewer).map(key => [key, adapter.app.scene.gsplat[key]])),
            };
      return {
        ...adapter.info,
        backend: gpu ? 'webgpu' : 'webgl2',
        sourceCount: adapter.count,
        sh: adapter.sh,
        stochastic: false,
        spatialResolve: false,
        temporalResolve: false,
        sortRadial: aholo ? false : radix || settings.radialSorting,
        renderParameters: settings,
      };
    },
  };
}
