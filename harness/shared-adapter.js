import * as THREE from 'three';
import { createRadix } from '../lab/radix-adapter.js';
import { createViewerAdapter } from '../lab/viewer-adapter.js';
import { PACKAGES, PRESETS } from '../lab/config.js';
import { sleep, tagPlayCanvasSort } from './timer.js';

// Radix (WebGPU / WebGL2) and SuperSplat Viewer reuse the lab adapters with harness instrumentation.
export async function createShared(config, mode, model, onDevice) {
  const radix = mode.startsWith('radix-'),
    gpu = mode.endsWith('-gpu');
  const key = radix ? 'radix' : 'viewer';
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
    : await createViewerAdapter(lib, await import('playcanvas'), ...args);
  const view = radix && !gpu ? adapter.gs.viewFor(camera) : null;
  const jobs = [];
  let autoSort;
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
    roots: () => (radix ? { arrays: adapter.arrays, gs: adapter.gs } : { app: adapter.app }),
    visible: async () => (radix && gpu ? adapter.gs.readSortedCount() : null),
    state() {
      const settings = radix
        ? { ...adapter.info.settings, sortBits: adapter.gs.sortBits }
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
        sortRadial: radix || settings.radialSorting,
        renderParameters: settings,
      };
    },
  };
}
