// shared-adapter.js
import * as THREE2 from "three";

// ../lab/radix-adapter.js
import * as THREE from "three";
async function createRadix(lib, gpu, canvas, camera, url, filename, size, settings, loaded) {
  THREE.ColorManagement.workingColorSpace = gpu ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  const renderer = await lib.createRenderer({ canvas, backend: gpu ? "webgpu" : "webgpu-gl", antialias: false, hdr: false, limits: { maxBufferSize: "adapter", maxStorageBufferBindingSize: "adapter" } });
  if (lib.getGpuCaps(renderer).backend !== (gpu ? "webgpu" : "webgpu-gl")) throw Error("Requested Radix backend unavailable");
  renderer.setPixelRatio(1);
  renderer.setSize(size.width, size.height, false);
  renderer.setClearColor(1053720, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const start = performance.now();
  const data = await lib.loadSplats(url, { name: filename, layout: "extSplats" });
  const arrays = lib.GpuArrays.fromData(renderer, data);
  const collection = new lib.SplatCollection([lib.SplatCollection.arrays(arrays)]);
  const gs = new lib.SplatRenderer({ renderer, collection, ...settings, sortMode: gpu ? "gpu" : "cpu" });
  const scene = new THREE.Scene();
  scene.add(gs);
  const loadMs = performance.now() - start;
  const box = new THREE.Box3(), point = new THREE.Vector3();
  const { bundle } = lib.Splats.get(data);
  for (let i = 0; i < data.count; i++) {
    lib.Splats.loadCenter(bundle, i, point);
    box.expandByPoint(point);
  }
  return {
    renderer,
    gs,
    arrays,
    scene,
    camera,
    loadMs,
    count: data.count,
    sh: lib.Sh.find(data.bundles)?.degree ?? 0,
    bounds: { center: box.getCenter(new THREE.Vector3()).toArray(), radius: box.getSize(new THREE.Vector3()).length() / 2 },
    info: { sortMetric: "radial-distance", version: loaded.version, moduleURL: loaded.moduleURL, backend: gpu ? "WebGPU" : "WebGL2", three: THREE.REVISION, settings: { method: gs.method, sortBits: gs.sortBits, params: { ...gs.params }, objectParams: { ...gs.objectParams }, sourceType: "extSplats", sortMode: gs.sortMode }, workingColorSpace: THREE.ColorManagement.workingColorSpace, outputColorSpace: renderer.outputColorSpace },
    prepare() {
      gs.prepare(camera);
    },
    draw() {
      renderer.render(scene, camera);
    },
    async dispose() {
      gs.dispose();
      arrays.dispose();
      await renderer.dispose();
    }
  };
}

// ../lab/viewer-adapter.js
async function createViewerAdapter(lib, pc, canvas, commonCamera, url, filename, size, settings, loaded) {
  const { defaultSettings } = await import(new URL("settings.js", loaded.moduleURL).href);
  const experience = defaultSettings();
  experience.tonemapping = "none";
  experience.background.color = [16 / 255, 20 / 255, 24 / 255];
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;inset:0;overflow:hidden";
  canvas.replaceWith(container);
  const start = performance.now();
  const viewer = await lib.createViewer({ container, settings: experience, contentUrl: url, contentFilename: filename, renderer: "webgpu", ui: false, nofx: true, hpr: false, noanim: true, aa: false, stochastic: "off", framesInFlight: 0 });
  const { app } = viewer;
  if (!app.graphicsDevice.isWebGPU) {
    viewer.destroy();
    throw Error("Viewer WebGPU unavailable; fallback is disabled");
  }
  viewer.state.inputEnabled = false;
  viewer.state.performanceMode = false;
  viewer.state.quality = "max";
  const params = app.scene.gsplat;
  Object.assign(params, settings, { dataFormat: "large", stochastic: false, renderer: pc.GSPLAT_RENDERER_RASTER_GPU_SORT });
  if (!viewer.state.loaded) await new Promise((resolve) => viewer.events.once("loaded:changed", resolve));
  const loadMs = performance.now() - start;
  Object.assign(params, settings);
  app.autoRender = false;
  app.on("framerender", () => {
    app.renderNextFrame = false;
  });
  const component = app.root.findComponents("gsplat")[0];
  component.entity.setLocalEulerAngles(0, 0, 0);
  const asset = app.assets.get(component.asset);
  const camera = app.root.findComponents("camera")[0];
  const device = app.graphicsDevice;
  canvas = device.canvas;
  canvas.style.cssText = "width:100%;height:100%;display:block";
  device.maxPixelRatio = 1;
  const syncCamera = () => {
    device.resizeCanvas(size.width, size.height);
    camera.entity.setPosition(commonCamera.position.x, commonCamera.position.y, commonCamera.position.z);
    camera.entity.setRotation(commonCamera.quaternion.x, commonCamera.quaternion.y, commonCamera.quaternion.z, commonCamera.quaternion.w);
    camera.fov = commonCamera.fov;
    camera.horizontalFov = false;
    camera.aspectRatioMode = pc.ASPECT_MANUAL;
    camera.aspectRatio = size.width / size.height;
    camera.nearClip = commonCamera.near;
    camera.farClip = commonCamera.far;
    camera.toneMapping = pc.TONEMAP_LINEAR;
  };
  app.on("prerender", syncCamera);
  const { center, halfExtents } = asset.resource.aabb;
  return {
    canvas,
    app,
    viewer,
    loadMs,
    count: asset.resource.numSplats,
    sh: asset.resource.shBands,
    bounds: { center: [center.x, center.y, center.z], radius: halfExtents.length() },
    info: { version: loaded.version, moduleURL: loaded.moduleURL, engineVersion: pc.version, engineCommit: pc.revision, backend: "WebGPU", settings: { ...Object.fromEntries(Object.keys(settings).map((key) => [key, params[key]])), dataFormat: params.dataFormat, stochastic: false, postEffects: false }, loadMetric: "viewer first frame", frameLoop: "viewer updates; explicit measured renders" },
    draw(dt) {
      app.update(dt);
      app.render();
    },
    dispose() {
      viewer.destroy();
      container.remove();
    }
  };
}

// ../lab/config.js
var PACKAGES = {
  spark: { name: "@sparkjsdev/spark", version: "2.4.0" },
  radix: { name: "@sparkjsdev/radix", version: "0.0.1" },
  viewer: { name: "@playcanvas/supersplat-viewer", version: "1.42.0", entry: "dist/viewer.js" },
  playcanvas: { name: "playcanvas", version: "2.24.0-beta.30", commit: "876ba2e7dffc246b1008695f23f60ac1a9b96109" },
  gsl: { name: "gaussian-splat-lite", version: "1.6.2" },
  threeRadix: { name: "three", installName: "three-radix", version: "0.186.1" },
  three: { name: "three", version: "0.187.0" }
};
var baseline = { minPixelRadius: 1, minAlpha: 1 / 255, preBlurAmount: 0.3, blurAmount: 0, focalAdjustment: 2, clipXY: 1.25, sortRadial: true };
var playcanvas = { minPixelSize: baseline.minPixelRadius * baseline.focalAdjustment, minContribution: 0, alphaClipForward: baseline.minAlpha, colorUpdateAngle: 0, radialSorting: baseline.sortRadial, antiAlias: false };
var PRESETS = {
  radix: { method: "ewa", sortBits: 24, params: { minAlpha: baseline.minAlpha, maxStdDev: Math.sqrt(8), falloff: 1 }, objectParams: { minPixelRadius: 2, maxPixelRadius: 512, preBlurAmount: 0.3, blurAmount: 0, clipXY: 1.25, minContribution: 0, maxShDegree: 3 } },
  viewer: { ...playcanvas },
  spark: { ...baseline, minPixelRadius: baseline.minPixelRadius * baseline.focalAdjustment, maxPixelRadius: 512, extended: true },
  gsl: { ...baseline, fastSort: true, stochastic: false },
  playcanvas
};

// timer.js
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shared-adapter.js
async function createShared(config, mode, model, onDevice) {
  const radix = mode.startsWith("radix-"), gpu = mode.endsWith("-gpu");
  const key = radix ? "radix" : "viewer";
  const pkg = PACKAGES[key];
  const moduleURL = new URL(`/node_modules/${pkg.name}/${pkg.entry ?? "dist/radix.module.js"}`, location.href).href;
  const lib = await import(moduleURL);
  if (radix && !gpu) {
    const worker = new URL("/radix-worker.js", location.href);
    Object.defineProperty(lib.WorkerPool, "coreUrl", { get: () => worker.href });
  }
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  document.body.append(canvas);
  const camera = new THREE2.PerspectiveCamera(45, config.width / config.height, 0.1, 3e3);
  const loaded = { version: pkg.version, moduleURL };
  const args = [canvas, camera, `/models/${model}.ply`, `${model}.ply`, config, PRESETS[key], loaded];
  const adapter = radix ? await createRadix(lib, gpu, ...args) : await createViewerAdapter(lib, await import("playcanvas"), ...args);
  const view = radix && !gpu ? adapter.gs.viewFor(camera) : null;
  const jobs = [];
  let probing = false, autoSort;
  const output = adapter.canvas ?? canvas;
  const device = gpu ? radix ? adapter.renderer.backend.device : output.getContext("webgpu").getConfiguration().device : null;
  if (device) {
    const timer = onDevice(device);
    if (radix) adapter.gs.phase = (name, run) => {
      timer.stage = name === "sort" ? "sort" : "projection";
      try {
        return run();
      } finally {
        timer.stage = null;
      }
    };
    else {
      const graphics = adapter.app.graphicsDevice, dispatch = graphics.computeDispatch.bind(graphics);
      let sorting = false;
      graphics.computeDispatch = (computes, name) => {
        sorting = /RadixSort4bit|OneSweep/.test(name) || sorting && /PrefixSum/.test(name);
        timer.stage = sorting ? "sort" : "projection";
        try {
          return dispatch(computes, name);
        } finally {
          timer.stage = null;
        }
      };
    }
  }
  return {
    canvas: output,
    device,
    gl: gpu ? null : output.getContext("webgl2"),
    loadMs: adapter.loadMs,
    count: adapter.count,
    setView(position, quaternion) {
      camera.position.fromArray(position);
      camera.quaternion.fromArray(quaternion);
      camera.updateMatrixWorld();
    },
    async update() {
      if (!probing) return;
      const start = performance.now();
      const order = await view.sort(camera);
      jobs.push({ ms: performance.now() - start, at: performance.now(), keysMs: order.keysMs, sortMs: order.sortMs });
      view.apply(order);
    },
    jobs: () => jobs,
    async sortProbe(_timer, enabled) {
      if (!view) return;
      if (enabled) {
        autoSort = adapter.gs.autoSort;
        adapter.gs.autoSort = false;
        while (view.autoSorting) await sleep(1);
      } else adapter.gs.autoSort = autoSort;
      probing = enabled;
    },
    draw() {
      adapter.draw(1 / 60);
    },
    async setVariant(variant) {
      if (variant !== "sorted") throw Error("This adapter measures sorted rendering only");
    },
    roots: () => radix ? { arrays: adapter.arrays, gs: adapter.gs } : { app: adapter.app },
    visible: async () => radix && gpu ? adapter.gs.readSortedCount() : null,
    state() {
      const settings = radix ? { ...adapter.info.settings, sortBits: adapter.gs.sortBits } : { ...adapter.info.settings, ...Object.fromEntries(Object.keys(PRESETS.viewer).map((key2) => [key2, adapter.app.scene.gsplat[key2]])) };
      return { ...adapter.info, backend: gpu ? "webgpu" : "webgl2", sourceCount: adapter.count, sh: adapter.sh, stochastic: false, spatialResolve: false, temporalResolve: false, sortRadial: radix || settings.radialSorting, renderParameters: settings };
    }
  };
}
export {
  createShared
};
