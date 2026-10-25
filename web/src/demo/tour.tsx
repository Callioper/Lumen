// The demo's guide (vite build --mode demo only), three layers over the app:
//   - 这一页: a card in the corner saying what the page on screen is and what can be done there (pages.ts);
//   - 导览: seven chapters of steps that go to a page and frame the thing to look at (chapters.ts);
//   - 按钮说明: ? tags every control with its hover text and opens the key table (labels.tsx).
// Plus the welcome on the empty reading pane. Nothing here is in the real build: every use is behind DEMO.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { select } from '../store.ts';
import { reportKind } from '../reports.ts';
import { CHAPTERS, findTarget } from './chapters.ts';
import { pageKey, noteOf } from './pages.ts';
import { ButtonLabels, labelsOn, toggleLabels } from './labels.tsx';
import { DOWNLOADS, REPO } from './links.ts';

export const DEMO = !!import.meta.env.VITE_DEMO;

const at = signal<{ c: number; s: number } | null>(null);
const picking = signal(false);
export const startTour = (): void => { picking.value = true; };
const startChapter = (c: number): void => { picking.value = false; at.value = { c, s: 0 }; };

// The element a step frames, once its page has drawn it.
async function find(step: (typeof CHAPTERS)[number]['steps'][number], tries = 40): Promise<Element | null> {
  for (let i = 0; i < tries; i++) {
    const el = findTarget(step.target);
    if (el) return el;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return null;
}

const BUBBLE_W = 360;
const SETTLE_MS = 700;
const BUBBLE_H = 220;   // before the bubble is measured: about three lines of text
// Preact 11 leaves a bare number in a style as it is, which the browser drops.
const px = (n: number): string => `${Math.round(n)}px`;
const EDGE = 12;        // the bubble's least distance from the screen's edge
const PAD = 10;         // room between the target and its frame
const GAP = 18;         // room between the frame and the bubble, where the arrow sits
const ARROW_IN = 22;    // the arrow keeps this far from the bubble's corners
const NARROW = 640;     // at or under this width the bubble is a sheet along the bottom

// The page dimmed around the target: one SVG with a rounded hole, so the dim and the frame share
// their corners. (A box-shadow wide enough to cover the screen is not drawn by Chrome.)
function Spotlight({ box }: { box: DOMRect }) {
  const hole = { x: px(box.left - PAD), y: px(box.top - PAD), width: px(box.width + 2 * PAD), height: px(box.height + 2 * PAD) };
  return (
    <>
      <svg class="demo-tour-dim" aria-hidden="true">
        <defs>
          <mask id="demo-tour-hole">
            <rect width="100%" height="100%" fill="#fff" />
            <rect class="demo-tour-hole" rx="12" style={hole} fill="#000" />
          </mask>
        </defs>
        <rect class="demo-tour-shade" width="100%" height="100%" mask="url(#demo-tour-hole)" />
      </svg>
      <div class="demo-tour-frame" style={{ left: hole.x, top: hole.y, width: hole.width, height: hole.height }} />
    </>
  );
}

// A target larger than the screen is framed only where it shows, with the frame kept on screen.
const visible = (r: DOMRect): DOMRect => {
  const inset = PAD + 3;
  const top = Math.max(r.top, inset), bottom = Math.min(r.bottom, window.innerHeight - inset);
  const left = Math.max(r.left, inset), right = Math.min(r.right, window.innerWidth - inset);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
};

type Side = 'below' | 'above' | 'over' | 'sheet';
interface Place { side: Side; left: number; top: number; width: number; arrow: number }
// Where the bubble goes: under the target when there is room, else over it; a whole-page target has
// it at the bottom of the screen, and a phone has it as a sheet there.
function place(box: DOMRect | null, h: number): Place {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (vw <= NARROW) return { side: 'sheet', left: EDGE, top: vh - h - EDGE, width: vw - 2 * EDGE, arrow: 0 };
  const width = Math.min(BUBBLE_W, vw - 2 * EDGE);
  if (!box) return { side: 'over', left: (vw - width) / 2, top: vh / 3, width, arrow: 0 };
  // A wide target (a heading across the page) keeps its bubble at its right end, off what it heads.
  const from = box.width > 2 * width ? box.right - width : box.left;
  const left = Math.min(Math.max(EDGE, from), vw - width - EDGE);
  const arrow = Math.min(Math.max(ARROW_IN, box.left + box.width / 2 - left), width - ARROW_IN);
  if (box.height > vh * 0.6) return { side: 'over', left, top: vh - h - 56, width, arrow: 0 };
  if (box.bottom + PAD + GAP + h + EDGE < vh) return { side: 'below', left, top: box.bottom + PAD + GAP, width, arrow };
  if (box.top - PAD - GAP - h > EDGE) return { side: 'above', left, top: box.top - PAD - GAP - h, width, arrow };
  return { side: 'over', left, top: vh - h - 56, width, arrow: 0 };
}

const go = (to: { c: number; s: number } | null): void => { at.value = to; };
// One step on or back, across chapters; past the last step the tour ends.
const stepBy = (d: 1 | -1): void => {
  const pos = at.value;
  if (!pos) return;
  const n = CHAPTERS[pos.c].steps.length;
  if (d > 0) go(pos.s + 1 < n ? { c: pos.c, s: pos.s + 1 } : CHAPTERS[pos.c + 1] ? { c: pos.c + 1, s: 0 } : null);
  else if (pos.s > 0) go({ c: pos.c, s: pos.s - 1 });
};

const WAIT_MS = 4500;   // longer than find() polls: a step whose target never draws still gets its bubble

function TourStep({ c, s }: { c: number; s: number }) {
  const chapter = CHAPTERS[c];
  const step = chapter.steps[s];
  const [box, setBox] = useState<DOMRect | null>(null);
  const [lost, setLost] = useState(false);
  const [h, setH] = useState(BUBBLE_H);
  const bubble = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let el: Element | null = null;
    setBox(null);
    const giveUp = setTimeout(() => { if (live && !el) setLost(true); }, WAIT_MS);
    void step.go().then(() => find(step)).then((found) => {
      if (!live) return;
      if (!found) { setLost(true); return; }
      el = found;
      // A tall target shows from its top; a small one is brought to the middle, clear of the bubble.
      // Again a moment later: pictures and fetched sections above it can still push it down.
      const bring = (): void => { if (live && el?.isConnected) el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center' }); };
      bring();
      setTimeout(bring, SETTLE_MS);
    });
    // Follows the element while the page scrolls or settles, and the bubble as its text wraps.
    const timer = setInterval(() => {
      if (el?.isConnected) setBox(visible(el.getBoundingClientRect()));
      if (bubble.current) setH(bubble.current.offsetHeight);
    }, 120);
    return () => { live = false; clearInterval(timer); clearTimeout(giveUp); };
  }, [c, s]);
  // The first button takes the focus, so Enter and Tab work from the start; the page is not scrolled for it.
  const ready = !!box || lost;
  useEffect(() => { if (ready) bubble.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus({ preventScroll: true }); }, [ready]);
  const n = chapter.steps.length;
  const last = s === n - 1;
  const next = CHAPTERS[c + 1];
  const p = place(box, h);
  return (
    <div class="demo-tour" role="dialog" aria-label={`导览：${chapter.title}`}>
      {box && <Spotlight box={box} />}
      {ready && (
        <div ref={bubble} class={`demo-tour-bubble side-${p.side}`}
          style={{ left: px(p.left), top: px(p.top), width: px(p.width), '--arrow': px(p.arrow) }}>
          <header class="demo-tour-head">
            <span class="demo-tour-chapter">{chapter.title}</span>
            <span class="demo-tour-count">{s + 1} / {n}</span>
          </header>
          <ol class="demo-tour-dots" aria-hidden="true">
            {chapter.steps.map((_, i) => <li key={i} class={i === s ? 'on' : i < s ? 'done' : ''} />)}
          </ol>
          <h3>{step.title}</h3>
          <p>{step.text}</p>
          {lost && <p class="demo-tour-lost">这一步要看的东西没出现在这个窗口里，可以直接看下一步。</p>}
          {last && !next && (
            <p class="demo-tour-get">就这些。想换成自己的订阅，<a href={DOWNLOADS} target="_blank" data-demo-out>下载 Lumen</a>，或者<a href={REPO} target="_blank" data-demo-out>看源码</a>。</p>
          )}
          <div class="demo-tour-actions">
            <button class="btn ghost" onClick={() => go(null)}>结束</button>
            {s > 0 && <button class="btn" onClick={() => stepBy(-1)}>上一步</button>}
            <button class="btn primary" onClick={() => stepBy(1)}>
              {!last ? '下一步' : next ? `下一章：${next.title}` : '完成'}
            </button>
          </div>
          <footer class="demo-tour-foot">
            <span class="demo-tour-keys"><kbd>←</kbd><kbd>→</kbd> 翻页 · <kbd>Esc</kbd> 结束</span>
            {last && <button class="link" onClick={() => { at.value = null; picking.value = true; }}>换一章看</button>}
          </footer>
        </div>
      )}
    </div>
  );
}

function ChapterPicker() {
  const total = CHAPTERS.reduce((n, c) => n + c.steps.length, 0);
  return (
    <div class="modal-back demo-picker-back" onClick={(e) => { if (e.target === e.currentTarget) picking.value = false; }}>
      <section class="demo-picker" role="dialog" aria-label="选一章导览">
        <header>
          <h2>带你看一遍</h2>
          <button class="icon-btn" onClick={() => { picking.value = false; }} aria-label="关闭">×</button>
        </header>
        <p class="demo-picker-lead">七章共 {total} 步，每章单独能看。第一章是三分钟的特色，之后按侧栏从上到下。</p>
        <ol>
          {CHAPTERS.map((c, i) => (
            <li key={c.key}>
              <button onClick={() => startChapter(i)}>
                <span class="demo-picker-n">{i}</span>
                <span class="demo-picker-body"><strong>{c.title}</strong><small>{c.blurb}</small></span>
                <span class="demo-picker-steps">{c.steps.length} 步</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ── 这一页：右下角的说明卡 ──────────────────────────────────────────────────────────────────────
const FOLD_KEY = 'lumen.demo.noteFolded';
const readFolded = (): boolean => {
  try { const v = localStorage.getItem(FOLD_KEY); return v === null ? window.innerWidth <= NARROW : v === '1'; } catch { return window.innerWidth <= NARROW; }
};
const folded = signal(readFolded());
const setFolded = (v: boolean): void => {
  folded.value = v;
  try { localStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* folded for this visit only */ }
};

function PageNoteCard() {
  const k = pageKey.value;
  if (!k || at.value) return null;
  const n = noteOf(k);
  if (folded.value) {
    return <button class="demo-page-chip" onClick={() => setFolded(false)} title="这一页是做什么的">这一页：{n.name}</button>;
  }
  return (
    <aside class="demo-page-note" aria-label="这一页的说明">
      <header>
        <span class="demo-feat">这一页</span><strong>{n.name}</strong>
        <button class="icon-btn" onClick={() => setFolded(true)} aria-label="收起说明" title="收起说明">–</button>
      </header>
      <p>{n.text}</p>
    </aside>
  );
}

// The home page links straight to a page of the demo: demo/#see=notices opens 学术动态.
const SEE = /^#see=(\w+)$/;

export function TourOverlay() {
  useEffect(() => {
    const open = (): void => {
      const key = SEE.exec(location.hash)?.[1];
      const feature = FEATURES.find((f) => f.key === key);
      if (feature) void feature.go();
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  useEffect(() => {
    // During the tour the arrows turn its pages and are kept from the reader's own keys.
    const onKey = (e: KeyboardEvent): void => {
      if (at.value && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault(); e.stopPropagation();
        stepBy(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (e.key !== 'Escape') return;
      if (at.value) { at.value = null; e.stopPropagation(); } else if (picking.value) { picking.value = false; e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const pos = at.value;
  return (
    <div class="demo-layer">
      <ButtonLabels />
      {pos && <TourStep key={`${pos.c}:${pos.s}`} c={pos.c} s={pos.s} />}
      {picking.value && <ChapterPicker />}
      {!pos && (
        <div class="demo-dock">
          <PageNoteCard />
          <div class="demo-dock-buttons">
            <button class={labelsOn.value ? 'demo-dock-btn on' : 'demo-dock-btn'} onClick={toggleLabels} title="每个按钮是干什么的（?）">按钮说明 <kbd>?</kbd></button>
            <button class="demo-dock-btn primary" onClick={startTour}>带我看一遍</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 首页：Lumen 有什么不一样 ────────────────────────────────────────────────────────────────────
const goReport = (k: 'daily' | 'weekly' | 'papers'): Promise<void> => { reportKind.value = k; return select({ kind: 'reports' }); };
interface Feature { key: string; title: string; line: string; go: () => Promise<void> }
const FEATURES: Feature[] = [
  { key: 'notices', title: '学术动态', line: '从公众号推文里读出来的会议和征稿，按截止日期排。', go: () => select({ kind: 'notices' }) },
  { key: 'books', title: '新书', line: '书单推文拆成封面墙，可以只看 Zotero 里还没有的。', go: () => select({ kind: 'books' }) },
  { key: 'tocs', title: '期刊目录', line: '公众号推的目录和知网 RSS，都拼成整期来看。', go: () => select({ kind: 'tocs' }) },
  { key: 'hot', title: '书影榜', line: '豆瓣友邻这个月标得最多的书和电影。', go: () => select({ kind: 'hot' }) },
  { key: 'daily', title: '日报', line: '每天挑出值得看的文章，最后放一篇你平时不会点开的。', go: () => goReport('daily') },
];

export function DemoWelcome() {
  return (
    <section class="demo-welcome">
      <p class="scope-ov-kicker">演示站</p>
      <h1>从这五页看起</h1>
      <p class="demo-welcome-lead">Lumen 是一个学术向的 RSS 阅读器。这里的订阅、文章、书和人都是编的，改了也不会保存。</p>
      <div class="demo-welcome-actions">
        <button class="btn primary" onClick={() => startChapter(0)}>三分钟看特色（{CHAPTERS[0].steps.length} 步）</button>
        <button class="btn" onClick={startTour}>按章看全部功能</button>
        <span class="demo-welcome-hint">任何一页按 <kbd>?</kbd> 看每个按钮是干什么的</span>
      </div>
      <p class="demo-welcome-get">
        <span>想用自己的订阅？</span>
        <a href={DOWNLOADS} target="_blank" data-demo-out>下载桌面版（Windows / Mac / Linux）</a>
        <a href={REPO} target="_blank" data-demo-out>源码与安装说明</a>
      </p>
      <ol class="demo-features">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.line}</p>
            <button class="btn ghost" onClick={() => void f.go()}>去看看</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// The sidebar's mark on the five pages the demo is about.
export const FeatureMark = () => <span class="demo-feat">特色</span>;
