import * as THREE from 'three';
import {WebGPURenderer} from 'three/webgpu';
import {sleep,fenceGL} from './timer.js';
import {PRESETS} from './dist/lab-config.js';
export async function createThree(config,mode,model,onDevice){
 const spark=mode==='spark',gpu=mode==='gsl-gpu';
 // Match the GSL viewer: native WebGPU blends in sRGB; WebGL outputs sRGB.
 THREE.ColorManagement.workingColorSpace=gpu?THREE.SRGBColorSpace:THREE.LinearSRGBColorSpace;
 const lib=await import(spark?'/dist/spark.js':'/dist/gsl.js');
 let renderer,device,gl;
 const rendererParameters={antialias:false,alpha:false,powerPreference:'high-performance',...(spark?{}:{reversedDepthBuffer:true})};
 if(gpu){const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No WebGPU adapter');renderer=new WebGPURenderer({...rendererParameters,requiredLimits:{maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});await renderer.init();if(!renderer.backend.isWebGPUBackend)throw Error('Native WebGPU required');device=renderer.backend.device;onDevice(device);}
 else{renderer=new THREE.WebGLRenderer(rendererParameters);gl=renderer.getContext();}
 renderer.setPixelRatio(config.dpr);renderer.setSize(config.logicalWidth,config.logicalHeight);renderer.setClearColor(0x101418,1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;document.body.append(renderer.domElement);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,config.width/config.height,.1,3000);
 // Share the exact matched rendering presets with the browser lab.
 // The benchmark controls scheduling; Spark uses full data and extended storage.
 const {extended,...preset}=PRESETS[spark?'spark':'gsl'];
 const options={renderer,...preset,autoUpdate:false,...(spark?{accumExtSplats:extended}:{autoStochastic:false})};
 const gs=new (spark?lib.SparkRenderer:lib.GaussianSplatRenderer)(options);scene.add(gs);
 const mesh=new lib.SplatMesh({url:'/models/'+model+'.ply',extSplats:true,onProgress:e=>window.progress={loaded:e.loaded,total:e.total,stage:e.stage}});scene.add(mesh);
 const start=performance.now();await mesh.initialized;const loadMs=performance.now()-start;
 if(spark&&(!mesh.extSplats||mesh.packedSplats||!gs.accumExtSplats))throw Error('Spark source or accumulator is not ExtSplats');
 let resolve=null,variant='sorted',jobs=[];
 if(!gpu){const original=gs.driveSort.bind(gs);gs.driveSort=(...args)=>{const started=!gs.sorting&&gs.sortDirty,t=performance.now();const result=original(...args);if(!started)return result;return Promise.resolve(result).then(v=>{jobs.push({ms:performance.now()-t,at:performance.now()});return v;});};}
 const api={kind:mode,renderer,device,gl,canvas:renderer.domElement,gs,mesh,camera,scene,loadMs,count:mesh.numSplats,sh:(mesh.extSplats??mesh.splats).getNumSh(),
  setView(position,quaternion){camera.position.fromArray(position);camera.quaternion.fromArray(quaternion);camera.updateMatrixWorld();},
  async update(){await gs.update({scene,camera});while(gs.sorting||gs.updateRunning)await sleep(1);},
  setAuto(value){gs.autoUpdate=value;},
  draw(){renderer.setRenderTarget(null);if(variant==='stochastic-resolved')resolve.compose(renderer,scene,camera);else renderer.render(scene,camera);},
  roots(){return {mesh,gs,resolve};},
  async setVariant(value,fast=true){gs.autoUpdate=false;while(gs.sorting||gs.updateRunning)await sleep(1);variant=value;gs.setDirty();if(gpu)gs.backend.projection.projectedInputs=[];if(!spark){gs.fastSort=fast;gs.autoStochastic=false;gs.stochastic=value.startsWith('stochastic');if(value==='stochastic-resolved'){resolve??=new lib.StochasticResolvePass(gs);resolve.temporalEnabled=false;resolve.resetHistory();}}},
  sortProbe(timer,enabled){if(!gpu)return;if(!api.originalCompute)api.originalCompute=renderer.compute.bind(renderer);renderer.compute=enabled?(nodes,...args)=>{if(!Array.isArray(nodes))return api.originalCompute(nodes,...args);const i=nodes.findIndex(n=>/radix|prefix|scatter|histogram/i.test(n.name));if(i<0)return api.originalCompute(nodes,...args);timer.stage='projection';if(i>0)api.originalCompute(nodes.slice(0,i),...args);timer.stage='sort';api.originalCompute(nodes.slice(i),...args);timer.stage=null;}:api.originalCompute;},
  jobs:()=>jobs,
  state(){return {variant,workingColorSpace:THREE.ColorManagement.workingColorSpace,outputColorSpace:renderer.outputColorSpace,spatialResolve:!!resolve?.isStochasticResolvePass,temporalResolve:resolve?.temporalEnabled??null,fastSort:spark?null:gs.fastSort,sourceType:spark?mesh.extSplats.constructor.name:'Splats',accumulatorExtended:spark?gs.accumExtSplats:true,stochastic:spark?false:gs.stochasticActive,sortBits:spark?32:gpu?(gs.fastSort?24:32):null,sortRadial:gs.sortRadial,lodEnabled:spark?gs.enableLod:null,hasLodData:spark?!!mesh.extSplats.lodSplats:null,renderParameters:Object.fromEntries(['minPixelRadius','maxPixelRadius','minAlpha','preBlurAmount','blurAmount','clipXY','focalAdjustment','maxStdDev','minSortIntervalMs'].map(k=>[k,gs[k]])),deviceConfiguration:gpu?'three-default':null,deviceFeatures:device?[...device.features].sort():null,compatibilityMode:renderer.backend?.compatibilityMode??null,reversedDepthBuffer:renderer.reversedDepthBuffer??renderer.capabilities?.reversedDepthBuffer??false,preserveDrawingBuffer:gl?.getContextAttributes().preserveDrawingBuffer??null,active:gs.activeSplats,backend:gpu?'webgpu':'webgl2',sourceCount:mesh.numSplats,sh:api.sh};},
  async visible(){return gpu?new Uint32Array(await renderer.getArrayBufferAsync(gs.backend.projection.visibleCount))[0]:gs.activeSplats;}
 };
 return api;
}
