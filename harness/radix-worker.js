import { SortKeys, serveWorker } from './dist/radix-core.js';

const sort = SortKeys.sort.bind(SortKeys);
let workerMs;
SortKeys.sort = (...args) => {
  const start = performance.now();
  const result = sort(...args);
  workerMs = performance.now() - start;
  return result;
};

const postMessage = self.postMessage.bind(self);
self.postMessage = (message, ...args) => {
  if (message.result?.ordering) message = { ...message, __bench: { workerMs } };
  postMessage(message, ...args);
};

export { serveWorker };
