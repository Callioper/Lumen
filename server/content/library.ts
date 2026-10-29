// Which books Zotero already has, from a copy of its database: the local API's ?q= search costs ~3 s a
// title and misses some, and with Zotero open its sqlite answers "locked" even to a read-only connection.
// Copying the file (and its -wal) takes well under a second; the copy is reused for a while.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.ts';
import { normTitle } from '../report/ngram.ts';
import { log } from '../log.ts';

const FRESH_MS = 30 * 60_000;
const MIN_TITLE = 2;
const MIN_MAIN_TITLE = 4;    // a main title shorter than this (「悲剧」) matches too much on its own

// withPdf: the same keys for the items that carry a PDF of their own (an imported file, not a link
// to one elsewhere, which can point at a disk long gone, and not in the bin).
export interface Library { isbns: Set<string>; titles: Set<string>; withPdf: { isbns: Set<string>; titles: Set<string> } }

let cached: { at: number; stamp: string; lib: Library } | null = null;

// Where Zotero keeps its database: the setting (main.ts hands it over), else Zotero's own default.
// LUMEN_ZOTERO_DB wins over both (the demo points it at an invented library).
let zoteroDb = '';
export function useZoteroDb(path: string): void {
  if (path !== zoteroDb) cached = null;
  zoteroDb = path;
}
const dbFile = (): string => process.env.LUMEN_ZOTERO_DB ?? (zoteroDb || join(homedir(), 'Zotero', 'zotero.sqlite'));
// No Zotero here: the pages leave out what only it could answer (在库, 只看未在库).
export const hasLibrary = (): boolean => existsSync(dbFile());

// Zotero's file and its -wal as they stand: unchanged, the last copy is still right and is not redone.
const stampOf = (file: string): string => [file, ...[file, file + '-wal']
  .map((f) => { const st = statSync(f, { throwIfNoEntry: false }); return st ? `${st.mtimeMs}:${st.size}` : '-'; })].join('|');

// The 13-digit form of an ISBN-10, so either printing matches.
export function isbn13(isbn: string): string {
  const d = isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (d.length !== 10) return d;
  const core = '978' + d.slice(0, 9);
  const sum = [...core].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return core + ((10 - (sum % 10)) % 10);
}

// The title and the main title before a subtitle, normalised: 「美学中的不满」 matches 「美学中的不满：…」.
export function titleKeys(title: string): string[] {
  const full = normTitle(title), main = normTitle(title.split(/[：:]|——/)[0]);
  return [...new Set([full.length >= MIN_TITLE ? full : '', main.length >= MIN_MAIN_TITLE ? main : ''].filter(Boolean))];
}

export function buildLibrary(rows: readonly { field: string; value: string; pdf?: number | boolean }[]): Library {
  const lib: Library = { isbns: new Set(), titles: new Set(), withPdf: { isbns: new Set(), titles: new Set() } };
  for (const r of rows) {
    const sets = r.pdf ? [lib, lib.withPdf] : [lib];
    if (r.field === 'ISBN') for (const one of r.value.split(/[\s,;，；]+/)) { const d = isbn13(one); if (d.length === 13) for (const x of sets) x.isbns.add(d); }
    else for (const t of titleKeys(r.value)) for (const x of sets) x.titles.add(t);
  }
  return lib;
}

const RETRY_MS = 60_000;
let failed: { at: number; stamp: string } | null = null;

// null when the database cannot be read: "not checked", never "not in the library".
export function zoteroLibrary(now = Date.now()): Library | null {
  if (cached && now - cached.at < FRESH_MS) return cached.lib;
  const file = dbFile();
  if (!existsSync(file)) return null;
  const stamp = stampOf(file);
  if (cached && cached.stamp === stamp) { cached = { ...cached, at: now }; return cached.lib; }
  // A copy that failed (Zotero mid-write) is not tried again on every page of 新书 for a minute.
  if (failed && failed.stamp === stamp && now - failed.at < RETRY_MS) return null;
  const dir = join(DATA_DIR, 'cache', 'zotero');
  try {
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'zotero.sqlite');
    rmSync(copy + '-shm', { force: true });
    copyFileSync(file, copy);
    // Recent writes sit in the -wal until Zotero checkpoints; without it the copy is behind.
    if (existsSync(file + '-wal') && statSync(file + '-wal').size) copyFileSync(file + '-wal', copy + '-wal');
    else rmSync(copy + '-wal', { force: true });   // a stale -wal from last time must not be replayed
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT f.fieldName AS field, v.value, d.itemID IN (SELECT a.parentItemID FROM itemAttachments a
          WHERE a.contentType = 'application/pdf' AND a.linkMode = 0 AND a.itemID NOT IN (SELECT itemID FROM deletedItems)) AS pdf
        FROM itemData d JOIN fields f ON f.fieldID = d.fieldID
        JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE f.fieldName IN ('title', 'ISBN') AND d.itemID NOT IN (SELECT itemID FROM deletedItems)`).all() as { field: string; value: string; pdf: number }[];
      cached = { at: now, stamp, lib: buildLibrary(rows) };
      return cached.lib;
    } finally { db.close(); }
  } catch (e) {
    log.warn(`[books] Zotero 库读不了：${(e as Error).message}`);
    failed = { at: now, stamp };
    return null;
  }
}

export function inLibrary(lib: Pick<Library, 'isbns' | 'titles'>, book: { title: string; isbn: string }): boolean {
  if (book.isbn && lib.isbns.has(isbn13(book.isbn))) return true;
  return titleKeys(book.title).some((t) => lib.titles.has(t));
}

// A book's page: in the library with a PDF, in it without one, or not in it. The title is tried
// with its subtitle too, since Zotero keeps 「失去：现代社会的基本问题」 and 豆瓣 the bare 「失去」.
export type Owned = 'pdf' | 'nopdf' | 'none';
export function ownedState(lib: Library, book: { title: string; subtitle: string; isbn: string }): Owned {
  const tries = [book.title, ...(book.subtitle ? [`${book.title}：${book.subtitle}`] : [])].map((title) => ({ title, isbn: book.isbn }));
  if (tries.some((b) => inLibrary(lib.withPdf, b))) return 'pdf';
  return tries.some((b) => inLibrary(lib, b)) ? 'nopdf' : 'none';
}
