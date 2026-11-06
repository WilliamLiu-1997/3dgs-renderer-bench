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
  const start = performance.now();
  // A Worker streams the file in chunks, so it needs an absolute URL. Compressed is the highest-precision
  // pack the renderer accepts.
  const data = await SplatLoader.parseSplatData(
    SplatLoader.SplatFileType.PLY,
    new URL(url, location.href).href,
    SplatLoader.SplatPackType.Compressed,
    { maxShDegree: 3, retainData: false },
  );
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  // Compressed's first sampler stores xyz in the first three of four 32-bit words per splat.
  // Scan chunks before upload releases them, excluding texture padding after the last splat.
  const expandBounds = (source, offset = 0) => {
    const centers = new Float32Array(source.buffer, source.byteOffset, source.byteLength / 4);
    const count = Math.min(centers.length / 4, data.counts - offset / 16);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], centers[i * 4 + k]);
        max[k] = Math.max(max[k], centers[i * 4 + k]);
      }
  };
  if (data.stream) {
    const readChunks = data.readChunks.bind(data);
    data.readChunks = (consume, release) =>
      readChunks(async chunk => {
        for (const { index, offset, source } of chunk.samplers) if (index === 0) expandBounds(source, offset);
        await consume(chunk);
      }, release);
  } else expandBounds(data.serialize().samplers[0].source);
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

  const center = min.map((v, k) => (v + max[k]) / 2);
  const radius = Math.hypot(...max.map((v, k) => v - min[k])) / 2;

  return {
    canvas,
    gl,
    viewer,
    splat,
    data,
    loadMs,
    count: data.counts,
    sh: data.shDegree,
    bounds: { center, radius },
    info: {
      version: loaded.version,
      moduleURL: loaded.moduleURL,
      backend: 'WebGL2',
      sortMetric: 'view-depth',
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
