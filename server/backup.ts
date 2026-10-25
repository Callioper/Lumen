// 备份 and the write-ahead log. The library is kept for good now, so a compacted copy is written
// once a week (VACUUM INTO, in a worker so the server keeps answering) and the newest few kept.
// The WAL is cut back after each maintenance pass: left alone it stayed at several hundred MB.
import { Worker } from 'node:worker_threads';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { DATA_DIR } from './config.ts';
import { log } from './log.ts';

export const BACKUP_DIR = process.env.LUMEN_BACKUP_DIR ?? join(DATA_DIR, 'backup');
const BACKUP_EVERY_S = 7 * 86400;
const BACKUPS_KEPT = 4;
const BACKUP_NAME = /^lumen-\d{4}-\d{2}-\d{2}\.db$/;

export function trimWal(db: DB): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

const day = (t: number): string => new Date(t * 1000).toLocaleDateString('sv-SE');   // 2026-10-22, local

// The backups in a folder, newest first.
export function backupsIn(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort().reverse(); } catch { return []; }
}

// The oldest beyond the newest `keep` are removed; only files named like a backup are touched.
export function rotateBackups(dir: string, keep = BACKUPS_KEPT): string[] {
  const doomed = backupsIn(dir).slice(keep);
  for (const f of doomed) rmSync(join(dir, f), { force: true });
  return doomed;
}

export function backupDue(dir: string, now: number): boolean {
  const newest = backupsIn(dir)[0];
  if (!newest) return true;
  return now - Math.floor(statSync(join(dir, newest)).mtimeMs / 1000) >= BACKUP_EVERY_S;
}

// The copy is made by a worker on its own connection; a half-written file never takes a backup's name.
function vacuumInto(source: string, target: string): Promise<void> {
  const code = `const { DatabaseSync } = require('node:sqlite');
    const { workerData: w } = require('node:worker_threads');
    const db = new DatabaseSync(w.source, { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(w.target); } finally { db.close(); }`;
  return new Promise((done, fail) => {
    const worker = new Worker(code, { eval: true, workerData: { source, target } });
    worker.once('error', fail);
    worker.once('exit', (c) => (c === 0 ? done() : fail(new Error(`备份进程退出码 ${c}`))));
  });
}

let running = false;
export async function backupIfDue(dbPath: string, dir = BACKUP_DIR, now = Math.floor(Date.now() / 1000)): Promise<string | null> {
  if (running || !backupDue(dir, now)) return null;
  running = true;
  const target = join(dir, `lumen-${day(now)}.db`);
  const partial = `${target}.partial`;
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(partial, { force: true });
    const started = Date.now();
    await vacuumInto(dbPath, partial);
    renameSync(partial, target);
    const removed = rotateBackups(dir);
    log.info(`[backup] ${target}，${Math.round(statSync(target).size / 1e6)} MB，${Math.round((Date.now() - started) / 1000)} 秒${removed.length ? `；删去旧备份 ${removed.join('、')}` : ''}`);
    return target;
  } catch (e) {
    rmSync(partial, { force: true });
    log.error(`[backup] 备份失败：${(e as Error).message}`);
    return null;
  } finally {
    running = false;
  }
}
