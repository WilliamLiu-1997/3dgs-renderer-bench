window.errors=[];
addEventListener('error',e=>errors.push(e.message));
addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.metrics={rpc:[],workers:[],allocations:new Map(),gpuBytes:0,peakGpuBytes:0,unknown:new Set(),pipelines:0};
const originalWorker=Worker;
window.Worker=class extends originalWorker{
 constructor(...args){super(...args);this.record={alive:true,pending:new Map(),sortQueue:[],wasmBytes:0};metrics.workers.push(this.record);this.addEventListener('message',e=>{const m=e.data,r=this.record;if(m.sortTime!==undefined&&r.sortQueue.length){metrics.rpc.push({name:'sortPlayCanvas',roundTripMs:performance.now()-r.sortQueue.shift(),at:performance.now(),workerMs:m.sortTime,wasmBytes:0});}if(m.wasmMemoryBytes)r.wasmBytes=m.wasmMemoryBytes;if(m.__bench?.wasmBytes)r.wasmBytes=m.__bench.wasmBytes;if(m.id!==undefined&&m.status===undefined&&r.pending.has(m.id)){const p=r.pending.get(m.id);metrics.rpc.push({name:p.name,roundTripMs:performance.now()-p.start,at:performance.now(),workerMs:m.__bench?.workerMs??null,wasmBytes:r.wasmBytes});r.pending.delete(m.id);}});}
 postMessage(m,...args){if(m.command==='sort')this.record.sortQueue.push(performance.now());if(m.id!==undefined&&m.name)this.record.pending.set(m.id,{name:m.name,start:performance.now()});return super.postMessage(m,...args);}
 terminate(){this.record.alive=false;return super.terminate();}
};
const ids=new WeakMap();let nextId=1;
function release(id){const prev=metrics.allocations.get(id);if(prev){metrics.gpuBytes-=prev.bytes;metrics.allocations.delete(id);}}
const finalizer=new FinalizationRegistry(release);
function allocation(object,bytes,type,label){if(!object)return;let id=ids.get(object);if(!id){id=nextId++;ids.set(object,id);finalizer.register(object,id);}release(id);metrics.allocations.set(id,{bytes,type,label});metrics.gpuBytes+=bytes;metrics.peakGpuBytes=Math.max(metrics.peakGpuBytes,metrics.gpuBytes);}
function patch(proto,name,fn){const orig=proto[name];proto[name]=function(...a){return fn.call(this,orig,a);};}
if(window.GPUDevice){
 patch(GPUDevice.prototype,'createBuffer',function(f,a){const o=f.apply(this,a);allocation(o,a[0].size,'buffer',a[0].label||'');return o;});
 patch(GPUDevice.prototype,'createTexture',function(f,a){const o=f.apply(this,a),d=a[0],s=d.size,w=s.width??s[0],h=s.height??s[1]??1,z=s.depthOrArrayLayers??s[2]??1;const formats={r8unorm:1,r8uint:1,rg8unorm:2,r16float:2,r32uint:4,r32float:4,rg16float:4,rgba8unorm:4,'rgba8unorm-srgb':4,bgra8unorm:4,'bgra8unorm-srgb':4,depth24plus:4,'depth24plus-stencil8':4,depth32float:4,rg32float:8,rg32uint:8,rgba16float:8,rgba32float:16,rgba32uint:16};const bpp=formats[d.format];if(bpp===undefined)metrics.unknown.add(d.format);let bytes=0;for(let i=0;i<(d.mipLevelCount||1);i++)bytes+=Math.max(1,w>>i)*Math.max(1,h>>i)*(d.dimension==='3d'?Math.max(1,z>>i):z)*(bpp??0)*(d.sampleCount||1);allocation(o,bytes,'texture',`${d.label||''} ${d.format} ${w}x${h}x${z}`);return o;});
 for(const p of [GPUBuffer.prototype,GPUTexture.prototype])patch(p,'destroy',function(f,a){release(ids.get(this));return f.apply(this,a);});
 for(const name of ['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'])patch(GPUDevice.prototype,name,function(f,a){metrics.pipelines++;return f.apply(this,a);});
}
const glState=new WeakMap();
function state(gl){if(!glState.has(gl))glState.set(gl,{unit:0,textures:new Map(),buffers:new Map(),rb:null});return glState.get(gl);}
const p=WebGL2RenderingContext.prototype;
patch(p,'activeTexture',function(f,a){state(this).unit=a[0];return f.apply(this,a);});
patch(p,'bindTexture',function(f,a){state(this).textures.set(state(this).unit+':'+a[0],a[1]);return f.apply(this,a);});
patch(p,'bindBuffer',function(f,a){state(this).buffers.set(a[0],a[1]);return f.apply(this,a);});
patch(p,'bindRenderbuffer',function(f,a){state(this).rb=a[1];return f.apply(this,a);});
const bytesGL={33326:4,33327:4,33328:8,33330:1,33332:2,33333:4,33334:4,33336:2,33338:4,33340:8,34836:16,34842:8,36208:16,36209:12,36220:4,32856:4,32849:3,33189:2,33190:4,36012:4,35056:4,35907:4,6408:4,6407:3,6402:4,33321:1,33323:2,33325:2};
function bpp(fmt){if(bytesGL[fmt]===undefined)metrics.unknown.add('gl:'+fmt);return bytesGL[fmt]??0;}
function texture(gl,target){return state(gl).textures.get(state(gl).unit+':'+target);}
for(const name of ['texStorage2D','texStorage3D'])patch(p,name,function(f,a){let bytes=0;for(let i=0;i<a[1];i++)bytes+=Math.max(1,a[3]>>i)*Math.max(1,a[4]>>i)*(a[5]||1)*bpp(a[2]);allocation(texture(this,a[0]),bytes,'texture',`${a[2]} ${a.slice(3).join('x')}`);return f.apply(this,a);});
for(const name of ['texImage2D','texImage3D'])patch(p,name,function(f,a){if(a[1]===0&&typeof a[3]==='number')allocation(texture(this,a[0]),a[3]*a[4]*(name==='texImage3D'?a[5]:1)*bpp(a[2]),'texture',`${a[2]} ${a[3]}x${a[4]}`);return f.apply(this,a);});
patch(p,'bufferData',function(f,a){const data=a[1];const bytes=typeof data==='number'?data:ArrayBuffer.isView(data)?(a[4]||data.length||data.byteLength)*(data.BYTES_PER_ELEMENT||1):data.byteLength;allocation(state(this).buffers.get(a[0]),bytes,'buffer',String(a[0]));return f.apply(this,a);});
patch(p,'renderbufferStorage',function(f,a){allocation(state(this).rb,bpp(a[1])*a[2]*a[3],'renderbuffer',String(a[1]));return f.apply(this,a);});
patch(p,'renderbufferStorageMultisample',function(f,a){allocation(state(this).rb,bpp(a[2])*a[3]*a[4]*a[1],'renderbuffer',String(a[2]));return f.apply(this,a);});
for(const name of ['deleteTexture','deleteBuffer','deleteRenderbuffer'])patch(p,name,function(f,a){release(ids.get(a[0]));return f.apply(this,a);});
window.memorySnapshot=roots=>{
 const seen=new Set(),buffers=new Map();
 function visit(o,path,depth){if(!o||typeof o!=='object'||seen.has(o)||depth>12||o instanceof Node||o instanceof WebGL2RenderingContext)return;seen.add(o);if(ArrayBuffer.isView(o)){if(o.buffer.byteLength&&!buffers.has(o.buffer))buffers.set(o.buffer,{bytes:o.buffer.byteLength,path});return;}if(o instanceof ArrayBuffer){if(!buffers.has(o))buffers.set(o,{bytes:o.byteLength,path});return;}if(o instanceof Map){for(const [k,v] of o)visit(v,path+'.map',depth+1);return;}for(const key of Object.keys(o)){if(['parent','domElement','renderer','device','graphicsDevice','scene','app','worker','source','sourcePool'].includes(key))continue;visit(o[key],path+'.'+key,depth+1);}}
 for(const [key,value] of Object.entries(roots))visit(value,key,0);
 const allocations=[...metrics.allocations.values()],measured=allocations.filter(a=>!a.label.startsWith('bench:'));
 return {mainBuffers:[...buffers.values()],mainBufferBytes:[...buffers.values()].reduce((a,b)=>a+b.bytes,0),workerWasmBytes:metrics.workers.filter(w=>w.alive).reduce((a,b)=>a+b.wasmBytes,0),workers:metrics.workers.map(w=>({alive:w.alive,wasmBytes:w.wasmBytes})),gpuAllocations:measured,gpuBytes:measured.reduce((a,b)=>a+b.bytes,0),gpuPeakBytes:metrics.peakGpuBytes,instrumentationGpuBytes:allocations.filter(a=>a.label.startsWith('bench:')).reduce((a,b)=>a+b.bytes,0),unknownFormats:[...metrics.unknown]};
};
