// 想读 / 想看 on an entry whose link is a 豆瓣 book or film (server/content/subjects.ts): a small pill on
// the list's cards and in the reader, the same mark 标记 and 书影榜 make.
import { useState } from 'preact/hooks';
import { api, type EntrySubject } from '../api.ts';
import { notify } from '../store.ts';
import { wishNote } from './BookPage.tsx';
import { isWished, noteWished } from '../wishes.ts';
import { cx } from '../util.ts';

const WORDS: Record<EntrySubject['kind'], [string, string]> = { book: ['想读', '已想读'], movie: ['想看', '已想看'] };

export function SubjectWish({ s, class: cls }: { s: EntrySubject; class?: string }) {
  const [busy, setBusy] = useState(false);
  const [want, had] = WORDS[s.kind];
  if (s.mine) return <span class={cx('book-wished', cls)} title="你在豆瓣上的标记">我{s.mine}</span>;
  if (s.wished || isWished(s.subject)) return <span class={cx('book-wished', cls)}>{had}</span>;
  const wish = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    setBusy(true);
    try {
      const r = await api.doubanWish(s.kind, s.subject);
      noteWished(s.subject);
      notify(wishNote(want, r.synced));
    } catch (err) {
      notify((err as Error).message, true);
    }
    setBusy(false);
  };
  return (
    <button class={cx('book-wish', cls)} disabled={busy} onClick={(e) => void wish(e)} onAuxClick={(e) => e.stopPropagation()}>
      {busy ? '标记中…' : want}
    </button>
  );
}
