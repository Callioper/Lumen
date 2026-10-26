// 想读 / 想看 marked in this session, by 豆瓣 subject. Every page's button reads it, so a mark made on
// one page (新书, 标记, 书影榜, a list, the reader) shows on the others before they load again; the
// server's `wished` covers the marks made before.
import { createContext } from 'preact';
import { signal } from '@preact/signals';

export const wishedNow = signal<ReadonlySet<string>>(new Set());

export function noteWished(subject: string): void {
  if (!wishedNow.value.has(subject)) wishedNow.value = new Set([...wishedNow.value, subject]);
}

export const isWished = (subject: string | null | undefined): boolean => !!subject && wishedNow.value.has(subject);

// Whether the author's 想读台 holds a book (web/src/extras.ts), given by a page that asked for all of its
// books at once, so the cards inside need not each ask.
export const DeskHas = createContext<(subject: string) => boolean>(() => false);
