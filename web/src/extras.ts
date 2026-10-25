// The page's half of server/extras.ts: what only the author's own install shows (web/src/private/,
// left out of the published code and out of the demo). Loaded once before the first render; without
// it the slots below draw nothing.
import { h, type JSX } from 'preact';

// A 想读 tracker of the author's own (where each wished book stands), by 豆瓣 book subject.
export interface Desk {
  has: (subject: string) => boolean;                       // on the desk, so as good as 想读
  Tag: (p: { subject: string }) => JSX.Element | null;     // a tag on a 书影榜 card
  Line: (p: { subject: string }) => JSX.Element | null;    // a line on a book's page
}

export interface WebExtras {
  useDesk?: (subjects: readonly string[]) => Desk;
  LoginNotice?: () => JSX.Element | null;                  // above 标记 when the 豆瓣 login has ended
}

const loaders = import.meta.glob<{ default: WebExtras }>('./private/index.tsx');
let loaded: WebExtras = {};

export async function loadWebExtras(): Promise<void> {
  const load = Object.values(loaders)[0];
  if (load && !import.meta.env.VITE_DEMO) loaded = (await load()).default;
}

const NO_DESK: Desk = { has: () => false, Tag: () => null, Line: () => null };
// The same function on every render: loaded is settled before the first one.
export const useDesk = (subjects: readonly string[]): Desk => (loaded.useDesk ? loaded.useDesk(subjects) : NO_DESK);
export const LoginNotice = (): JSX.Element | null => (loaded.LoginNotice ? h(loaded.LoginNotice, {}) : null);
