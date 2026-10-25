// What only the author's own install has (server/private/, left out of the published code): when
// that folder is there it registers itself here at start, and everything else asks before using it.
// Without it Lumen keeps 想读 / 想看 to itself, and the private routes are simply not there.
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import type { DB } from './db.ts';

export interface Extras {
  // 想读 / 想看 written to the reader's own 豆瓣 account too; false when it already was.
  doubanWish?: (kind: 'book' | 'movie', subject: string) => Promise<boolean>;
  routes?: (app: Hono, db: DB) => void;
}

export const extras: Extras = {};

const PRIVATE = new URL('./private/index.ts', import.meta.url);

// A private folder that is there but broken fails the start, rather than quietly running without it.
export async function loadExtras(): Promise<boolean> {
  if (!existsSync(PRIVATE)) return false;
  await import(PRIVATE.href);
  return true;
}
