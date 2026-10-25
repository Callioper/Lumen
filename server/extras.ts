// Hooks for optional local extensions (a server/private/ folder, not part of this repository): when
// one is there it registers itself here at start, and everything else asks before using it. Without
// one, Lumen keeps 想读 / 想看 to itself and adds no routes.
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import type { DB } from './db.ts';

export interface Extras {
  // An extension may also pass 想读 / 想看 on elsewhere; false when there was nothing to do.
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
