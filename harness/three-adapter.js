import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { PRESETS } from '/lab/config.js';
import { sleep } from './timer.js';

// Spark (WebGL2) and Gaussian Splat Lite (WebGL2 / WebGPU) through Three.js.
export async function createThree(config, mode, model, onDevice, format = 'ply') {
  const spark = mode === 'spark-gl',
    gpu = mode === 'gsl-gpu';
  // Match the GSL viewer: native WebGPU blends in sRGB; WebGL outputs sRGB.
  THREE.ColorManagement.workingColorSpace = gpu ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  const lib = await import(spark ? '/dist/spark.js' : '/dist/gsl.js');
  let renderer, device, gl, timer;
  const rendererParameters = {
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    ...(spark ? {} : { reversedDepthBuffer: true }),
  };
  if (gpu) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw Error('No WebGPU adapter');
    renderer = new WebGPURenderer({
      ...rendererParameters,
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw Error('Native WebGPU required');
    device = renderer.backend.device;
    timer = onDevice(device);
  } else {
    renderer = new THREE.WebGLRenderer(rendererParameters);
    gl = renderer.getContext();
  }
  renderer.setPixelRatio(config.dpr);
  renderer.setSize(config.logicalWidth, config.logicalHeight);
  renderer.setClearColor(0x101418, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(45, config.width / config.height, 0.1, 3000);
  // Share the exact matched rendering presets with the browser lab.
  // The benchmark controls scheduling; Spark uses full data and extended storage.
  const { extended, ...preset } = PRESETS[spark ? 'spark' : 'gsl'];
  const options = { renderer, ...preset, autoUpdate: false, ...(spark ? { accumExtSplats: extended } : {}) };
  const gs = new (spark ? lib.SparkRenderer : lib.GaussianSplatRenderer)(options);
  scene.add(gs);
  const start = performance.now();
  const mesh = new lib.SplatMesh({
    url: `/models/${model}.${format}`,
    extSplats: true,
    onProgress: e => (window.progress = { loaded: e.loaded, total: e.total, stage: e.stage }),
  });
  scene.add(mesh);
  await mesh.initialized;
  const loadMs = performance.now() - start;
  if (spark && (!mesh.extSplats || mesh.packedSplats || !gs.accumExtSplats))
    throw Error('Spark source or accumulator is not ExtSplats');
  let variant = 'sorted';
  const jobs = [];
  if (!gpu) {
    const original = gs.driveSort.bind(gs);
    gs.driveSort = (...args) => {
      const started = !gs.sorting && gs.sortDirty,
        t = performance.now();
      const result = original(...args);
      if (!started) return result;
      return Promise.resolve(result).then(v => {
        jobs.push({ ms: performance.now() - t, at: performance.now() });
        return v;
      });
    };
  }
  const api = {
    kind: mode,
    renderer,
    device,
    gl,
    canvas: renderer.domElement,
    gs,
    mesh,
    camera,
    scene,
    loadMs,
    count: mesh.numSplats,
    sh: (mesh.extSplats ?? mesh.splats).getNumSh(),
    setView(position, quaternion) {
      camera.position.fromArray(position);
      camera.quaternion.fromArray(quaternion);
      camera.updateMatrixWorld();
    },
    async update() {
      await gs.update({ scene, camera });
      while (gs.sorting || gs.updateRunning) await sleep(1);
    },
    setAuto(value) {
      gs.autoUpdate = value;
    },
    draw() {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    roots() {
      return { mesh, gs };
    },
    async setVariant(value, fast = true) {
      gs.autoUpdate = false;
      while (gs.sorting || gs.updateRunning) await sleep(1);
      variant = value;
      gs.setDirty();
      if (gpu) gs.backend.projection.projectedInputs = [];
      if (!spark) {
        gs.fastSort = fast;
        gs.stochastic = value === 'stochastic';
      }
    },
    // GSL WebGPU submits projection and radix together; split them so timestamps isolate the sort.
    sortProbe(enabled) {
      if (!gpu) return;
      if (!api.originalCompute) api.originalCompute = renderer.compute.bind(renderer);
      renderer.compute = enabled
        ? (nodes, ...args) => {
            if (!Array.isArray(nodes)) return api.originalCompute(nodes, ...args);
            const i = nodes.findIndex(n => /radix|prefix|scatter|histogram/i.test(n.name));
            if (i < 0) return api.originalCompute(nodes, ...args);
            timer.stage = 'projection';
            if (i > 0) api.originalCompute(nodes.slice(0, i), ...args);
            timer.stage = 'sort';
            api.originalCompute(nodes.slice(i), ...args);
            timer.stage = null;
          }
        : api.originalCompute;
    },
    jobs: () => jobs,
    state() {
      return {
        variant,
        workingColorSpace: THREE.ColorManagement.workingColorSpace,
        outputColorSpace: renderer.outputColorSpace,
        spatialResolve: false,
        temporalResolve: null,
        fastSort: spark ? null : gs.fastSort,
        sourceType: spark ? mesh.extSplats.constructor.name : 'Splats',
        shStorage: spark
          ? { kind: 'per-splat', sourceType: mesh.extSplats.constructor.name }
          : {
              kind: mesh.splats.palette ? 'shared-codebook' : 'per-splat',
              paletteBytes: mesh.splats.palette?.byteLength ?? 0,
              labelBytes: (mesh.splats.splatExtra ?? mesh.splats.extra)?.shLabels?.byteLength ?? 0,
              paletteStride: mesh.splats.palette?.stride ?? 0,
            },
        accumulatorExtended: spark ? gs.accumExtSplats : true,
        stochastic: spark ? false : gs.stochasticActive,
        stochasticSort: spark ? null : gs.stochasticSort,
        sortBits: spark ? 32 : gs.stochasticActive && gs.stochasticSort ? 16 : gs.fastSort ? 24 : 32,
        sortRadial: gs.sortRadial,
        lodEnabled: spark ? gs.enableLod : null,
        hasLodData: spark ? !!mesh.extSplats.lodSplats : null,
        renderParameters: Object.fromEntries(
          [
            'minPixelRadius',
            ...(spark ? ['maxPixelRadius'] : []),
            'minAlpha',
            'preBlurAmount',
            'blurAmount',
            'clipXY',
            'focalAdjustment',
            'maxStdDev',
            'minSortIntervalMs',
          ].map(k => [k, gs[k]]),
        ),
        deviceConfiguration: gpu ? 'three-default' : null,
        deviceFeatures: device ? [...device.features].sort() : null,
        compatibilityMode: renderer.backend?.compatibilityMode ?? null,
        reversedDepthBuffer: renderer.reversedDepthBuffer ?? renderer.capabilities?.reversedDepthBuffer ?? false,
        preserveDrawingBuffer: gl?.getContextAttributes().preserveDrawingBuffer ?? null,
        active: gs.activeSplats,
        backend: gpu ? 'webgpu' : 'webgl2',
        sourceCount: mesh.numSplats,
        sh: api.sh,
      };
    },
    async visible() {
      return gpu
        ? new Uint32Array(await renderer.getArrayBufferAsync(gs.backend.projection.visibleCount))[0]
        : gs.activeSplats;
    },
  };
  return api;
}
