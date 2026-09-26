import * as THREE from 'three';
import { PACKAGES, exactVersion } from './config.js';

export async function loadLibrary(key, version) {
  if (!exactVersion(version)) throw Error('Enter an exact version, e.g. 2.23.0-beta.19');
  const pkg = PACKAGES[key];
  const base = version === pkg.version ? new URL(`../vendor/${key}/`, import.meta.url).href : `https://cdn.jsdelivr.net/npm/${pkg.name}@${version}/`;
  // Published package metadata chooses the ESM entry; no source rewriting or CDN transpilation.
  const response = await fetch(base + 'package.json');
  if (!response.ok) throw Error(`${pkg.name}@${version} could not be loaded (${response.status})`);
  const metadata = await response.json();
  if (metadata.version !== version) throw Error('Loaded version does not match the selection');
  const entry = metadata.module;
  if (!entry || typeof entry !== 'string') throw Error('This version has no loadable ESM entry');
  const lib = await import(/* @vite-ignore */ new URL(entry, base).href);
  return { lib, version: metadata.version, moduleURL: new URL(entry, base).href, peerDependencies: metadata.peerDependencies ?? {} };
}

function requireFields(object, values) {
  for (const key of Object.keys(values)) {
    if (!(key in object)) throw Error(`This version does not expose ${key}. Select another version.`);
  }
}

export async function createAdapter(backend, versions, settings, canvas, camera, file, size) {
  const loaded = await loadLibrary(backend.lib, versions[backend.lib]);
  const { lib } = loaded;
  const gpu = backend.backend === 'WebGPU';
  if (gpu && !navigator.gpu) throw Error('WebGPU is unavailable in this browser or device');
  const url = URL.createObjectURL(file);
  try {
    if (backend.lib === 'playcanvas') return await createPlayCanvas(lib, gpu, canvas, camera, url, file.name, size, settings, loaded);
    return await createThree(lib, backend.lib === 'spark', gpu, canvas, camera, url, file.name, size, settings, loaded);
  } finally { URL.revokeObjectURL(url); }
}

async function createThree(lib, spark, gpu, canvas, camera, url, filename, size, settings, loaded) {
  THREE.ColorManagement.workingColorSpace = gpu ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  const options = { canvas, antialias: false, alpha: false, powerPreference: 'high-performance', ...(spark ? {} : { reversedDepthBuffer: true }) };
  let renderer;
  if (gpu) {
    const { WebGPURenderer } = await import('three/webgpu');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw Error('No WebGPU adapter available');
    renderer = new WebGPURenderer({ ...options, requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
    await renderer.init();
    // Standard canvas API verifies the actual context without reading private backend state.
    if (!canvas.getContext('webgpu')) throw Error('WebGPU initialization failed. WebGL fallback is disabled.');
    renderer.onDeviceLost = info => { if (info.reason !== 'destroyed') window.dispatchEvent(new ErrorEvent('error', { message: `WebGPU device lost: ${info.message}` })); };
  } else renderer = new THREE.WebGLRenderer(options);
  if (!gpu) renderer.debug.onShaderError = () => { throw Error('WebGL shader compilation failed for these versions'); };
  renderer.setPixelRatio(1);
  renderer.setSize(size.width, size.height, false);
  renderer.setClearColor(0x101418, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const { extended, ...params } = settings;
  const Constructor = spark ? lib.SparkRenderer : lib.GaussianSplatRenderer;
  if (!Constructor) throw Error('This version lacks the required public renderer API');
  const gs = new Constructor({ renderer, ...params, ...(spark ? { accumExtSplats: extended } : { autoStochastic: false }) });
  requireFields(gs, params);
  if (spark) requireFields(gs, { accumExtSplats: extended });
  scene.add(gs);
  const start = performance.now();
  const mesh = new lib.SplatMesh({ url, fileName: filename, ...(spark ? { extSplats: extended } : {}) });
  scene.add(mesh);
  await mesh.initialized;
  const loadMs = performance.now() - start;
  if (spark && extended && !mesh.extSplats) throw Error('This version did not load the requested ExtSplats source');
  const box = mesh.getBoundingBox();
  const bounds = { center: box.getCenter(new THREE.Vector3()).toArray(), radius: box.getSize(new THREE.Vector3()).length() / 2 };
  return {
    loadMs, bounds, count: mesh.numSplats,
    info: { version: loaded.version, moduleURL: loaded.moduleURL, peerDependencies: loaded.peerDependencies, backend: gpu ? 'WebGPU' : 'WebGL2', three: THREE.REVISION, settings: { ...Object.fromEntries(Object.keys(params).map(k => [k, gs[k]])), ...(spark ? { extended: gs.accumExtSplats, sourceType: mesh.extSplats ? 'ExtSplats' : 'PackedSplats' } : { autoStochastic: false }) }, workingColorSpace: THREE.ColorManagement.workingColorSpace, outputColorSpace: renderer.outputColorSpace },
    async prepare() {
      // GSL's public update waits for its initial WebGPU compute nodes.
      if (!spark && gpu) await gs.update({ scene, camera });
    },
    draw() { renderer.render(scene, camera); },
    async dispose() { mesh.dispose(); gs.dispose(); await renderer.dispose(); if (!gpu) renderer.forceContextLoss(); },
  };
}

async function createPlayCanvas(pc, gpu, canvas, commonCamera, url, filename, size, settings, loaded) {
  if (gpu && pc.GSPLAT_RENDERER_RASTER_GPU_SORT === undefined) throw Error('This PlayCanvas version lacks a public GSplat GPU sorting path');
  const device = await pc.createGraphicsDevice(canvas, { deviceTypes: [gpu ? 'webgpu' : 'webgl2'], antialias: false, depth: true, stencil: false });
  if (gpu !== device.isWebGPU) { device.destroy(); throw Error('The requested backend is unavailable. Fallback is disabled.'); }
  device.maxPixelRatio = 1;
  device.resizeCanvas(size.width, size.height);
  const app = new pc.Application(canvas, { graphicsDevice: device });
  app.autoRender = false;
  const params = app.scene.gsplat;
  requireFields(params, { renderer: null, currentRenderer: null });
  const common = { ...settings, dataFormat: 'large' };
  requireFields(params, common);
  Object.assign(params, common);
  if ('stochastic' in params) params.stochastic = false;
  device.on('devicelost', () => window.dispatchEvent(new ErrorEvent('error', { message: 'PlayCanvas graphics device lost' })));
  params.renderer = gpu ? pc.GSPLAT_RENDERER_RASTER_GPU_SORT : pc.GSPLAT_RENDERER_RASTER_CPU_SORT;
  if (params.currentRenderer !== params.renderer) throw Error('The selected GSplat sorting backend was not activated');
  const camera = new pc.Entity('Shared camera');
  camera.addComponent('camera', { fov: commonCamera.fov, horizontalFov: false, aspectRatioMode: pc.ASPECT_MANUAL, aspectRatio: size.width / size.height, clearColor: new pc.Color(16 / 255, 20 / 255, 24 / 255, 1), toneMapping: pc.TONEMAP_LINEAR });
  app.root.addChild(camera);
  const start = performance.now();
  const asset = await new Promise((resolve, reject) => app.assets.loadFromUrlAndFilename(url, filename, 'gsplat', (error, value) => error ? reject(Error(String(error))) : resolve(value)));
  const loadMs = performance.now() - start;
  const entity = new pc.Entity('Local model');
  entity.addComponent('gsplat', { asset });
  app.root.addChild(entity);
  const { center, halfExtents } = asset.resource.aabb;
  return {
    loadMs, count: asset.resource.numSplats, bounds: { center: [center.x, center.y, center.z], radius: halfExtents.length() },
    info: { version: loaded.version, moduleURL: loaded.moduleURL, backend: gpu ? 'WebGPU' : 'WebGL2', settings: { ...Object.fromEntries(Object.keys(common).map(k => [k, params[k]])) }, sorting: gpu ? 'GPU' : 'CPU Worker', outputColorSpace: 'sRGB / linear tone mapping' },
    beforeDraw() {
      camera.setPosition(commonCamera.position.x, commonCamera.position.y, commonCamera.position.z);
      camera.setRotation(commonCamera.quaternion.x, commonCamera.quaternion.y, commonCamera.quaternion.z, commonCamera.quaternion.w);
      camera.camera.fov = commonCamera.fov;
      camera.camera.nearClip = commonCamera.near;
      camera.camera.farClip = commonCamera.far;
    },
    draw(dt) {
      app.update(dt);
      app.render();
    },
    dispose() { app.destroy(); },
  };
}
