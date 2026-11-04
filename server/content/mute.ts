// 屏蔽词: an entry whose title (or its Chinese title) contains one comes in already read. It is not
// deleted — 全部 and search still show it, and r makes it unread again — so a word set too wide loses
// nothing. Matched as plain text, case aside, so 「抽奖」 needs no escaping and 「AI」 also takes 「ai」.
import type { DB } from '../db.ts';

const MAX_WORDS = 200;
const MAX_WORD_CHARS = 40;

// The words as kept in settings: trimmed, no blanks or repeats, each and all within bounds.
export function normalizeMuteWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.trim().slice(0, MAX_WORD_CHARS);
    if (!w || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// The first word the title contains, or null.
export function mutedBy(title: string, titleZh: string | null, words: readonly string[]): string | null {
  const hay = `${title}\n${titleZh ?? ''}`.toLowerCase();
  return words.find((w) => w && hay.includes(w.toLowerCase())) ?? null;
}

// The unread entries the words cover, marked read now; how many there were.
export function applyMuteWords(db: DB, words: readonly string[], now = Math.floor(Date.now() / 1000)): number {
  if (!words.length) return 0;
  const unread = db.prepare('SELECT id, title, title_zh FROM entry WHERE is_read = 0').all() as { id: number; title: string; title_zh: string | null }[];
  const hit = unread.filter((e) => mutedBy(e.title, e.title_zh, words)).map((e) => e.id);
  const mark = db.prepare('UPDATE entry SET is_read = 1, read_at = ? WHERE id = ? AND is_read = 0');
  for (const id of hit) mark.run(now, id);
  return hit.length;
}
