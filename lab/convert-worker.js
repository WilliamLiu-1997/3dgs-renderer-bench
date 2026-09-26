import { readFile, writeSource, MemoryReadFileSystem, MemoryFileSystem, createChunkDataPool } from '@playcanvas/splat-transform';

self.onmessage = async ({ data: file }) => {
  let sources;
  try {
    const start = performance.now();
    const fs = new MemoryReadFileSystem();
    fs.set(file.name, new Uint8Array(await file.arrayBuffer()));
    sources = await readFile({ filename: file.name, inputFormat: 'spz', fileSystem: fs });
    const out = new MemoryFileSystem();
    await writeSource({ filename: 'scene.ply', outputFormat: 'ply', source: sources[0], pool: createChunkDataPool(), options: {} }, out);
    const bytes = out.results.get('scene.ply');
    self.postMessage({ bytes, ms: performance.now() - start, count: sources[0].meta.numGaussians, shBands: sources[0].meta.shBands }, [bytes.buffer]);
  } catch (error) { self.postMessage({ error: String(error) }); }
  finally { for (const source of sources ?? []) source.close(); }
};
