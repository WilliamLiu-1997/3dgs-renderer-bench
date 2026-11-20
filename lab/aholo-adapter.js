// Aholo Viewer (WebGL2). The npm package has no public WebGPU renderer.
export async function createAholo(lib, canvas, commonCamera, url, filename, size, settings, loaded) {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  canvas.replaceWith(container);
  const viewer = lib.createViewer('bench', container, {
    antialiasing: false,
    alpha: false,
    preserveDrawingBuffer: false,
  });
  // The drawing buffer is the requested size times devicePixelRatio times pixelRatio.
  const pipeline = {
    MSAA: { enabled: false },
    TAA: { enabled: false },
    AO: { enabled: false },
    Background: {
      background: {
        active: lib.BackgroundMode.BasicBackground,
        basic: { color: new lib.Color(16 / 255, 20 / 255, 24 / 255) },
      },
      ground: { enabled: false },
    },
    Splatting: { enabled: true, composite: { enabled: false }, ...settings },
  };
  lib.setViewerConfig(viewer, { pixelRatio: 1 / devicePixelRatio, pipeline });
  // setViewerConfig only logs unknown paths and rejected values, so read every setting back.
  const cells = viewer.config.effects.__INTERNAL__;
  (function verify(values, config, path) {
    for (const [key, value] of Object.entries(values)) {
      const cell = config?.[key];
      if (cell === undefined) throw Error(`Aholo Viewer has no setting ${path}${key}`);
      if (typeof cell.get !== 'function') verify(value, cell, `${path}${key}.`);
      else if (typeof value !== 'object' && cell.get() !== value)
        throw Error(`Aholo Viewer ${path}${key} is ${cell.get()}, not ${value}`);
    }
  })(pipeline, cells, '');
  viewer.resize({ width: size.width, height: size.height });
  canvas = container.querySelector('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  if (canvas.width !== size.width || canvas.height !== size.height)
    throw Error(`Aholo Viewer drawing buffer is ${canvas.width}x${canvas.height}`);
  const gl = canvas.getContext('webgl2');
  if (!gl || viewer.rendererBackend !== 'WEBGL2_JS') throw Error('Aholo Viewer WebGL2 unavailable');
  // Render every requested frame; the viewer otherwise skips frames it considers unchanged.
  viewer.config.forceFrameIsUnstable.set(true);

  const { SplatLoader, SplatUtils } = lib;
  const sog = /\.sog$/i.test(filename);
  const start = performance.now();
  const data = await SplatLoader.parseSplatData(
    sog ? SplatLoader.SplatFileType.SOG : SplatLoader.SplatFileType.PLY,
    url,
    SplatLoader.SplatPackType.Compressed,
    { maxShDegree: 3, stream: false },
  );
  const box = new lib.Box3();
  const position = new lib.Vector3();
  for (let index = 0; index < data.counts; index++) {
    data.getCenter(index, position);
    box.expandByPoint(position);
  }
  const { center, radius } = box.getBoundingSphere(new lib.Sphere());
  data.stream = {};
  const splat = await SplatUtils.createSplat(data, viewer._getEngine().renderer);
  splat.autoFreeResourceOnGpuPacked = true;
  viewer.getScene().add(splat);
  const camera = new lib.PerspectiveCamera(
    commonCamera.fov,
    size.width / size.height,
    commonCamera.near,
    commonCamera.far,
  );
  viewer.setCamera(camera);
  const syncCamera = () => {
    camera.position.set(commonCamera.position.x, commonCamera.position.y, commonCamera.position.z);
    const q = commonCamera.quaternion;
    camera.quaternion.set(q.x, q.y, q.z, q.w);
    camera.updateMatrixWorld(true);
  };
  // Load ends at the first frame drawn after the first sort with none in flight.
  let sorted = false;
  splat.once(lib.Events.SplatSortedEvent, () => (sorted = true));
  syncCamera();
  const deadline = performance.now() + 600000;
  do {
    viewer.render();
    await new Promise(resolve => setTimeout(resolve, 1));
    if (performance.now() > deadline) throw Error('Aholo Viewer did not finish its first sort');
  } while (!sorted || !splat.isRenderingStability);
  const loadMs = performance.now() - start;

  return {
    canvas,
    gl,
    viewer,
    splat,
    data,
    loadMs,
    count: data.counts,
    sh: data.shDegree,
    bounds: { center: center.toArray(), radius },
    info: {
      version: loaded.version,
      moduleURL: loaded.moduleURL,
      backend: 'WebGL2',
      sortMetric: cells.Splatting.sort.radial.get() ? 'radial-distance' : 'view-depth',
      shStorage: { kind: 'per-splat', sourceType: splat.PackType },
      settings: {
        packType: 'Compressed',
        ...Object.fromEntries(
          Object.entries(settings).map(([group, values]) => [
            group,
            Object.fromEntries(Object.keys(values).map(key => [key, cells.Splatting[group][key].get()])),
          ]),
        ),
      },
      loadMetric: 'first sorted frame',
      frameLoop: 'explicit viewer renders',
    },
    draw() {
      syncCamera();
      viewer.render();
    },
    dispose() {
      viewer.getScene().remove(splat);
      splat.destroy();
      viewer.destroy();
      container.remove();
    },
  };
}
