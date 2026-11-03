export async function createViewerAdapter(lib, pc, canvas, commonCamera, url, filename, size, settings, loaded) {
  const { defaultSettings } = await import(new URL('settings.js', loaded.moduleURL).href);
  const experience = defaultSettings();
  experience.tonemapping = 'none';
  experience.background.color = [16 / 255, 20 / 255, 24 / 255];
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  canvas.replaceWith(container);
  const start = performance.now();
  const viewer = await lib.createViewer({
    container,
    settings: experience,
    contentUrl: url,
    contentFilename: filename,
    renderer: 'webgpu',
    ui: false,
    nofx: true,
    hpr: false,
    noanim: true,
    aa: false,
    stochastic: 'off',
    framesInFlight: 1,
  });
  const { app } = viewer;
  if (!app.graphicsDevice.isWebGPU) {
    viewer.destroy();
    throw Error('SuperSplat Viewer WebGPU unavailable; fallback is disabled');
  }
  const device = app.graphicsDevice;
  canvas = device.canvas;
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  device.maxPixelRatio = 1;
  const resize = () => device.resizeCanvas(size.width, size.height);
  app.on('framerender', resize);
  resize();
  viewer.state.inputEnabled = false;
  viewer.state.performanceMode = false;
  viewer.state.quality = 'max';
  const params = app.scene.gsplat;
  Object.assign(params, settings, {
    dataFormat: 'large',
    stochastic: false,
    renderer: pc.GSPLAT_RENDERER_RASTER_GPU_SORT,
  });
  if (!viewer.state.loaded) await new Promise(resolve => viewer.events.once('loaded:changed', resolve));
  const loadMs = performance.now() - start;
  Object.assign(params, settings);
  // The lab drives updates and draws; the viewer's RAF also resizes the canvas.
  cancelAnimationFrame(app.frameRequestId);
  app.frameRequestId = null;
  app.autoRender = false;
  app.off('framerender', resize);
  const component = app.root.findComponents('gsplat')[0];
  component.entity.setLocalEulerAngles(0, 0, 0);
  const asset = app.assets.get(component.asset);
  const camera = app.root.findComponents('camera')[0];
  const syncCamera = () => {
    camera.entity.setPosition(commonCamera.position.x, commonCamera.position.y, commonCamera.position.z);
    camera.entity.setRotation(
      commonCamera.quaternion.x,
      commonCamera.quaternion.y,
      commonCamera.quaternion.z,
      commonCamera.quaternion.w,
    );
    camera.fov = commonCamera.fov;
    camera.horizontalFov = false;
    camera.aspectRatioMode = pc.ASPECT_MANUAL;
    camera.aspectRatio = size.width / size.height;
    camera.nearClip = commonCamera.near;
    camera.farClip = commonCamera.far;
    camera.toneMapping = pc.TONEMAP_LINEAR;
  };
  const { center, halfExtents } = asset.resource.aabb;
  return {
    canvas,
    app,
    viewer,
    loadMs,
    count: asset.resource.numSplats,
    sh: asset.resource.shBands,
    bounds: { center: [center.x, center.y, center.z], radius: halfExtents.length() },
    info: {
      version: loaded.version,
      moduleURL: loaded.moduleURL,
      engineVersion: pc.version,
      engineCommit: pc.revision,
      backend: 'WebGPU',
      settings: {
        ...Object.fromEntries(Object.keys(settings).map(key => [key, params[key]])),
        dataFormat: params.dataFormat,
        stochastic: false,
        postEffects: false,
      },
      loadMetric: 'viewer first frame',
      frameLoop: 'explicit viewer updates and renders',
    },
    draw(dt) {
      app.update(dt);
      syncCamera();
      app.render();
    },
    dispose() {
      viewer.destroy();
      container.remove();
    },
  };
}
