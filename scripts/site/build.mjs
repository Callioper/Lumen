// Puts the GitHub Pages site together: the home page (site/) at the root, the demo build under demo/.
//   node scripts/site/build.mjs <demo build> <out>      (pages.yml: web/dist-demo → _site)
// The version in package.json goes into the download links, so they name this release's files.
// site/images and site/media hold the page's own pictures and video (2x captures of the demo).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const [demo, out] = process.argv.slice(2).map((p) => p && resolve(p));
if (!demo || !out) { console.error('usage: node scripts/site/build.mjs <demo build> <out>'); process.exit(2); }
if (!existsSync(join(demo, 'index.html'))) throw new Error(`${demo} 里没有演示站的 index.html，先跑 npm run demo`);

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const html = readFileSync(join(SITE, 'index.html'), 'utf8').replaceAll('{{VERSION}}', version);
writeFileSync(join(out, 'index.html'), html);
cpSync(join(SITE, 'site.css'), join(out, 'site.css'));
cpSync(join(ROOT, 'web/public/favicon.svg'), join(out, 'favicon.svg'));
for (const dir of ['images', 'media']) cpSync(join(SITE, dir), join(out, dir), { recursive: true });
// Every file the page names must be there.
const missing = [...html.matchAll(/(?:src|poster|href)="((?:images|media)\/[^"]+)"/g)].map((m) => m[1]).filter((p) => !existsSync(join(out, p)));
if (missing.length) throw new Error(`主页引用了不存在的文件：${missing.join('、')}`);
cpSync(demo, join(out, 'demo'), { recursive: true });
console.log(`主页 v${version}＋演示站 → ${out}`);
