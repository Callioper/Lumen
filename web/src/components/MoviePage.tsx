import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, type MoviePage as Movie } from '../api.ts';
import { addTr } from '../store.ts';
import { WishButton, Folded, Section, Comments, SimilarRow } from './BookPage.tsx';
import { Icon } from './Icon.tsx';
import { proxied } from '../util.ts';

const doubanMovie = (subject: string): string => `https://movie.douban.com/subject/${subject}/`;
const ACTORS_SHOWN = 6;

export function useMovie(subject: string | null): { state: { subject: string; page?: Movie; wished?: boolean; error?: string } | null; retry: () => void } {
  const [state, setState] = useState<{ subject: string; page?: Movie; wished?: boolean; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!subject) return;
    let live = true;
    setState(null);
    api.movie(subject)
      .then((r) => { addTr(r); if (live) setState(r.error ? { subject, error: r.error } : { subject, page: r.page, wished: r.wished }); })
      .catch((e: Error) => { if (live) setState({ subject, error: e.message }); });
    return () => { live = false; };
  }, [subject, attempt]);
  return { state: subject && state?.subject === subject ? state : null, retry: () => setAttempt((n) => n + 1) };
}

export function movieLines(m: Movie): { by: string; cast: string; facts: string; aka: string } {
  const cast = m.actors.slice(0, ACTORS_SHOWN).join(' / ') + (m.actors.length > ACTORS_SHOWN ? ` 等 ${m.actors.length} 人` : '');
  const facts = [m.genres.join(' '), m.countries.join(' '), m.languages.join(' '), m.pubdate[0], m.isTv && m.episodes ? `${m.episodes} 集` : '', m.durations[0]]
    .filter(Boolean).join(' · ');
  return { by: m.directors.length ? `导演 ${m.directors.join(' / ')}` : '', cast: cast && `主演 ${cast}`, facts, aka: m.aka.slice(0, 3).join(' / ') };
}

export function movieStat(m: Movie): string {
  return m.rating !== null ? `${m.rating.toFixed(1)} 分 · ${m.votes.toLocaleString()} 人评价` : '暂无评分';
}

// A film's or a series' page in Lumen, read through 豆瓣's mobile API: the head with the facts and
// the buttons, what friends said, the synopsis, 豆瓣's hot short comments and what is liked alongside.
export function MoviePage({ subject, cover, title, info, wished, onWished, friends }: {
  subject: string; cover?: string | null; title?: string; info?: string; wished?: boolean; onWished?: () => void; friends?: ComponentChildren;
}) {
  const { state, retry } = useMovie(subject);
  const m = state?.page ?? null;
  const lines = m ? movieLines(m) : null;
  const img = cover ?? m?.cover;
  return (
    <article class="bookpage moviepage">
      <header class="bp-head">
        {img ? <img class="bp-cover" src={proxied(img)} alt="" /> : <div class="bp-cover blank" aria-hidden="true">影</div>}
        <div class="bp-facts">
          <h1 class="bp-title"><a href={doubanMovie(subject)} target="_blank" rel="noopener noreferrer">{m?.title || title}</a>
            {m?.year && <small class="bp-year">（{m.year}）</small>}</h1>
          {m?.original && m.original !== m.title && <p class="bp-subtitle"><i>{m.original}</i></p>}
          {lines ? <>
            {lines.by && <p class="bp-by">{lines.by}</p>}
            {lines.cast && <p class="bp-line">{lines.cast}</p>}
            {lines.facts && <p class="bp-line">{lines.facts}</p>}
            {lines.aka && <p class="bp-line bp-specs">又名 {lines.aka}</p>}
            <p class="bp-stat">{movieStat(m!)}</p>
          </> : <>
            {info && <p class="bp-line">{info}</p>}
            {state?.error ? <p class="editions-note">{state.error}<button class="link" onClick={retry}>重试</button></p>
              : <p class="editions-note"><span class="spinner sm" /> 正在查豆瓣…</p>}
          </>}
          <div class="bp-actions">
            <WishButton kind="movie" subject={subject} done={!!wished || !!state?.wished} onDone={onWished} />
            <a class="btn" href={doubanMovie(subject)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />打开豆瓣<kbd>空格</kbd></a>
          </div>
        </div>
      </header>
      {friends}
      {m && m.intro.length > 0 && <Section title="剧情简介"><Folded lines={m.intro} clamp={4} /></Section>}
      {m && m.comments.length > 0 && (
        <Section title="豆瓣短评" note={`${m.commentTotal.toLocaleString()} 条 · 影评 ${m.reviewTotal.toLocaleString()}`}>
          <Comments comments={m.comments} total={m.commentTotal} reviews={m.reviewTotal} base={doubanMovie(subject)} reviewWord="影评" />
        </Section>
      )}
      {m && m.similar.length > 0 && <Section title="喜欢看的人也喜欢"><SimilarRow items={m.similar} kind="movie" /></Section>}
    </article>
  );
}
