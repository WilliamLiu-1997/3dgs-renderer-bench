import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLab } from './build-lab.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repository = 'WilliamLiu-1997/3dgs-renderer-bench';
const release = 'v1.0.0';
const revision = process.env.BENCHMARK_REVISION || release;
const github = `https://github.com/${repository}`;
const originals = `https://raw.githubusercontent.com/${repository}/${revision}/harness/results/`;
const kit = `${github}/releases/download/${release}/renderer-benchmark-kit.zip`;

export async function buildSite(out = path.join(root, 'site')) {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.join(out, 'thumbnails'), { recursive: true });

  let html = await fs.readFile(path.join(root, '3DGS-Renderer-Bench.html'), 'utf8');
  const dataStart = html.indexOf('const DATA=') + 'const DATA='.length;
  const dataEnd = html.indexOf(';\nconst I18N=', dataStart);
  const data = JSON.parse(html.slice(dataStart, dataEnd));
  for (const item of data.images) {
    const name = path.basename(item.path);
    const thumbnail = `thumbnails/${name.replace(/\.png$/, '.jpg')}`;
    await fs.writeFile(path.join(out, thumbnail), Buffer.from(item.thumb.split(',')[1], 'base64'));
    item.thumb = thumbnail;
    item.path = originals + name;
  }
  html = html.slice(0, dataStart) + JSON.stringify(data).replaceAll('</', '<\\/') + html.slice(dataEnd);
  html = html
    .replace('href="harness/README.md"', `href="${kit}"`)
    .replaceAll('Reproduction instructions', 'Download reproduction kit')
    .replaceAll('复现说明', '下载复现工具');
  const downloadLink = `href="${kit}"`;
  const linkEnd = html.indexOf('</a>', html.indexOf(downloadLink)) + '</a>'.length;
  html = html.slice(0, linkEnd) + `<a href="/test/">Test your model</a><a href="${github}" target="_blank" rel="noopener noreferrer">GitHub</a>` + html.slice(linkEnd);
  await fs.writeFile(path.join(out, 'index.html'), html);

  const summary = JSON.parse(await fs.readFile(path.join(root, 'benchmark-data.json'), 'utf8'));
  for (const item of summary.images) item.path = originals + path.basename(item.path);
  await fs.writeFile(path.join(out, 'benchmark-data.json'), JSON.stringify(summary, null, 2) + '\n');
  for (const name of ['benchmark-summary.csv', 'benchmark-overview.png', 'benchmark-overview.svg', 'input-manifest.json', 'validation.json']) {
    await fs.copyFile(path.join(root, name), path.join(out, name));
  }
  console.log(`Built static report with ${data.images.length} thumbnails in ${out}`);
  await buildLab(path.join(out, 'test'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
