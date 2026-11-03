// Builds site/: the published report at /, its captures and downloads, and the browser lab at /test/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLab } from './build-lab.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const report = path.join(root, 'report');
const github = 'https://github.com/WilliamLiu-1997/3dgs-renderer-bench';
const DOWNLOADS = [
  'benchmark-data.json',
  'benchmark-summary.csv',
  'benchmark-overview.png',
  'benchmark-overview.svg',
  'input-manifest.json',
  'validation.json',
];
// Current template: a JSON script block. Snapshots published before it embed `const DATA=…;`.
const DATA_BLOCKS = [
  /(<script type="application\/json" id="benchmark-data">)([\s\S]*?)(<\/script>)/,
  /(const DATA=)([\s\S]*?)(;\nconst I18N=)/,
];

export async function buildSite(out = path.join(root, 'site')) {
  await fs.rm(out, { recursive: true, force: true });
  for (const dir of ['thumbnails', 'images', 'harness', 'lab'])
    await fs.mkdir(path.join(out, dir), { recursive: true });
  for (const file of ['README.md', 'harness/README.md', 'lab/README.md', 'lab/config.js'])
    await fs.copyFile(path.join(root, file), path.join(out, file));

  // The local report embeds thumbnails as data URIs; the site serves them as files instead.
  // report/ links up to harness/; the site serves those files from its root.
  let html = (await fs.readFile(path.join(report, '3DGS-Renderer-Bench.html'), 'utf8')).replaceAll(
    'href="../harness/',
    'href="harness/',
  );
  const block = DATA_BLOCKS.find(pattern => pattern.test(html));
  if (!block) throw Error('report/3DGS-Renderer-Bench.html has no embedded benchmark data');
  const data = JSON.parse(html.match(block)[2]);
  for (const item of data.images) {
    const name = path.basename(item.path);
    item.thumb = await writeThumbnail(out, name, item.thumb);
    item.path = 'images/' + name;
    await fs.copyFile(path.join(root, 'harness/results', name), path.join(out, item.path));
  }
  html = html.replace(block, (_, open, __, close) => open + JSON.stringify(data).replaceAll('</', '<\\/') + close);
  const downloadLink = 'href="harness/README.md"';
  const linkEnd = html.indexOf('</a>', html.indexOf(downloadLink)) + '</a>'.length;
  html =
    html.slice(0, linkEnd) +
    `<a href="/test/">Test your model</a><a href="${github}" target="_blank" rel="noopener noreferrer">GitHub</a>` +
    html.slice(linkEnd);
  await fs.writeFile(path.join(out, 'index.html'), html);

  for (const name of DOWNLOADS) await fs.copyFile(path.join(report, name), path.join(out, name));
  const summary = JSON.parse(await fs.readFile(path.join(report, 'benchmark-data.json'), 'utf8'));
  for (const item of summary.images) item.path = 'images/' + path.basename(item.path);
  await fs.writeFile(path.join(out, 'benchmark-data.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Built static report with ${data.images.length} thumbnails in ${out}`);
  await buildLab(path.join(out, 'test'));
}

async function writeThumbnail(out, name, dataUri) {
  const file = `thumbnails/${name.replace(/\.png$/, '.jpg')}`;
  await fs.writeFile(path.join(out, file), Buffer.from(dataUri.split(',')[1], 'base64'));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
