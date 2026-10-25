import { shareUrl, printedUrl, type ShareData } from './data.ts';
import { qrPath } from './qr.ts';
import { cx } from '../util.ts';

export interface CardStyle { dark: boolean; serif: boolean; quote: boolean }

const dateOf = (ts: number): string => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

// Colours as attributes: the image export drops CSS fills inside SVG, which left a black square.
function Qr({ url }: { url: string }) {
  const { size, d } = qrPath(url);
  return (
    <svg class="sc-qr" viewBox={`-2 -2 ${size + 4} ${size + 4}`} shape-rendering="crispEdges" aria-hidden="true">
      <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#ffffff" />
      <path d={d} fill="#1d1b17" />
    </svg>
  );
}

// 540 CSS px wide, exported at 2× to 1080 px. Everything it shows comes from ShareData,
// so the reader and the browser extension's page produce the same card.
export function ShareCard({ data, style }: { data: ShareData; style: CardStyle }) {
  const quote = style.quote && !!data.quote;
  const url = data.url ? shareUrl(data.url) : '';
  // 「某某老师 的 bilibili 动态」 already names the author.
  const byline = [data.author && !data.source.includes(data.author) ? data.author : '', data.published ? dateOf(data.published) : ''].filter(Boolean).join(' · ');
  return (
    <div class={cx('share-card', style.dark && 'dark', style.serif && 'serif', quote && 'is-quote')}>
      <header class="sc-src">
        {data.icon && <img class="sc-icon" src={data.icon} alt="" />}
        <span class="sc-source">{data.source}</span>
        {byline && <span class="sc-byline">{byline}</span>}
      </header>

      {quote ? (
        <>
          <span class="sc-mark" aria-hidden="true">“</span>
          <blockquote class="sc-quote">{data.quote}</blockquote>
          <p class="sc-from">—— 《{data.title}》</p>
        </>
      ) : (
        <>
          {data.cover && <div class="sc-cover"><img src={data.cover} alt="" /></div>}
          <h1 class="sc-title">{data.title}</h1>
          {data.titleOrig && <p class="sc-orig">{data.titleOrig}</p>}
          {data.summary && <p class="sc-summary">{data.summary}</p>}
        </>
      )}

      <footer class="sc-foot">
        <div class="sc-brand">
          <b>Lumen</b>
          <span>{url ? '扫码阅读原文' : '来自 Lumen 阅读器'}</span>
          {url && <span class="sc-url">{printedUrl(url)}</span>}
        </div>
        {url && <Qr url={url} />}
      </footer>
    </div>
  );
}
