// 按钮说明: with ? pressed (or the note card's button), every control on screen that carries a title
// gets a small tag with it, and a table of the keys opens beside them. The titles are the app's own
// hover texts, so the tags say what the real build says; nothing here adds a word to a button.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';

export const labelsOn = signal(false);
export const toggleLabels = (): void => { labelsOn.value = !labelsOn.value; };

const CONTROLS = 'button[title], [role="button"][title], a[title], button[aria-label]';
const MAX_CHARS = 22;
const REFRESH_MS = 300;

interface Tag { key: string; x: number; y: number; text: string }

const short = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);
// Hover texts that only repeat what the control already shows.
const SAYS_NOTHING = new Set(['展开', '收起', '关闭']);
const TAG_H = 18;
const WIDE = 120;
const MAX_W = 180;
// About how wide a tag is drawn (11px text, 12px padding), to keep tags off each other.
const widthOf = (s: string): number => Math.min(MAX_W, 12 + [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 11 : 6.5), 0));
const overlaps = (a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && Math.abs(a.y - b.y) < TAG_H;

// What is on screen now, skipping the demo's own overlay and anything hidden or scrolled away. A wide
// control (a sidebar row) gets its tag at its right end, over its count; a small one just below it;
// a tag that would land on another moves down a line.
function tagsOnScreen(): Tag[] {
  const placed: { x: number; y: number; w: number }[] = [];
  const out: Tag[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (el.closest('.demo-layer')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
    const full = (el.title || el.getAttribute('aria-label') || '').trim();
    if (!full || SAYS_NOTHING.has(full) || full === (el.textContent ?? '').trim()) continue;
    const text = short(full);
    const w = widthOf(text);
    const at = r.width >= WIDE ? { x: r.right - w - 4, y: r.top + (r.height - TAG_H) / 2, w } : { x: r.left, y: r.bottom + 2, w };
    for (let i = 0; i < 4 && placed.some((p) => overlaps(p, at)); i++) at.y += TAG_H;
    placed.push(at);
    out.push({ key: `${out.length}`, x: Math.max(4, Math.min(at.x, window.innerWidth - w - 4)), y: at.y, text });
  }
  return out;
}

const KEYS: [string, string][] = [
  ['j / k', '下一篇 / 上一篇'], ['r 或 m', '已读 / 未读'], ['f 或 s', '收藏'], ['l', '喜欢'],
  ['x / X', '少推这类 / 少推这个源'], ['空格、o、↵', '打开原文'], ['v', '抓取全文'], ['t', '翻译；再按切换双语、译文、原文'],
  ['c', '存档到 Obsidian'], ['p', '复制分享图'], ['Shift+K', '把上面的都标为已读'], ['Shift+A', '全部标为已读'],
  ['q', '全部源立即抓取'], ['/', '搜索'], ['h', '标记页回总览'], ['Esc', '关掉阅读器 / 返回上一层'], ['?', '显示或收起按钮说明'],
];

const px = (n: number): string => `${Math.round(n)}px`;

export function ButtonLabels() {
  const [tags, setTags] = useState<Tag[]>([]);
  const on = labelsOn.value;
  useEffect(() => {
    if (!on) return;
    const draw = (): void => setTags(tagsOnScreen());
    draw();
    const timer = setInterval(draw, REFRESH_MS);
    return () => clearInterval(timer);
  }, [on]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (e.key !== '?' || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      e.preventDefault();
      toggleLabels();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!on) return null;
  return (
    <>
      <div class="demo-labels" aria-hidden="true">
        {tags.map((t) => <span key={t.key} class="demo-label" style={{ left: px(t.x), top: px(t.y) }}>{t.text}</span>)}
      </div>
      <aside class="demo-keys" aria-label="快捷键">
        <header><h3>快捷键</h3><button class="icon-btn" onClick={toggleLabels} aria-label="收起按钮说明">×</button></header>
        <dl>{KEYS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        <p>按钮旁的小标签就是它的作用；再按 <kbd>?</kbd> 收起。</p>
      </aside>
    </>
  );
}
