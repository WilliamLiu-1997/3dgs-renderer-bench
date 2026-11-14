// Sample each live V8 isolate outside timed frames. Every run owns a fresh browser. A Worker that exits while it is
// being sampled (renderers retire loader Workers after loading) restarts the snapshot, so every isolate in it is live.
export async function collectHeap(browserSession, pageSession) {
  for (let attempt = 1; ; attempt++)
    try {
      return await sampleHeap(browserSession, pageSession);
    } catch (error) {
      if (attempt === 3 || !/No session|No target|not found|timed out/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function sampleHeap(browserSession, pageSession) {
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const workers = [];
  for (const target of targetInfos.filter(target => target.type === 'worker')) {
    const { sessionId } = await browserSession.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: false,
    });
    let nextId = 0;
    const send = method =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const finish = (error, result) => {
          clearTimeout(timeout);
          browserSession.off('Target.receivedMessageFromTarget', receive);
          if (error) reject(error);
          else resolve(result);
        };
        // A terminated Worker can leave an acknowledged CDP request without a reply.
        const timeout = setTimeout(() => finish(new Error(`Worker heap sampling timed out: ${method}`)), 30000);
        const receive = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== id) return;
          finish(message.error ? new Error(message.error.message) : null, message.result);
        };
        browserSession.on('Target.receivedMessageFromTarget', receive);
        browserSession
          .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) })
          .catch(error => finish(error));
      });
    try {
      await send('Runtime.discardConsoleEntries');
      await send('HeapProfiler.collectGarbage');
      workers.push({
        targetId: target.targetId,
        isolateId: (await send('Runtime.getIsolateId')).id,
        ...(await send('Runtime.getHeapUsage')),
      });
    } finally {
      // Fails with "No session" if the Worker exited meanwhile; collectHeap then samples again.
      await browserSession.send('Target.detachFromTarget', { sessionId });
    }
  }
  await pageSession.send('Runtime.discardConsoleEntries');
  await pageSession.send('HeapProfiler.collectGarbage');
  const main = {
    isolateId: (await pageSession.send('Runtime.getIsolateId')).id,
    ...(await pageSession.send('Runtime.getHeapUsage')),
  };
  const isolates = [main, ...workers];
  if (new Set(isolates.map(value => value.isolateId)).size !== isolates.length)
    throw new Error('Duplicate heap isolate');
  return {
    main,
    workers,
    usedSize: isolates.reduce((sum, value) => sum + value.usedSize, 0),
    workerUsedSize: workers.reduce((sum, value) => sum + value.usedSize, 0),
    backingStorageSize: main.backingStorageSize,
    workerBackingStorageSize: workers.reduce((sum, value) => sum + value.backingStorageSize, 0),
  };
}
