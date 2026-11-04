// Two things laid over the app: a picture from the article at full size (click a picture in the reader),
// and the list of keyboard shortcuts (?). Both close with Esc or a click outside.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Icon } from './Icon.tsx';

// The pictures of the article the viewer was opened from, and which one is shown.
export const viewer = signal<{ srcs: string[]; at: number } | null>(null);
export const shortcutsOpen = signal(false);

// A lazy picture not scrolled to yet has no currentSrc, only its src.
const srcOf = (i: HTMLImageElement): string => i.currentSrc || i.src;

// A click on a picture in the article body opens it, unless the picture is a link (it goes where it links).
export function openPictureFrom(e: MouseEvent): void {
  const img = (e.target as HTMLElement).closest('img');
  if (!img || img.closest('a') || !srcOf(img)) return;
  const root = img.closest('.content') ?? img.parentElement;
  const all = [...(root?.querySelectorAll('img') ?? [])].filter((i) => !i.closest('a') && srcOf(i));
  e.preventDefault();
  viewer.value = { srcs: all.map(srcOf), at: Math.max(0, all.indexOf(img)) };
}

// Keys the overlays take before the app's own shortcuts; true when one of them used it.
export function overlayKey(e: KeyboardEvent): boolean {
  const v = viewer.value;
  if (v) {
    if (e.key === 'Escape') viewer.value = null;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') viewer.value = { ...v, at: (v.at + 1) % v.srcs.length };
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') viewer.value = { ...v, at: (v.at - 1 + v.srcs.length) % v.srcs.length };
    return true;
  }
  if (shortcutsOpen.value) {
    if (e.key === 'Escape' || e.key === '?') shortcutsOpen.value = false;
    return true;
  }
  return false;
}

export function ImageViewer() {
  const v = viewer.value;
  useEffect(() => {
    if (!v) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, [!!v]);
  if (!v) return null;
  const many = v.srcs.length > 1;
  const step = (d: number) => (e: MouseEvent): void => { e.stopPropagation(); viewer.value = { ...v, at: (v.at + d + v.srcs.length) % v.srcs.length }; };
  return (
    <div class="viewer-back" role="dialog" aria-label="查看图片" onClick={() => { viewer.value = null; }}>
      <img class="viewer-img" src={v.srcs[v.at]} alt="" onClick={(e) => e.stopPropagation()} />
      <button class="viewer-close icon-btn" title="关闭 (Esc)" onClick={() => { viewer.value = null; }}><Icon name="x" /></button>
      {many && <>
        <button class="viewer-nav prev" title="上一张 (←)" onClick={step(-1)}>‹</button>
        <button class="viewer-nav next" title="下一张 (→)" onClick={step(1)}>›</button>
        <span class="viewer-count">{v.at + 1} / {v.srcs.length}</span>
      </>}
      <a class="viewer-orig" href={v.srcs[v.at]} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>新标签页打开原图</a>
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['浏览', [
    ['j / ↓', '下一篇（到底接下个分类）'], ['k / ↑', '上一篇'], ['空格 / o / Enter', '打开原文'],
    ['/', '搜索当前列表'], ['Ctrl + F', '在本文中查找'], ['Esc', '关闭阅读器 / 弹窗'], ['?', '显示 / 关闭本面板'],
  ]],
  ['标记', [
    ['r / m', '已读 / 未读'], ['f / s', '收藏'], ['Shift + K', '以上标为已读'], ['Shift + J', '以下标为已读'], ['Shift + A', '全部标为已读'],
    ['l', '喜欢'], ['x', '少推这类'], ['Shift + X', '少推这个源'],
  ]],
  ['阅读与存档', [
    ['v', '抓取全文'], ['t', '翻译 / 切换译文'], ['c', '存档到 Obsidian'], ['Shift + C', '选择存档方式'],
    ['p', '复制分享图'], ['q', '刷新全部订阅'], ['h', '书影音标记：回到首页'],
  ]],
];

export function ShortcutsPanel() {
  if (!shortcutsOpen.value) return null;
  return (
    <div class="modal-back" onClick={() => { shortcutsOpen.value = false; }}>
      <section class="shortcuts" role="dialog" aria-label="快捷键" onClick={(e) => e.stopPropagation()}>
        <header><h2>快捷键</h2><button class="icon-btn" title="关闭 (Esc)" onClick={() => { shortcutsOpen.value = false; }}><Icon name="x" /></button></header>
        <div class="shortcuts-cols">
          {SHORTCUTS.map(([group, keys]) => (
            <div key={group}>
              <h3>{group}</h3>
              <dl>{keys.map(([k, what]) => <div key={k}><dt>{k.split(' / ').map((x, i) => <>{i > 0 && ' / '}<kbd>{x}</kbd></>)}</dt><dd>{what}</dd></div>)}</dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
