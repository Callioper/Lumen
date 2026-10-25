// 关键词通道: names the reader keeps coming back to, drawn from what they starred, liked, archived
// or read through. Vectors blur proper names, so an article naming one of these gets a small lift
// and says why: 「提到了你常看的：海尔斯」. The names come from the vault's 人名库 (people met while
// archiving) plus the 《书名》 in kept titles; a name counts once it is in two kept articles.
// Bylines are left out: they mostly name a feed's staff writer, which the source score covers.
import type { DB } from '../db.ts';
import type { Person } from '../clip/library.ts';
import { plainText } from '../content/sanitize.ts';

const MIN_DOCS = 2;

// The vault's 人名库, read when the profile is rebuilt; set once at startup (main.ts).
let peopleSource: () => Person[] = () => [];
export function setPeopleSource(f: () => Person[]): void { peopleSource = f; }
export function people(): Person[] { try { return peopleSource(); } catch { return []; } }

const MAX_KEYWORDS = 80;
const KEPT_TEXT_CHARS = 4000;
const BOOK = /《([^《》]{2,24})》/g;
const MIN_LATIN = 4;
// A person's Chinese name, original and aliases; one-character names would match everywhere.
export function vocabulary(people: readonly Person[]): Map<string, string> {
  const out = new Map<string, string>();       // form → the name shown
  for (const p of people) {
    for (const f of [p.zh, p.original, ...p.aliases]) {
      const form = f.trim();
      if (!form || (/[㐀-鿿]/.test(form) ? form.length < 2 : form.length < MIN_LATIN)) continue;
      if (!out.has(form)) out.set(form, p.zh);
    }
  }
  return out;
}

export interface Keyword { name: string; forms: string[] }

// A short form running on into another transliterated syllable is someone else: 巴特 in 巴特勒.
const SHORT_FORM = 3;
const TRANSLITERATION = /[勒尔斯特德克森曼顿林姆纳娃娜莉拉罗利诺夫基奇茨蒂迪亚里]/;

// Longest match first: 「巴特」 inside 「巴特勒」 is Butler, not Barthes, when the library knows both.
export function namesMentioned(text: string, vocab: Map<string, string>): Set<string> {
  const forms = [...vocab.keys()].filter((f) => text.includes(f)).sort((a, b) => b.length - a.length);
  const covered: [number, number][] = [];
  const found = new Set<string>();
  for (const f of forms) {
    for (let at = text.indexOf(f); at >= 0; at = text.indexOf(f, at + 1)) {
      if (covered.some(([s, e]) => at < e && at + f.length > s)) continue;
      if (f.length <= SHORT_FORM && TRANSLITERATION.test(text[at + f.length] ?? '')) continue;
      covered.push([at, at + f.length]);
      found.add(vocab.get(f)!);
    }
  }
  return found;
}

// The names (by their Chinese form) in at least two kept articles, most often first.
export function keywordProfile(db: DB, keptIds: readonly number[], people: readonly Person[]): Keyword[] {
  if (!keptIds.length) return [];
  const vocab = vocabulary(people);
  const formsOf = new Map<string, Set<string>>();
  for (const [form, name] of vocab) formsOf.set(name, (formsOf.get(name) ?? new Set()).add(form));
  const get = db.prepare('SELECT COALESCE(title_zh, title) AS title, ai_summary, COALESCE(content_full, content) AS html FROM entry WHERE id = ?');
  const docs = new Map<string, number>();
  for (const id of keptIds) {
    const r = get.get(id) as { title: string; ai_summary: string | null; html: string | null } | undefined;
    if (!r) continue;
    const text = `${r.title} ${plainText(r.ai_summary ?? '', 1000)} ${plainText(r.html ?? '', KEPT_TEXT_CHARS)}`;
    const found = namesMentioned(text, vocab);
    for (const m of r.title.matchAll(BOOK)) { const b = `《${m[1].trim()}》`; found.add(b); formsOf.set(b, new Set([b])); }
    for (const n of found) docs.set(n, (docs.get(n) ?? 0) + 1);
  }
  return [...docs].filter(([, n]) => n >= MIN_DOCS).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYWORDS)
    .map(([name]) => ({ name, forms: [...(formsOf.get(name) ?? [name])] }));
}

// The reader's names an article mentions (title, author, summary), as shown; `vocab` keeps a short
// form from matching inside another person's longer name.
export function keywordHits(keywords: readonly Keyword[], text: string, vocab: Map<string, string>): string[] {
  const hit = keywords.filter((k) => k.forms.some((f) => text.includes(f)));
  if (!hit.length) return [];
  const named = namesMentioned(text, new Map([...vocab, ...hit.flatMap((k) => k.forms.filter((f) => !vocab.has(f)).map((f) => [f, k.name] as [string, string]))]));
  return hit.filter((k) => named.has(k.name)).map((k) => k.name);
}
