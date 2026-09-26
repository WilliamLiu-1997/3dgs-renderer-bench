// Sample each live V8 isolate outside timed frames. Every run owns a fresh browser.
export async function collectHeap(browserSession, pageSession) {
 const {targetInfos}=await browserSession.send('Target.getTargets');
 const workers=[];
 for(const target of targetInfos.filter(target=>target.type==='worker')){
  const {sessionId}=await browserSession.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let nextId=0;
  const send=method=>new Promise((resolve,reject)=>{
   const id=++nextId;
   const receive=event=>{
    if(event.sessionId!==sessionId)return;
    const message=JSON.parse(event.message);
    if(message.id!==id)return;
    browserSession.off('Target.receivedMessageFromTarget',receive);
    if(message.error)reject(new Error(message.error.message));else resolve(message.result);
   };
   browserSession.on('Target.receivedMessageFromTarget',receive);
   browserSession.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method})}).catch(error=>{
    browserSession.off('Target.receivedMessageFromTarget',receive);reject(error);
   });
  });
  try{
   await send('Runtime.discardConsoleEntries');
   await send('HeapProfiler.collectGarbage');
   workers.push({targetId:target.targetId,isolateId:(await send('Runtime.getIsolateId')).id,...await send('Runtime.getHeapUsage')});
  }finally{await browserSession.send('Target.detachFromTarget',{sessionId});}
 }
 await pageSession.send('Runtime.discardConsoleEntries');
 await pageSession.send('HeapProfiler.collectGarbage');
 const main={isolateId:(await pageSession.send('Runtime.getIsolateId')).id,...await pageSession.send('Runtime.getHeapUsage')};
 const isolates=[main,...workers];
 if(new Set(isolates.map(value=>value.isolateId)).size!==isolates.length)throw new Error('Duplicate heap isolate');
 return {main,workers,usedSize:isolates.reduce((sum,value)=>sum+value.usedSize,0),workerUsedSize:workers.reduce((sum,value)=>sum+value.usedSize,0),backingStorageSize:main.backingStorageSize,workerBackingStorageSize:workers.reduce((sum,value)=>sum+value.backingStorageSize,0)};
}
