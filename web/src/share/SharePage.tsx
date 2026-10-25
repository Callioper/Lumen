import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.ts';
import { ShareDialog } from './ShareDialog.tsx';
import { clip, dropTitle, SUMMARY_CHARS, QUOTE_CHARS, type ShareData } from './data.ts';
import { cardPng, copyPng } from './render.ts';
import { cx } from '../util.ts';

const POLL_MS = 1500;
const POLL_TRIES = 30;      // the server gives the AI 40 s

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

// /share/<id>, opened by the browser extension: copies the card at once, and stays open for
// another style or a saved file.
export function SharePage({ id }: { id: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const notify = (text: string, isError = false): void => { setToast({ text, error: isError }); setTimeout(() => setToast(null), isError ? 6000 : 3000); };

  useEffect(() => {
    document.title = 'Lumen 分享图';
    let live = true;
    const show = (d: ShareData, again: boolean): void => {
      const card = { ...d, summary: d.summary && clip(dropTitle(d.summary, d.title), SUMMARY_CHARS), quote: d.quote && clip(d.quote.replace(/\s*\n\s*/g, '\n'), QUOTE_CHARS) };
      setData(card);
      // The tab was just opened from the extension and has focus, which is what the clipboard asks for.
      const done = again ? 'AI 摘要已补上，已重新复制' : card.quote ? '已复制摘录分享图，可直接粘贴' : '已复制分享图，可直接粘贴';
      copyPng(cardPng(card, { dark: dark(), serif: false, quote: !!card.quote }))
        .then(() => notify(d.pending ? `${done}；AI 摘要生成中，好了会替换` : done))
        .catch(() => notify(again ? 'AI 摘要已补上，点「复制图片」复制新图' : '没能自动复制（浏览器要求先点一下页面），点「复制图片」即可', true));
      if (d.aiNote) notify(d.aiNote, true);
    };
    // The first copy goes out at once; the AI's text replaces it when it comes.
    const poll = (tries: number): void => {
      if (!live) return;
      if (tries <= 0) { notify('AI 摘要太久没回来，先用现在这张', true); return; }
      setTimeout(() => {
        if (!live) return;
        api.share(id).then((d) => (d.pending ? poll(tries - 1) : show(d, true)), () => { /* expired or offline: keep the card */ });
      }, POLL_MS);
    };
    api.share(id).then((d) => {
      show(d, false);
      if (d.pending) poll(POLL_TRIES);
    }, (e: Error) => setError(e.message));
    return () => { live = false; };
  }, [id]);

  if (error) return <main class="share-back standalone"><p class="muted">{error}</p></main>;
  if (!data) return <main class="share-back standalone"><span class="spinner" /></main>;
  return (
    <>
      <ShareDialog standalone data={data} initial={{ dark: dark(), serif: false, quote: !!data.quote }} notify={notify} onClose={() => window.close()} />
      {toast && <div class={cx('toast', toast.error && 'error')} role="status">{toast.text}</div>}
    </>
  );
}
