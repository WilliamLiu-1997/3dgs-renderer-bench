import * as pc from 'playcanvas';
import {UrlReadFileSystem} from '@playcanvas/splat-transform';
import {PCApp} from '../vendor/supersplat/src/pc-app';
import {ProjectedSplatRenderer} from '../vendor/supersplat/src/projected-splat-renderer';
import {EditorSplatResource} from '../vendor/supersplat/src/editor-splat-resource';
import {GaussianInstances} from '../vendor/supersplat/src/gaussian-instances';
import {TransformPalette} from '../vendor/supersplat/src/transform-palette';
import {ColorPalette} from '../vendor/supersplat/src/color-palette';
import {loadSplatSource} from '../vendor/supersplat/src/io/read/loader';
import {ShaderQuad,SimpleRenderPass} from '../vendor/supersplat/src/utils/simple-render-pass';
import {vertexShader,fragmentShader} from '../vendor/supersplat/src/shaders/blit-shader';
import {fragmentShader as resolveShader} from '../vendor/supersplat/src/shaders/stochastic-warp-resolve-shader';

export async function createSuperSplat(config,model,onDevice){
 const canvas=document.createElement('canvas');document.body.append(canvas);
 // PlayCanvas requests the adapter's available timestamp-query feature itself.
 const gd=await pc.createGraphicsDevice(canvas,{deviceTypes:['webgpu'],antialias:false,depth:true,stencil:false});
 if(!gd.isWebGPU)throw Error('SuperSplat did not select WebGPU');
 gd.maxPixelRatio=config.dpr;gd.resizeCanvas(config.logicalWidth,config.logicalHeight);
 const device=(gd as any).wgpu;onDevice(device);
 const app=new PCApp(canvas,{graphicsDevice:gd});app.autoRender=false;
 const splatLayer=new pc.Layer({name:'Benchmark splats'}),centersLayer=new pc.Layer({name:'Disabled centers'});
 const layers=new pc.LayerComposition();layers.push(splatLayer);layers.push(centersLayer);app.scene.layers=layers;
 const camera=new pc.Entity('benchmark camera');app.root.addChild(camera);camera.addComponent('camera',{fov:45,horizontalFov:false,aspectRatioMode:pc.ASPECT_MANUAL,aspectRatio:config.width/config.height,nearClip:.1,farClip:3000,clearColor:new pc.Color(0,0,0,1),layers:[splatLayer.id],toneMapping:pc.TONEMAP_LINEAR});
 const transparent=new pc.Color(0,0,0,0);
 const settings={selection:null,selectedClr:transparent,unselectedClr:transparent,lockedClr:transparent,'view.bands':3,'view.minPixelSize':2,'view.centerSize':0,'view.editView':false,'view.gaussians':true,'view.splatsColorBlend':0,'view.ringsColorBlend':0};
 const events={invoke:(name)=>settings[name]??false,function:(name,fn)=>settings[name]=fn};
 const scene:any={graphicsDevice:gd,app,splatLayer,centersLayer,events,targetSize:{width:config.width,height:config.height},camera:{camera:camera.camera,mainCamera:camera,renderOverlays:false},movingRender:false,overdrawRender:false,warpedRender:false,editedRender:false,underlay:{enabled:false},stochastic:{resolve:false,warpStrength:1}};
 const projected:any=new ProjectedSplatRenderer(scene);scene.projectedSplatRenderer=projected;
 const loadStart=performance.now();
 const loaded=await loadSplatSource(model+'.ply',new UrlReadFileSystem(location.origin+'/models/'));
 const resource=await EditorSplatResource.create(gd,loaded.source,loaded.reorder);
 const instances=new GaussianInstances(gd,resource.numRows,resource.initialState);instances.flush();
 const splatEntity=new pc.Entity('splat source');app.root.addChild(splatEntity);
 // Keep raw PLY coordinates, exactly as the Three.js adapters do.
 const splat={uid:'benchmark',resource,instances,entity:splatEntity,visible:true,selectionAlpha:1,transformPalette:new TransformPalette(gd),colorPalette:new ColorPalette(gd)};
 projected.add(splat as any);
 const loadMs=performance.now()-loadStart;
 function texture(name,format){return new pc.Texture(gd,{name,width:config.width,height:config.height,format,mipmaps:false,minFilter:pc.FILTER_NEAREST,magFilter:pc.FILTER_NEAREST,addressU:pc.ADDRESS_CLAMP_TO_EDGE,addressV:pc.ADDRESS_CLAMP_TO_EDGE});}
 const color=texture('benchmark color',pc.PIXELFORMAT_RGBA16F),work=texture('SuperSplat work',pc.PIXELFORMAT_RGBA8),depth=texture('benchmark depth',pc.PIXELFORMAT_DEPTH);
 const rt=new pc.RenderTarget({colorBuffers:[color,work],depthBuffer:depth,samples:1,autoResolve:false});
 const stochasticColor=texture('SuperSplat stochastic',pc.PIXELFORMAT_RGBA8);
 stochasticColor.minFilter=pc.FILTER_LINEAR;stochasticColor.magFilter=pc.FILTER_LINEAR;
 const stochasticRT=new pc.RenderTarget({colorBuffers:[stochasticColor,work],depthBuffer:depth,samples:1,autoResolve:false});
 scene.camera.mainTarget=rt;
 const depthReduce=new pc.RenderPass(gd);depthReduce.name='SuperSplat depth reduce';depthReduce.execute=()=>projected.reduceDepth();
 const colorTarget=new pc.RenderTarget({colorBuffer:color,depth:false,autoResolve:false});
 const raster=new pc.RenderPassForward(gd,layers,app.scene,app.renderer);raster.name='SuperSplat raster';raster.init(rt);raster.setClearColor(new pc.Color(0,0,0,1));raster.setClearDepth(1);raster.addLayer(camera.camera,splatLayer,false,true);raster.addLayer(camera.camera,splatLayer,true,false);
 const blit=new SimpleRenderPass(gd,new ShaderQuad(gd,vertexShader,fragmentShader,'benchmark blit'),{vars:()=>({srcTexture:color,blitScale:[1,1],overdraw:0})});blit.name='SuperSplat present';blit.init(null);
 const resolve=new SimpleRenderPass(gd,new ShaderQuad(gd,vertexShader,resolveShader,'benchmark stochastic resolve'),{blendState:new pc.BlendState(true,pc.BLENDEQUATION_ADD,pc.BLENDMODE_ONE,pc.BLENDMODE_ONE_MINUS_SRC_ALPHA),vars:()=>({srcTexture:stochasticColor,warpStrength:0,quadResolve:variant==='stochastic-resolved'?1:0})});resolve.name='SuperSplat spatial resolve';resolve.init(colorTarget);resolve.setClearColor(new pc.Color(0,0,0,1));
 camera.camera.framePasses=[raster,depthReduce,blit];
 app.on('prerender',()=>projected.render());
 let variant='sorted';
 const sourceSort=projected.sorter.sortIndirect.bind(projected.sorter);
 return {kind:'supersplat',canvas,device,gd,app,camera,projected,resource,splat,loadMs,count:resource.numSplats,sh:resource.shBands,
  setView(position,quaternion){camera.setPosition(...position);camera.setRotation(...quaternion);},
  update(){},
  draw(){app.update(1/60);app.render();},
  afterFrame(row){if(scene.movingRender)projected.reportStochasticFrame(row.gpuMs);},
  roots(){return {resource,instances,splat,projected,rt,stochasticRT,colorTarget};},
  async setVariant(value){variant=value;scene.movingRender=value.startsWith('stochastic');raster.init(scene.movingRender?stochasticRT:rt);raster.setClearColor(new pc.Color(0,0,0,scene.movingRender?0:1));camera.camera.framePasses=scene.movingRender?[raster,depthReduce,resolve,blit]:[raster,depthReduce,blit];},
  sortProbe(timer){projected.sorter.sortIndirect=(...args)=>{timer.stage='sort';try{return sourceSort(...args);}finally{timer.stage=null;}};},
  state(){return {variant,sourceCount:resource.numSplats,sh:resource.shBands,backend:'webgpu',sortBits:20,sortRadial:false,renderParameters:{minPixelSize:settings['view.minPixelSize'],motionBudgetMs:projected.motionBudgetMs,occlusionCull:projected.occlusionCull},stochastic:scene.movingRender,stats:projected.stats,fullDetail:!scene.movingRender,sortedTarget:'rgba16float',stochasticTarget:'rgba8unorm',stochasticFilter:'linear',stochasticResolveTarget:'rgba16float'};},
  async visible(){return (await projected.splatCounter.read(0,8,new Uint32Array(2),true))[0];}
 };
}
