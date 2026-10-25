import { useEffect, useState } from 'preact/hooks';
import { api, type Editions } from '../api.ts';
import { addTr } from '../store.ts';

// A book's 豆瓣 page as Lumen keeps it (asked once a month at most): its other editions and,
// from the same fetch, what the page says of the book (SubjectPage).
export interface SubjectState { subject: string; data?: Editions; error?: string }

export function useSubject(subject: string | null): { state: SubjectState | null; retry: () => void } {
  const [state, setState] = useState<SubjectState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!subject) return;
    let live = true;
    setState(null);
    api.editions(subject)
      .then((data) => { addTr(data); if (live) setState(data.error ? { subject, error: data.error } : { subject, data }); })
      .catch((e: Error) => { if (live) setState({ subject, error: e.message }); });
    return () => { live = false; };
  }, [subject, attempt]);
  return { state: state && state.subject === subject ? state : null, retry: () => setAttempt((n) => n + 1) };
}

// 这本书的其他版本. titled: false under a 「其他版本」 toggle that already names it.
export function EditionList({ subject, titled = true }: { subject: string; titled?: boolean }) {
  const { state, retry } = useSubject(subject);
  return <EditionsView state={state} retry={retry} titled={titled} />;
}

export function EditionsView({ state, retry, titled = true }: { state: SubjectState | null; retry: () => void; titled?: boolean }) {
  if (!state) return <section class="editions">{titled && <h3>其他版本</h3>}<p class="editions-note"><span class="spinner sm" /> 正在查豆瓣…</p></section>;
  if (state.error) {
    return (
      <section class="editions">{titled && <h3>其他版本</h3>}
        <p class="editions-note">{state.error}<button class="link" onClick={retry}>重试</button></p>
      </section>
    );
  }
  const d = state.data!;
  if (!d.editions.length) return <section class="editions">{titled && <h3>其他版本</h3>}<p class="editions-note">豆瓣上只有这一版</p></section>;
  return (
    <section class="editions">
      <h3>{titled && '其他版本'}{d.works && <a href={`https://book.douban.com/works/${d.works}`} target="_blank" rel="noopener noreferrer">全部 {d.total}</a>}</h3>
      <ul>
        {d.editions.map((e) => (
          <li key={e.subject}>
            <a href={`https://book.douban.com/subject/${e.subject}/`} target="_blank" rel="noopener noreferrer">
              <span class="ed-pub">{e.publisher}</span><span class="ed-year">{e.year}</span>
            </a>
            <span class="ed-stat">{e.rating !== null && <b>{e.rating.toFixed(1)}</b>}{e.readers > 0 && `${e.readers.toLocaleString()} 人读过`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
