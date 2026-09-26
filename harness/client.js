import * as THREE from 'three';
import {gpuTimer,sleep,fenceGL} from './timer.js';
const query=new URLSearchParams(location.search),mode=query.get('mode')||'gsl-gl',model=query.get('model')||'elevator';
const config=await(await fetch('/config.json')).json();
window.phase='loading';let timer=null;
function onDevice(device){if(!device.features.has('timestamp-query'))throw Error('GPU timestamp-query required');device.addEventListener('uncapturederror',e=>errors.push(e.error.message));timer=gpuTimer(device);return timer;}
const adapter=mode==='supersplat'?await(await import('./dist/supersplat.js')).createSuperSplat(config,model,onDevice):mode.startsWith('pc-')?await(await import('./playcanvas-adapter.js')).createPlayCanvas(config,mode,model,onDevice):await(await import('./three-adapter.js')).createThree(config,mode,model,onDevice);
window.api=adapter;
const {canvas,device,gl}=adapter;
const ext=gl?.getExtension('EXT_disjoint_timer_query_webgl2');if(gl&&!ext)throw Error('GPU timer query not available');
if(canvas.width!==config.width||canvas.height!==config.height)throw Error(`Unexpected resolution ${canvas.width}x${canvas.height}`);
let gpuInfo;if(gl){const debug=gl.getExtension('WEBGL_debug_renderer_info');gpuInfo=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);}else{const a=await navigator.gpu.requestAdapter();gpuInfo={vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description};}
const cameraHelper=new THREE.PerspectiveCamera(45,config.width/config.height,.1,3000);cameraHelper.up.set(0,-1,0);
const target=new THREE.Vector3(...config.models[model].target),offset=new THREE.Vector3(...config.models[model].offset);
function setView(angle=0,scale=1){cameraHelper.position.copy(offset).multiplyScalar(scale).applyAxisAngle(new THREE.Vector3(0,1,0),angle).add(target);cameraHelper.lookAt(target);cameraHelper.updateMatrixWorld();adapter.setView(cameraHelper.position.toArray(),cameraHelper.quaternion.toArray());}
window.setBaseView=(preset=config.models[model])=>{target.fromArray(preset.target);offset.fromArray(preset.offset);setView();};
setView();await adapter.update();adapter.draw();if(device)await device.queue.onSubmittedWorkDone();else await fenceGL(gl);
if(adapter.count!==config.models[model].count)throw Error(`Wrong model count: ${adapter.count}`);
window.phase='ready';window.ready=true;document.getElementById('status').style.display='none';
async function frame({moving=false,k=0,count=64,angle=0,scale=1,splitSort=false}={}){
 const row={};if(moving){row.cameraAngle=angle+(config.motionAmplitudeDegrees*Math.PI/180)*Math.sin(k/count*2*Math.PI);setView(row.cameraAngle,scale);}
 const start=performance.now();let q;
 if(timer)timer.start(row);if(ext){q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}
 const cpu=performance.now();adapter.draw();row.cpuSubmitMs=performance.now()-cpu;
 if(ext)gl.endQuery(ext.TIME_ELAPSED_EXT);
 if(timer)await timer.finish();else{await fenceGL(gl);while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))await sleep(0);if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint GPU timing');row.gpuMs=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(q);}
 row.completionMs=performance.now()-start;adapter.afterFrame?.(row);return row;
}
async function warmup(options={}){const t=performance.now(),minWarmMs=1000;let stable=0,last=metrics.pipelines,i=0;do{await frame({...options,k:i++});if(metrics.pipelines===last)stable++;else{stable=0;last=metrics.pipelines;}}while(i<20||performance.now()-t<minWarmMs||stable<12);return {frames:i,ms:performance.now()-t};}
window.benchmark=async({variant='sorted',fast=true,moving=false,angle=0,scale=1,n=64,minMs=1500}={})=>{
 window.phase=`${variant} ${moving?'moving':'static'}`;
 await adapter.setVariant(variant,fast);setView(angle,scale);await adapter.update();await frame();
 adapter.setAuto?.(moving);const options={moving,angle,scale,count:n};const warm=await warmup(options);
 const ri=metrics.rpc.length,ji=adapter.jobs?.().length??0,rows=[],start=performance.now();
 for(let i=0;i<n||i%n!==0||performance.now()-start<minMs;i++)rows.push(await frame({...options,k:i}));
 adapter.setAuto?.(false);if(adapter.gs)while(adapter.gs.sorting||adapter.gs.updateRunning)await sleep(1);
 const result={variant,motionAmplitudeDegrees:moving?config.motionAmplitudeDegrees:0,fast:mode.startsWith('gsl')?fast:null,moving,angle,scale,warm,rows,rpc:metrics.rpc.slice(ri),sortJobs:adapter.jobs?.().slice(ji)??[],state:adapter.state(),visible:await adapter.visible(),errors:[...errors]};
 window.phase='ready';return result;
};
window.sortBenchmark=async({fast=true,n=16}={})=>{
 await adapter.setVariant('sorted',fast);adapter.setAuto?.(false);setView();await adapter.update();await frame();
 if(device)adapter.sortProbe?.(timer,true);
 const rows=[];
 for(let i=0;i<n+4;i++){setView(i%2?.10:-.10);const ri=metrics.rpc.length,ji=adapter.jobs?.().length??0,start=performance.now();await adapter.update();const updateMs=performance.now()-start;const measured=await frame();if(i>=4)rows.push({updateMs,totalMs:performance.now()-start,...measured,rpc:metrics.rpc.slice(ri),sortJobs:adapter.jobs?.().slice(ji)??[]});}
 if(device)adapter.sortProbe?.(timer,false);
 return {fast:mode.startsWith('gsl')?fast:null,rows,gpuIsolation:mode==='gsl-gpu'?'Projection and radix are submitted as separate compute passes for this diagnostic only.':'Native pass boundaries.'};
};
window.captureView=async({variant='sorted',fast=true,angle=0,scale=1}={})=>{await adapter.setVariant(variant,fast);setView(angle,scale);await adapter.update();await frame();for(let i=0;i<4;i++)await frame();};
window.snapshot=()=>({mode,model,config,loadMs:adapter.loadMs,state:adapter.state(),resolution:[canvas.width,canvas.height],dpr:devicePixelRatio,gpuInfo,camera:{position:cameraHelper.position.toArray(),quaternion:cameraHelper.quaternion.toArray(),fov:45,near:.1,far:3000},memory:memorySnapshot(adapter.roots()),rpc:metrics.rpc,errors:[...errors]});
