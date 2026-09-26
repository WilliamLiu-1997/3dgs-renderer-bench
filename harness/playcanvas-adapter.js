import * as pc from './node_modules/playcanvas/build/playcanvas.mjs';
import { PRESETS } from './dist/lab-config.js';
import { sleep } from './timer.js';

export async function createPlayCanvas(config, mode, model, onDevice) {
 const gpu = mode === 'pc-gpu';
 const canvas = document.createElement('canvas');
 document.body.append(canvas);
 const graphics = await pc.createGraphicsDevice(canvas, { deviceTypes: [gpu ? 'webgpu' : 'webgl2'], antialias: false, depth: true, stencil: false });
 if (graphics.isWebGPU !== gpu) throw Error('Requested PlayCanvas backend unavailable');
 const device = gpu ? graphics.wgpu : null;
 if (device) {
  const timer = onDevice(device), dispatch = graphics.computeDispatch.bind(graphics);
  let sortingDispatch = false;
  graphics.computeDispatch = (computes, name) => {
   sortingDispatch = /RadixSort4bit|OneSweep/.test(name) || (sortingDispatch && /PrefixSum/.test(name));
   timer.stage = sortingDispatch ? 'sort' : 'projection';
   try { return dispatch(computes, name); } finally { timer.stage = null; }
  };
 }
 graphics.maxPixelRatio = 1;
 graphics.resizeCanvas(config.width, config.height);
 const app = new pc.Application(canvas, { graphicsDevice: graphics });
 app.autoRender = false;
 const params = app.scene.gsplat;
 Object.assign(params, PRESETS.playcanvas, { dataFormat: 'large', stochastic: false });
 params.renderer = gpu ? pc.GSPLAT_RENDERER_RASTER_GPU_SORT : pc.GSPLAT_RENDERER_RASTER_CPU_SORT;
 if (params.currentRenderer !== params.renderer) throw Error('PlayCanvas sorting backend mismatch');
 const camera = new pc.Entity('Shared camera');
 camera.addComponent('camera', { fov: 45, nearClip: .1, farClip: 3000, horizontalFov: false, aspectRatioMode: pc.ASPECT_MANUAL, aspectRatio: config.width / config.height, clearColor: new pc.Color(16/255,20/255,24/255,1), toneMapping: pc.TONEMAP_LINEAR });
 app.root.addChild(camera);
 const start = performance.now();
 const asset = await new Promise((resolve, reject) => app.assets.loadFromUrlAndFilename('/models/'+model+'.ply', model+'.ply', 'gsplat', (error, value) => error ? reject(Error(String(error))) : resolve(value)));
 const loadMs = performance.now() - start;
 const entity = new pc.Entity('Full model');
 entity.addComponent('gsplat', { asset });
 app.root.addChild(entity);
 let dirty = true, view = '', active = null;
 const jobs = () => metrics.rpc.filter(r => r.name === 'sortPlayCanvas').map(r => ({ ms: r.roundTripMs, at: r.at }));
 const draw = () => { app.update(1/60); app.render(); };
 app.scene.on('gsplat:sorted', () => { active = asset.resource.numSplats; });
 return {
  canvas, device, gl: gpu ? null : graphics.gl, loadMs, count: asset.resource.numSplats,
  setView(position, quaternion) {
   const next = [...position,...quaternion].join(','); dirty ||= next !== view; view = next;
   camera.setPosition(...position); camera.setRotation(...quaternion);
  },
  async update() {
   if (gpu || !dirty) return;
   const before = jobs().length, start = performance.now();
   do { draw(); await sleep(5); if (performance.now()-start > 30000) throw Error('PlayCanvas initial sort timed out'); } while(jobs().length === before);
   draw(); dirty = false;
  },
  draw, jobs,
  async setVariant(variant) {
   if (variant !== 'sorted' && !(gpu && variant === 'stochastic')) throw Error('Unsupported PlayCanvas variant: '+variant);
   params.stochastic = variant === 'stochastic';
  },
  roots: () => ({ resource: asset.resource }),
  // Count readback would add GPU work; leave unavailable rather than report source count as survivors.
  visible: async () => active,
  state: () => ({ backend: gpu ? 'webgpu' : 'webgl2', sourceCount: asset.resource.numSplats, sh: asset.resource.shBands, stochastic: params.stochastic, dither: params.dither, spatialResolve: false, temporalResolve: false, sortRadial: params.radialSorting, dataFormat: params.dataFormat, sorting: params.stochastic ? 'none' : gpu ? 'GPU' : 'CPU Worker', renderParameters: Object.fromEntries([...Object.keys(PRESETS.playcanvas),'dataFormat'].map(k => [k,params[k]])), deviceFeatures: device ? [...device.features].sort() : null })
 };
}
