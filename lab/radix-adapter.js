import * as THREE from 'three';

export async function createRadix(lib, gpu, canvas, camera, url, filename, size, settings, loaded) {
  // Radix blends in linear space through a framebuffer target whenever the working space differs from the
  // sRGB output; keep both sRGB so WebGPU and WebGL2 blend in sRGB like the other renderers.
  THREE.ColorManagement.workingColorSpace = THREE.SRGBColorSpace;
  const renderer = await lib.createRenderer({
    canvas,
    backend: gpu ? 'webgpu' : 'webgpu-gl',
    antialias: false,
    hdr: false,
    limits: { maxBufferSize: 'adapter', maxStorageBufferBindingSize: 'adapter' },
  });
  if (lib.getGpuCaps(renderer).backend !== (gpu ? 'webgpu' : 'webgpu-gl'))
    throw Error('Requested Radix backend unavailable');
  renderer.setPixelRatio(1);
  renderer.setSize(size.width, size.height, false);
  renderer.setClearColor(0x101418, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const start = performance.now();
  const data = await lib.loadSplats(url, { name: filename, layout: 'extSplats' });
  const arrays = lib.GpuArrays.fromData(renderer, data);
  const collection = new lib.SplatCollection([lib.SplatCollection.arrays(arrays)]);
  const gs = new lib.SplatRenderer({ renderer, collection, ...settings, sortMode: gpu ? 'gpu' : 'cpu' });
  const scene = new THREE.Scene();
  scene.add(gs);
  const loadMs = performance.now() - start;
  const box = new THREE.Box3(),
    point = new THREE.Vector3();
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
    bounds: {
      center: box.getCenter(new THREE.Vector3()).toArray(),
      radius: box.getSize(new THREE.Vector3()).length() / 2,
    },
    info: {
      sortMetric: 'radial-distance',
      version: loaded.version,
      moduleURL: loaded.moduleURL,
      backend: gpu ? 'WebGPU' : 'WebGL2',
      three: THREE.REVISION,
      settings: {
        method: gs.method,
        sortBits: gs.sortBits,
        params: { ...gs.params },
        objectParams: { ...gs.objectParams },
        sourceType: 'extSplats',
        sortMode: gs.sortMode,
      },
      workingColorSpace: THREE.ColorManagement.workingColorSpace,
      outputColorSpace: renderer.outputColorSpace,
    },
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
    },
  };
}
