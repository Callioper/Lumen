// Puts the GitHub Pages site together: the home page (site/) at the root, the demo build under demo/.
//   node scripts/site/build.mjs <demo build> <out>      (pages.yml: web/dist-demo → _site)
// The version in package.json goes into the download links, so they name this release's files.
// releases.html is CHANGELOG.md set in the home page's header and footer; the newest version's
// <!-- news: … --> line goes on the home page's first screen.
// site/images and site/media hold the page's own pictures and video (2x captures of the demo).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const [demo, out] = process.argv.slice(2).map((p) => p && resolve(p));
if (!demo || !out) { console.error('usage: node scripts/site/build.mjs <demo build> <out>'); process.exit(2); }
if (!existsSync(join(demo, 'index.html'))) throw new Error(`${demo} 里没有演示站的 index.html，先跑 npm run demo`);

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The changelog sits at the root in the published repository, under release/ in the author's.
const changelog = readFileSync([join(ROOT, 'CHANGELOG.md'), join(ROOT, 'release', 'CHANGELOG.md')].find((p) => existsSync(p)), 'utf8');
const versions = [...changelog.matchAll(/^## (v\d[^\s]*)\s*\n+<!-- news: (.+?) -->/gm)].map((m) => ({ tag: m[1], news: m[2].trim() }));
if (versions[0]?.tag !== `v${version}`) throw new Error(`CHANGELOG.md 最上面一节应是 v${version}（带 <!-- news: … --> 一行），现在是 ${versions[0]?.tag ?? '空'}`);
const html = readFileSync(join(SITE, 'index.html'), 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{NEWS}}', versions[0].news);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'releases.html'), releasesPage(html, changelog, versions));
cpSync(join(SITE, 'site.css'), join(out, 'site.css'));
cpSync(join(ROOT, 'web/public/favicon.svg'), join(out, 'favicon.svg'));
for (const dir of ['images', 'media']) cpSync(join(SITE, dir), join(out, dir), { recursive: true });
// Every file the page names must be there.
const missing = [...html.matchAll(/(?:src|poster|href)="((?:images|media)\/[^"]+)"/g)].map((m) => m[1]).filter((p) => !existsSync(join(out, p)));
if (missing.length) throw new Error(`主页引用了不存在的文件：${missing.join('、')}`);
cpSync(demo, join(out, 'demo'), { recursive: true });
console.log(`主页 v${version}＋演示站 → ${out}`);

// The release notes in the home page's dress: its head, header and footer, the in-page links pointed
// back at the home page, each version an anchor (releases.html#v0.2.0) listed down the side.
function releasesPage(home, md, versions) {
  const part = (re) => { const m = re.exec(home); if (!m) throw new Error(`主页里找不到 ${re}`); return m[0]; };
  const head = part(/^[\s\S]*?<\/head>/)
    .replace(/<title>[^<]*<\/title>/, '<title>更新日志 · Lumen</title>')
    .replace(/(<meta name="description" content=")[^"]*/, '$1Lumen 每个版本加了什么、改了什么、修了什么。');
  const home_ = (s) => s.replace(/href="#/g, 'href="./#').replace('<a href="releases.html">', '<a href="releases.html" aria-current="page">');
  const header = home_(part(/<header class="top">[\s\S]*?<\/header>/));
  const footer = home_(part(/<footer class="foot">[\s\S]*?<\/footer>/));
  const body = marked.parse(md).replace(/<h2>(v\d[^<]*)<\/h2>/g, '<h2 id="$1">$1</h2>');
  const toc = versions.map((v) => `<li><a href="#${v.tag}">${v.tag}</a></li>`).join('');
  return `${head}
<body>
${header}
<main class="notes-page">
<nav class="notes-toc" aria-label="版本"><p>版本</p><ol>${toc}</ol></nav>
<article class="notes">
${body}</article>
</main>
${footer}
</body>
</html>
`;
}
