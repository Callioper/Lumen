// CHANGELOG.md read as data, for releases.html and the home page's 「最近更新」.
// A version is `## vX.Y.Z`, then `<!-- news: … -->`, `发布日期：YYYY-MM-DD`, the GitHub Release line, an
// intro paragraph, and `### 新增功能` / `### 改进` / `### 修复`, each a list of `- **要点。** 说明` items.
// Each item is shown on its own line with its kind's badge (新增 / 改进 / 修复), so the page can be
// filtered by kind; a version shows which kinds it has, so filtering hides the versions without one.
import { marked } from 'marked';

const KINDS = [
  { key: 'add', label: '新增', head: /^新增/ },
  { key: 'improve', label: '改进', head: /^(改进|优化)/ },
  { key: 'fix', label: '修复', head: /^修复/ },
];
export const kindLabel = (key) => KINDS.find((k) => k.key === key)?.label ?? key;

function item(md, kind) {
  const m = /^\*\*(.+?)[。.]?\*\*\s*([\s\S]*)$/.exec(md.trim());
  const lead = m ? m[1] : '';
  const rest = m ? m[2] : md.trim();
  return { kind, lead, html: marked.parseInline(rest) };
}

function version(block) {
  const tag = /^## (v\d\S*)/.exec(block)[1];
  const news = /<!-- news: (.+?) -->/.exec(block)?.[1].trim() ?? '';
  const date = /^发布日期：(\d{4})-(\d{2})-(\d{2})/m.exec(block);
  const intro = [];
  const items = [];
  let kind = null;
  for (const raw of block.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--') || /^(发布日期|GitHub Release)：/.test(line)) continue;
    const head = /^###\s+(.+)$/.exec(line);
    if (head) { kind = KINDS.find((k) => k.head.test(head[1]))?.key ?? null; continue; }
    if (line.startsWith('- ') && kind) items.push(item(line.slice(2), kind));
    else if (line.startsWith('- ') && items.length) items[items.length - 1].html += ' ' + marked.parseInline(line.slice(2));
    else if (!kind) intro.push(line);
  }
  return {
    tag, news, items,
    date: date ? { iso: `${date[1]}-${date[2]}-${date[3]}`, y: +date[1], m: +date[2], d: +date[3] } : null,
    intro: intro.length ? marked.parseInline(intro.join(' ')) : '',
  };
}

export function parseChangelog(md) {
  const blocks = md.split(/^(?=## v\d)/m);
  const preface = blocks.shift().replace(/^# .*\n/, '').trim();
  return { preface: marked.parseInline(preface.split(/\n\n/)[0] ?? ''), versions: blocks.map(version) };
}

const cnDate = (d, year = true) => (d ? `${year ? `${d.y} 年 ` : ''}${d.m} 月 ${d.d} 日` : '');
const count = (versions, kind) => versions.reduce((n, v) => n + v.items.filter((i) => !kind || i.kind === kind).length, 0);

function itemHtml(i) {
  const lead = i.lead ? `<b>${i.lead}</b>` : '';
  return `<li class="cl-item" data-kind="${i.kind}"><span class="cl-badge" data-kind="${i.kind}">${kindLabel(i.kind)}</span><p>${lead}${i.html}</p></li>`;
}

function versionHtml(v, newest) {
  const kinds = [...new Set(v.items.map((i) => i.kind))].join(' ');
  return `<section class="cl-ver" id="${v.tag}" data-kinds="${kinds}">
  <header class="cl-side">
    <h2><a href="#${v.tag}">${v.tag.slice(1)}</a>${newest ? '<span class="cl-new">最新</span>' : ''}</h2>
    ${v.date ? `<time datetime="${v.date.iso}">${cnDate(v.date)}</time>` : ''}
    <p class="cl-meta"><span>${v.items.length} 项变化</span><a href="https://github.com/Callioper/Lumen/releases/tag/${v.tag}">安装包</a></p>
  </header>
  <div class="cl-body">
    ${v.intro ? `<p class="cl-intro">${v.intro}</p>` : ''}
    <ol class="cl-items">${v.items.map(itemHtml).join('')}</ol>
  </div>
</section>`;
}

// The page's own part: hero with the counts, the kind filter, the versions down a timeline.
export function changelogMain({ preface, versions }) {
  const total = count(versions);
  const chips = [{ key: 'all', label: '全部', n: total }, ...KINDS.map((k) => ({ key: k.key, label: k.label, n: count(versions, k.key) }))]
    .filter((c) => c.n)
    .map((c, i) => `<button type="button" data-show="${c.key}" aria-pressed="${i === 0}"><i data-kind="${c.key}"></i>${c.label}<span>${c.n}</span></button>`)
    .join('');
  return `<main class="cl" data-show="all">
  <div class="cl-hero">
    <div class="cl-title">
      <p class="cl-eyebrow"><span>LUMEN</span>学术 RSS 阅读器</p>
      <h1>更新日志</h1>
      <p class="cl-lead">每个版本加了什么、改了什么、修了什么，从新到旧排列。</p>
      ${preface ? `<p class="cl-note">${preface}</p>` : ''}
    </div>
    <dl class="cl-stats">
      <div><dt>版本</dt><dd>${versions.length}<small>个</small></dd></div>
      <div><dt>变化</dt><dd>${total}<small>项</small></dd></div>
      <div><dt>最近更新</dt><dd>${cnDate(versions[0]?.date, false)}</dd></div>
    </dl>
  </div>
  <div class="cl-bar"><div class="cl-filter" role="group" aria-label="按类型筛选">${chips}</div></div>
  <div class="cl-list">
${versions.map((v, i) => versionHtml(v, i === 0)).join('\n')}
  </div>
</main>
<script>
document.querySelector('.cl-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelector('.cl').dataset.show = b.dataset.show;
  for (const x of b.parentNode.children) x.setAttribute('aria-pressed', String(x === b));
});
</script>`;
}

// The home page's last chapter: the newest version's points, by kind, linking to its notes.
const LATEST_ITEMS = 5;
export function latestBlock({ versions }) {
  const v = versions[0];
  const shown = v.items.slice(0, LATEST_ITEMS);
  const more = v.items.length - shown.length;
  return `<div class="latest">
      <p class="latest-head"><a href="releases.html#${v.tag}"><b>${v.tag}</b>${v.date ? `<time datetime="${v.date.iso}">${v.date.iso}</time>` : ''}</a><span>最近更新</span></p>
      <ul>${shown.map((i) => `<li><span class="cl-badge" data-kind="${i.kind}">${kindLabel(i.kind)}</span>${i.lead || i.html}</li>`).join('')}</ul>
      <a class="latest-all" href="releases.html#${v.tag}">${more > 0 ? `还有 ${more} 项，` : ''}看完整更新日志 →</a>
    </div>`;
}
