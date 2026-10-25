// Puts the GitHub Pages site together: the home page (site/) at the root, the demo build under demo/.
//   node scripts/site/build.mjs <demo build> <out>      (pages.yml: web/dist-demo → _site)
// The version in package.json goes into the download links, so they name this release's files; their sizes
// come from that release on GitHub, and are left blank when it can't be reached (or isn't built yet).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [demo, out] = process.argv.slice(2).map((p) => p && resolve(p));
if (!demo || !out) { console.error('usage: node scripts/site/build.mjs <demo build> <out>'); process.exit(2); }
if (!existsSync(join(demo, 'index.html'))) throw new Error(`${demo} 里没有演示站的 index.html，先跑 npm run demo`);

// The README's pictures: release/images here, docs/images in the published repository.
const IMAGES = ['release/images', 'docs/images'].map((p) => join(ROOT, p)).find((p) => existsSync(p));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'images'), { recursive: true });
const sizes = await releaseSizes(version);
const html = readFileSync(join(ROOT, 'site/index.html'), 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replace(/\{\{SIZE:([\w.-]+)\}\}/g, (_, suffix) => sizes.get(`Lumen-${version}-${suffix}`) ?? '');
writeFileSync(join(out, 'index.html'), html);
cpSync(join(ROOT, 'site/site.css'), join(out, 'site.css'));
cpSync(join(ROOT, 'web/public/favicon.svg'), join(out, 'favicon.svg'));
// Only the pictures the page uses.
const used = new Set([...html.matchAll(/images\/([\w.-]+\.webp)/g)].map((m) => m[1]));
for (const name of used) {
  if (!existsSync(join(IMAGES, name))) throw new Error(`主页用到的 ${name} 不在 ${IMAGES}`);
  cpSync(join(IMAGES, name), join(out, 'images', name));
}
cpSync(demo, join(out, 'demo'), { recursive: true });
console.log(`主页 v${version}＋演示站 → ${out}（${used.size} 张图，${sizes.size} 个安装包有大小）`);

async function releaseSizes(v) {
  try {
    const res = await fetch(`https://api.github.com/repos/Callioper/Lumen/releases/tags/v${v}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { assets } = await res.json();
    return new Map(assets.map((a) => [a.name, `${(a.size / 1048576).toFixed(1)} MB`]));
  } catch (e) {
    console.warn(`取不到 v${v} 的安装包大小（${e.message}），主页上先不写大小`);
    return new Map();
  }
}
