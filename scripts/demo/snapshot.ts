// Answers every read the web app makes against the demo library and writes them into one file the
// static demo serves from (web/src/demo/fixture.json). Run scripts/demo/seed.ts first.
// Usage: node scripts/demo/snapshot.ts [dataDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
process.env.LUMEN_DATA = resolve(process.argv[2] ?? join(ROOT, 'demo', 'data'));
process.env.LUMEN_ZOTERO_DB = join(process.env.LUMEN_DATA, 'zotero.sqlite');   // the invented one, never the reader's own
const OUT = join(ROOT, 'web', 'src', 'demo', 'fixture.json');

// The demo is answered from its own library alone: a request that would leave this machine (豆瓣, B站,
// an AI) means the seed is missing something, and the snapshot stops rather than take in a real answer.
const outside: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  outside.push(url);
  throw new Error(`演示快照不连外网：${url}`);
}) as typeof fetch;

const { openDb } = await import('../../server/db.ts');
const { loadSettings, loadSecrets } = await import('../../server/config.ts');
const { Scheduler } = await import('../../server/fetch/scheduler.ts');
const { Enricher } = await import('../../server/ai/enrich.ts');
const { Embedder } = await import('../../server/rec/embed.ts');
const { Translator } = await import('../../server/ai/translate.ts');
const { Jobs } = await import('../../server/jobs.ts');
const { apiApp } = await import('../../server/api/routes.ts');
const { EFFECTIVE_LAYOUT_SQL } = await import('../../server/api/queries.ts');
const { plainText } = await import('../../server/content/sanitize.ts');

const settings = loadSettings();
const secrets = loadSecrets();
const db = openDb(join(process.env.LUMEN_DATA, 'lumen.db'));
const events = new EventTarget();
const noop = (): void => {};
const app = apiApp({
  db, events, jobs: new Jobs(events),
  scheduler: new Scheduler(db, () => settings, noop),
  enricher: new Enricher(db, () => settings, () => secrets, noop),
  embedder: new Embedder(db, () => settings, () => secrets),
  translator: new Translator(db, () => settings, () => secrets, noop),
  getSettings: () => settings, setSettings: noop, getSecrets: () => secrets, setSecrets: noop,
});

async function get<T = unknown>(path: string): Promise<T> {
  const res = await app.request(path);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

type Item = { id: number; [k: string]: unknown };
const feeds = db.prepare('SELECT id FROM feed').all() as { id: number }[];

// Every entry, once with the short and once with the long snippet (the card layouts ask for it).
const items: Item[] = [];
const long: Record<number, string> = {};
for (const f of feeds) {
  items.push(...(await get<{ items: Item[] }>(`/entries?feed=${f.id}&limit=200`)).items);
  for (const it of (await get<{ items: Item[] }>(`/entries?feed=${f.id}&snippet=long&limit=200`)).items) long[it.id] = it.snippet as string;
}

// What the client needs to filter a scope itself.
const meta = Object.fromEntries((db.prepare(`SELECT e.id, f.view, f.category_id AS category, ${EFFECTIVE_LAYOUT_SQL} AS layout,
    (SELECT json_group_array(name) FROM tag t WHERE t.entry_id = e.id AND t.source != 'clip') AS tags,
    EXISTS (SELECT 1 FROM tag t WHERE t.entry_id = e.id AND t.source = 'clip') AS archived,
    e.title || ' ' || COALESCE(e.title_zh, '') || ' ' || COALESCE(e.author, '') AS head, COALESCE(e.content, '') AS body
  FROM entry e JOIN feed f ON f.id = e.feed_id`).all() as { id: number; view: string; category: number; layout: string; tags: string; archived: number; head: string; body: string }[])
  .map((r) => [r.id, { view: r.view, category: r.category, layout: r.layout, tags: JSON.parse(r.tags) as string[], archived: !!r.archived,
    head: r.head, body: plainText(r.body).replace(/\s+/g, ' ').slice(0, 2000), longSnippet: long[r.id] }]));

// Name the 推荐 clusters after the topic most of their members carry, as the model would.
const profile0 = await get<{ clusters: { anchor: number; samples: { id: number }[] }[] }>('/rec/profile');
for (const c of profile0.clusters) {
  const counts = new Map<string, number>();
  for (const s of c.samples) for (const t of (meta[s.id]?.tags ?? []) as string[]) if (t !== '待写') counts.set(t, (counts.get(t) ?? 0) + 1);
  const name = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (name) db.prepare('INSERT OR REPLACE INTO rec_cluster (anchor, name, hidden, by_user, updated_at) VALUES (?, ?, 0, 0, ?)').run(c.anchor, name, Math.floor(Date.now() / 1000));
}

const rec = await get<{ items: Item[]; meta: unknown; total: number }>('/entries?sort=rec&limit=200');
const details: Record<number, unknown> = {};
const related: Record<number, unknown> = {};
const books: Record<number, unknown> = {};
const friends: Record<number, unknown> = {};
const comments: Record<number, unknown> = {};
for (const it of items) {
  details[it.id] = await get(`/entries/${it.id}`);
  related[it.id] = await get(`/entries/${it.id}/related`);
  if (/书单|好书/.test(it.title as string)) books[it.id] = await get(`/entries/${it.id}/books`);
  const f = await get<{ subjects: unknown[] }>(`/entries/${it.id}/friends`);
  if (f.subjects.length) friends[it.id] = f;
  if ((details[it.id] as { comment_source?: string }).comment_source) comments[it.id] = await get(`/entries/${it.id}/comments`);
}
// Each way 新书 can be asked for that the server works out (shelves, what Zotero has); the rest the page filters itself.
const newBooks = async (sort: string): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const notOwned of [0, 1]) for (const shelves of [0, 1]) {
    out[`${notOwned}${shelves}`] = await get(`/books?offset=0&limit=200&sort=${sort}&recent=0&notOwned=${notOwned}&shelves=${shelves}`);
  }
  return out;
};
const reportsList = await get<{ reports: { kind: string; period: string }[] }>('/reports');
const reports: Record<string, unknown> = {};
for (const r of reportsList.reports) reports[`${r.kind}/${r.period}`] = await get(`/reports/${r.kind}/${encodeURIComponent(r.period)}`);

const hot = await get('/hot');
const editions: Record<string, unknown> = {};
const movies: Record<string, unknown> = {};
for (const { subject, page } of db.prepare('SELECT subject, page FROM douban_subject WHERE editions_at IS NOT NULL').all() as { subject: string; page: string | null }[]) {
  if (page && (JSON.parse(page) as { kind?: string }).kind === 'movie') movies[subject] = await get(`/douban/movie/${subject}`);
  else editions[subject] = await get(`/douban/editions/${subject}`);
}

// 期刊目录 and 学术动态, with what is over, and their posts so a click opens one.
const tocs = await get<{ issues: { post: { id: number } | null }[] }>('/tocs?offset=0&journal=');
const notices = await get<{ items: { post: { id: number } }[] }>('/notices?kind=&past=1');
const tocsAll = await get<{ issues: { post: { id: number } | null }[] }>('/tocs?offset=0&journal=&reprints=all');
for (const id of [...tocs.issues, ...notices.items].flatMap((x) => (x.post ? [x.post.id] : []))) details[id] ??= await get(`/entries/${id}`);

const state = await get<{ settings: Record<string, unknown> } & Record<string, unknown>>('/state');
const fixture = {
  at: Math.floor(Date.now() / 1000),
  state: { ...state, hasAiKey: true, hasEmbeddingKey: true, apiUser: 'demo', hasApiPassword: false, translateError: null, aiQueue: 0, fetching: 0 },
  items, meta, rec: { order: rec.items.map((i) => ({ id: i.id, rec: i.rec })), meta: rec.meta },
  details, related, books, friends, comments,
  newBooks: { post: await newBooks('post'), date: await newBooks('date') },
  reports: reportsList.reports, report: reports,
  marks: { unread: await get('/marks?filter=unread'), all: await get('/marks?filter=all') },
  profile: await get('/rec/profile'),
  stats: await get('/profile/stats?days=30'),
  embedding: await get('/embedding/status'),
  hot, editions, movies, tocs, notices,
};
if (outside.length) throw new Error(`快照时有 ${outside.length} 个请求想连外网，种子数据缺了东西：\n${[...new Set(outside)].join('\n')}`);
void tocsAll;
db.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));
console.log(`快照已写入 ${OUT}：${items.length} 篇，${(JSON.stringify(fixture).length / 1e6).toFixed(2)} MB`);
