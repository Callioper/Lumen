import { useState, useEffect } from 'preact/hooks';
import { ShareCard, type CardStyle } from './ShareCard.tsx';
import { cardPng, copyPng, savePng } from './render.ts';
import type { ShareData } from './data.ts';
import { cx } from '../util.ts';

// Preview with the choices that matter for a picture: light or dark, serif or not, and, when
// text was selected, whether it is a quote card or the article card.
export function ShareDialog({ data, initial, onClose, notify, standalone = false }: {
  data: ShareData; initial: CardStyle; onClose: () => void; notify: (text: string, error?: boolean) => void; standalone?: boolean;
}) {
  const [style, setStyle] = useState<CardStyle>(initial);
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  useEffect(() => {
    if (standalone) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [standalone]);
  const run = async (what: 'copy' | 'save'): Promise<void> => {
    setBusy(what);
    try {
      const png = cardPng(data, style);
      if (what === 'copy') { await copyPng(png); notify('已复制分享图'); } else { savePng(await png, data.title); }
    } catch (e) {
      notify(`分享图${what === 'copy' ? '复制' : '保存'}失败：${(e as Error).message}`, true);
    } finally {
      setBusy(null);
    }
  };
  const flip = (k: keyof CardStyle): void => setStyle({ ...style, [k]: !style[k] });
  return (
    <div class={cx('modal-back', 'share-back', standalone && 'standalone')} onClick={(e) => { if (!standalone && e.target === e.currentTarget) onClose(); }}>
      <div class="share-dialog" role="dialog" aria-modal="true" aria-label="分享图">
        <div class="share-preview"><ShareCard data={data} style={style} /></div>
        <div class="share-side">
          <h3>分享图</h3>
          {data.quote && (
            <div class="seg">
              <button class={cx(style.quote && 'on')} onClick={() => setStyle({ ...style, quote: true })}>摘录卡</button>
              <button class={cx(!style.quote && 'on')} onClick={() => setStyle({ ...style, quote: false })}>文章卡</button>
            </div>
          )}
          <div class="seg">
            <button class={cx(!style.dark && 'on')} onClick={() => style.dark && flip('dark')}>浅色</button>
            <button class={cx(style.dark && 'on')} onClick={() => !style.dark && flip('dark')}>深色</button>
          </div>
          <div class="seg">
            <button class={cx(!style.serif && 'on')} onClick={() => style.serif && flip('serif')}>黑体</button>
            <button class={cx(style.serif && 'on')} onClick={() => !style.serif && flip('serif')}>宋体</button>
          </div>
          <span class="grow" />
          <button class="btn primary" disabled={!!busy} onClick={() => void run('copy')}>{busy === 'copy' ? <><span class="spinner sm" />生成中</> : '复制图片'}</button>
          <button class="btn" disabled={!!busy} onClick={() => void run('save')}>{busy === 'save' ? <><span class="spinner sm" />生成中</> : '保存 PNG'}</button>
          {!standalone && <button class="btn ghost" onClick={onClose}>关闭</button>}
          <p class="small muted">{standalone
            ? <>二维码指向原文。打开本页时已自动复制；插件快捷键 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>。</>
            : <>二维码指向原文。在阅读页按 <kbd>p</kbd> 可跳过预览直接复制。</>}</p>
        </div>
      </div>
    </div>
  );
}
