// Find in the open article (Ctrl+F). The hits are painted with the CSS Custom Highlight API, so the
// article's DOM is never touched: no <mark> to undo, nothing for a re-render or a translation to fight.
// The desktop app (Electron) has no find of its own, and in a browser the page's find also searches
// the list and the sidebar; this one searches only the article.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { Icon } from './Icon.tsx';

const HIT = 'lumen-find';
const CURRENT = 'lumen-find-current';
const MAX_HITS = 2000;
const SCROLL_MARGIN = 0.3;     // the current hit is brought to this fraction of the scroller's height

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

// The text nodes under root, joined, with where each one starts, so a word split by <em> or <a> is still found.
function textOf(root: HTMLElement): { text: string; nodes: Text[]; starts: number[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('script, style, noscript, iframe') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  return { text, nodes, starts };
}

// The node holding character `at`, and the offset in it (binary search over starts).
function locate(starts: number[], at: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const { text, nodes, starts } = textOf(root);
  const hay = text.toLowerCase();
  const out: Range[] = [];
  for (let at = hay.indexOf(q); at >= 0 && out.length < MAX_HITS; at = hay.indexOf(q, at + q.length)) {
    const a = locate(starts, at), b = locate(starts, at + q.length - 1);
    const r = document.createRange();
    r.setStart(nodes[a], at - starts[a]);
    r.setEnd(nodes[b], at + q.length - starts[b]);
    out.push(r);
  }
  return out;
}

function paint(ranges: Range[], current: number): void {
  if (!supported) return;
  CSS.highlights.set(HIT, new Highlight(...ranges));
  if (ranges[current]) CSS.highlights.set(CURRENT, new Highlight(ranges[current]));
  else CSS.highlights.delete(CURRENT);
}

function clearPaint(): void {
  if (!supported) return;
  CSS.highlights.delete(HIT);
  CSS.highlights.delete(CURRENT);
}

function bringIntoView(scroller: HTMLElement, r: Range): void {
  const box = r.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top >= view.top + 40 && box.bottom <= view.bottom - 40) return;
  scroller.scrollTo({ top: scroller.scrollTop + box.top - view.top - view.height * SCROLL_MARGIN });
}

interface Props {
  scroller: RefObject<HTMLDivElement | null>;
  // Changes whenever what the article shows changes (another entry, 全文/摘录, 译文), so the hits are found again.
  contentKey: string;
}

export function FindBar({ scroller, contentKey }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Ctrl/⌘+F opens it; pressed again while it has the focus, the browser's own find is let through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      if (document.activeElement === input.current) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Found again when the query or the article changes; images loading do not change the text.
  useEffect(() => {
    const root = scroller.current?.querySelector<HTMLElement>('article');
    if (!open || !root) { clearPaint(); setHits([]); return; }
    const raf = requestAnimationFrame(() => {
      const found = findRanges(root, query.trim());
      setHits(found);
      setCurrent(0);
      paint(found, 0);
      if (found[0] && scroller.current) bringIntoView(scroller.current, found[0]);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, query, contentKey]);

  useEffect(() => clearPaint, []);

  const go = (delta: 1 | -1): void => {
    if (!hits.length) return;
    const next = (current + delta + hits.length) % hits.length;
    setCurrent(next);
    paint(hits, next);
    if (scroller.current) bringIntoView(scroller.current, hits[next]);
  };
  const close = (): void => { setOpen(false); clearPaint(); };

  if (!open) return null;
  const q = query.trim();
  return (
    <div class="find-bar" role="search">
      <Icon name="search" size={14} />
      <input ref={input} value={query} placeholder="在本文中查找" aria-label="在本文中查找" autoComplete="off"
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        }} />
      <span class={hits.length || !q ? 'find-count' : 'find-count none'}>
        {q ? (hits.length ? `${current + 1}/${hits.length}${hits.length >= MAX_HITS ? '+' : ''}` : '无结果') : ''}
      </span>
      <button class="icon-btn" title="上一处 (Shift+Enter)" disabled={!hits.length} onClick={() => go(-1)}>↑</button>
      <button class="icon-btn" title="下一处 (Enter)" disabled={!hits.length} onClick={() => go(1)}>↓</button>
      <button class="icon-btn" title="关闭 (Esc)" onClick={close}><Icon name="x" size={14} /></button>
      {!supported && <span class="find-count none">此浏览器不支持高亮</span>}
    </div>
  );
}
