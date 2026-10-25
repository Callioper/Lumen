import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, type SubjectPage, type ShortComment, type Similar } from '../api.ts';
import { notify, subjectTrail } from '../store.ts';
import { useSubject, EditionsView } from './Editions.tsx';
import { Tr, TrParas } from './Tr.tsx';
import { Icon } from './Icon.tsx';
import { proxied, cx } from '../util.ts';

const doubanBook = (subject: string): string => `https://book.douban.com/subject/${subject}/`;

// What a 想读 / 想看 click came to: written to 豆瓣 too (server/extras.ts), or kept in Lumen.
export const wishNote = (want: string, synced: boolean, title?: string): string =>
  synced ? `已在豆瓣标为${want}${title ? `：${title}` : ''}` : `已记为${want}${title ? `：${title}` : ''}（记在 Lumen 里）`;

// 想读 / 想看 a subject. done: already marked, from the card, the page or the author's 想读台.
export function WishButton({ kind, subject, done, onDone }: { kind: 'book' | 'movie'; subject: string; done: boolean; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(false);
  const label = kind === 'book' ? ['想读', '已想读'] : ['想看', '已想看'];
  const wished = done || now;
  const wish = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.doubanWish(kind, subject);
      setNow(true);
      onDone?.();
      notify(wishNote(label[0], r.synced));
    } catch (e) { notify((e as Error).message, true); }
    setBusy(false);
  };
  return (
    <button class={cx('btn', wished ? 'done' : 'primary')} disabled={busy || wished} onClick={() => void wish()}>
      {busy ? <span class="spinner sm" /> : <Icon name={wished ? 'check' : 'bookmark'} size={14} />}{wished ? label[1] : label[0]}
    </button>
  );
}

// The lines under the title, from the page's info block: who wrote and translated it, who brought
// it out and when, what it was called, and what it is as an object.
export function bookLines(p: SubjectPage): { subtitle: string; by: string; pub: string; orig: string; series: string; specs: string } {
  const f = new Map(p.fields);
  const by = [f.get('作者') && `${f.get('作者')} 著`, f.get('译者') && `${f.get('译者')} 译`].filter(Boolean).join(' / ');
  const pub = [f.get('出版社'), f.get('出品方')?.split(' / ').at(-1), f.get('出版年')].filter(Boolean).join(' · ');
  const specs = [f.get('页数') && `${f.get('页数')}页`, f.get('装帧'), f.get('定价'), f.get('ISBN') && `ISBN ${f.get('ISBN')}`].filter(Boolean).join(' · ');
  return { subtitle: f.get('副标题') ?? '', by, pub, orig: f.get('原作名') ?? '', series: f.get('丛书') ?? '', specs };
}

export function statLine(p: SubjectPage): string {
  const rating = p.rating !== null ? `${p.rating.toFixed(1)} 分 · ${p.votes.toLocaleString()} 人评价` : '暂无评分';
  return [rating, p.doing && `${p.doing.toLocaleString()} 在读`, p.done && `${p.done.toLocaleString()} 读过`, p.wish && `${p.wish.toLocaleString()} 想读`].filter(Boolean).join(' · ');
}

export function Folded({ lines, clamp, children }: { lines: string[]; clamp: number; children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const long = lines.join('').length > clamp * 60 || lines.length > clamp;
  return (
    <div class={cx('bp-text', long && !open && 'clamped')} style={{ '--clamp': clamp }}>
      <div class="bp-text-body"><TrParas lines={lines} /></div>
      {long && <button class="link" onClick={() => setOpen(!open)}>{open ? '收起' : '展开全部'}</button>}
      {children}
    </div>
  );
}

const TOC_FOLD = 12;
function Toc({ toc }: { toc: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? toc : toc.slice(0, TOC_FOLD);
  return (
    <>
      <ol class="bp-toc">{shown.map((l, i) => <li key={i}>{l}</li>)}</ol>
      {toc.length > TOC_FOLD && <button class="link" onClick={() => setOpen(!open)}>{open ? '收起' : `展开全部 ${toc.length} 行`}</button>}
    </>
  );
}

const SHOWN_COMMENTS = 3;
const STARS = 5;
function Stars({ n }: { n: number }) {
  const k = Math.max(0, Math.min(STARS, Math.round(n)));
  return <span class="bp-stars" aria-label={`${k} 星`}>{'★'.repeat(k)}<span>{'★'.repeat(STARS - k)}</span></span>;
}
// base: the subject's 豆瓣 page; reviews are 书评 or 影评.
export function Comments({ comments, total, reviews, base, reviewWord }: { comments: ShortComment[]; total: number; reviews: number; base: string; reviewWord: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? comments : comments.slice(0, SHOWN_COMMENTS);
  return (
    <>
      <ul class="bp-comments">
        {shown.map((c, i) => (
          <li key={i}>
            <p class="bp-c-who"><strong>{c.who}</strong>{c.stars !== null && <Stars n={c.stars} />}
              <span class="bp-c-time">{c.time}</span>{c.votes > 0 && <span class="bp-c-votes">{c.votes} 有用</span>}</p>
            <p class="bp-c-text"><Tr text={c.text} block /></p>
          </li>
        ))}
      </ul>
      <p class="bp-more">
        {comments.length > SHOWN_COMMENTS && <button class="link" onClick={() => setAll(!all)}>{all ? '收起' : `再看 ${comments.length - SHOWN_COMMENTS} 条`}</button>}
        <a href={`${base}comments/`} target="_blank" rel="noopener noreferrer">豆瓣全部短评 {total.toLocaleString()}</a>
        {reviews > 0 && <a href={`${base}reviews`} target="_blank" rel="noopener noreferrer">{reviewWord} {reviews.toLocaleString()}</a>}
      </p>
    </>
  );
}

// 喜欢读/看的人也喜欢: a row of covers, each opened here, over the page it was found on.
export function SimilarRow({ items, kind }: { items: Similar[]; kind: 'book' | 'movie' }) {
  return (
    <ul class={cx('bp-similar', kind)}>
      {items.map((s) => (
        <li key={s.subject}>
          <button onClick={() => { subjectTrail.value = [...subjectTrail.value, { kind, subject: s.subject }]; }} title={s.title}>
            {s.cover ? <img src={proxied(s.cover)} alt="" loading="lazy" width={72} height={104} /> : <span class="bp-sim-blank">{kind === 'book' ? '书' : '影'}</span>}
            <span class="bp-sim-title">{s.title}</span>
            {s.rating !== null && <span class="bp-sim-rate">{s.rating.toFixed(1)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, note, children }: { title: string; note?: string; children: ComponentChildren }) {
  return <section class="bp-sec"><h2 class="dossier-h">{title}{note && <span>{note}</span>}</h2>{children}</section>;
}

// A book's page in Lumen, read from its 豆瓣 page: the head with the facts and the buttons, then
// what friends said (friends, from the card), the blurb, the contents, the author, 豆瓣's short
// comments, the books liked alongside (opened here, one over another) and the other editions.
export function BookPage({ subject, cover, title, info, wished, onWished, aside, friends }: {
  subject: string; cover?: string | null; title?: string; info?: string; wished?: boolean; onWished?: () => void;
  aside?: ComponentChildren; friends?: ComponentChildren;
}) {
  const { state, retry } = useSubject(subject);
  const p = state?.data?.page ?? null;
  const lines = p ? bookLines(p) : null;
  const img = cover ?? p?.cover;
  return (
    <article class="bookpage">
      <header class="bp-head">
        {img ? <img class="bp-cover" src={proxied(img)} alt="" /> : <div class="bp-cover blank" aria-hidden="true">书</div>}
        <div class="bp-facts">
          <h1 class="bp-title"><a href={doubanBook(subject)} target="_blank" rel="noopener noreferrer">{p?.title ? <Tr text={p.title} block /> : title}</a></h1>
          {lines?.subtitle && <p class="bp-subtitle">{lines.subtitle}</p>}
          {lines ? <>
            {lines.by && <p class="bp-by">{lines.by}</p>}
            {lines.pub && <p class="bp-line">{lines.pub}</p>}
            {lines.orig && <p class="bp-line">原作名 <i>{lines.orig}</i></p>}
            {lines.series && <p class="bp-line">丛书 {lines.series}</p>}
            {lines.specs && <p class="bp-line bp-specs">{lines.specs}</p>}
            <p class="bp-stat">{statLine(p!)}</p>
          </> : <>
            {info && <p class="bp-line">{info}</p>}
            {state?.error ? <p class="editions-note">{state.error}<button class="link" onClick={retry}>重试</button></p>
              : <p class="editions-note"><span class="spinner sm" /> 正在查豆瓣…</p>}
          </>}
          <div class="bp-actions">
            <WishButton kind="book" subject={subject} done={!!wished || !!state?.data?.wished} onDone={onWished} />
            <a class="btn" href={doubanBook(subject)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />打开豆瓣<kbd>空格</kbd></a>
          </div>
          {aside}
        </div>
      </header>
      {friends}
      {p && p.intro.length > 0 && <Section title="内容简介"><Folded lines={p.intro} clamp={4} /></Section>}
      {p && p.toc.length > 0 && <Section title="目录" note={`${p.toc.length} 行`}><Toc toc={p.toc} /></Section>}
      {p && p.authorIntro.length > 0 && (
        <section class="bp-sec">
          <details class="bp-author"><summary class="dossier-h">作者简介</summary><TrParas lines={p.authorIntro} /></details>
        </section>
      )}
      {p && p.comments.length > 0 && <Section title="豆瓣短评" note={`${p.commentTotal} 条 · 书评 ${p.reviewTotal}`}><Comments comments={p.comments} total={p.commentTotal} reviews={p.reviewTotal} base={doubanBook(subject)} reviewWord="书评" /></Section>}
      {p && p.similar.length > 0 && (
        <Section title="喜欢读的人也喜欢">
          <SimilarRow items={p.similar} kind="book" />
        </Section>
      )}
      <Section title="其他版本"><EditionsView state={state} retry={retry} titled={false} /></Section>
    </article>
  );
}
