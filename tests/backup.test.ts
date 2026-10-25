import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { backupIfDue, backupDue, rotateBackups, backupsIn } from '../server/backup.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'lumen-backup-'));

test('rotation keeps the newest four backups and touches nothing else', () => {
  const dir = scratch();
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']) writeFileSync(join(dir, `lumen-${d}.db`), '');
  writeFileSync(join(dir, 'notes.txt'), '');
  assert.deepEqual(rotateBackups(dir), ['lumen-2026-09-01.db']);
  assert.deepEqual(readdirSync(dir).sort(), ['lumen-2026-09-08.db', 'lumen-2026-09-15.db', 'lumen-2026-09-22.db', 'lumen-2026-09-29.db', 'notes.txt']);
  rmSync(dir, { recursive: true });
});

test('a backup is due when there is none or the newest is a week old', () => {
  const dir = scratch();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(backupDue(dir, now), true);
  const f = join(dir, 'lumen-2026-10-20.db');
  writeFileSync(f, '');
  utimesSync(f, now - 86400, now - 86400);
  assert.equal(backupDue(dir, now), false);
  utimesSync(f, now - 8 * 86400, now - 8 * 86400);
  assert.equal(backupDue(dir, now), true);
  rmSync(dir, { recursive: true });
});

test('the copy holds the library and is made only once while it is fresh', async () => {
  const dir = scratch();
  const path = join(dir, 'lumen.db');
  const db = openDb(path);
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某号')").run();
  const out = join(dir, 'backup');
  const made = await backupIfDue(path, out);
  assert.ok(made);
  const copy = openDb(made!);
  assert.equal((copy.prepare('SELECT title FROM feed').get() as { title: string }).title, '某号');
  copy.close();
  assert.equal(await backupIfDue(path, out), null);
  assert.equal(backupsIn(out).length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
