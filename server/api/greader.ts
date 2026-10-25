import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import type { Secrets } from '../config.ts';
import { checkPassword, FailGate } from '../auth.ts';

const ITEM_PREFIX = 'tag:google.com,2005:reader/item/';
const S = {
  reading: 'user/-/state/com.google/reading-list',
  read: 'user/-/state/com.google/read',
  starred: 'user/-/state/com.google/starred',
  label: 'user/-/label/',
};
const MAX_N = 1000;

const salt = randomBytes(16).toString('hex');   // tokens are valid for the server's lifetime

export function authToken(user: string, password: string): string {
  return `${user}/${createHash('sha1').update(user + '\0' + password + '\0' + salt).digest('hex')}`;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseItemId(raw: string): number | null {
  const s = raw.trim();
  if (s.startsWith(ITEM_PREFIX)) {
    const n = Number.parseInt(s.slice(ITEM_PREFIX.length), 16);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (/^-?\d+$/.test(s)) {
    // Short form is a signed 64-bit decimal.
    const n = BigInt(s);
    const v = Number(n < 0n ? n + (1n << 64n) : n);
    return Number.isSafeInteger(v) ? v : null;
  }
  return /^[0-9a-f]{16}$/i.test(s) ? Number.parseInt(s, 16) : null;
}

export const longItemId = (id: number): string => ITEM_PREFIX + id.toString(16).padStart(16, '0');

interface StreamFilter { where: string[]; args: (string | number)[] }

function streamFilter(db: DB, stream: string, f: StreamFilter): boolean {
  if (stream === S.reading || stream === '') return true;
  if (stream === S.starred) { f.where.push('e.is_starred = 1'); return true; }
  if (stream === S.read) { f.where.push('e.is_read = 1'); return true; }
  if (stream.startsWith('feed/')) { f.where.push('e.feed_id = ?'); f.args.push(Number(stream.slice(5))); return true; }
  if (stream.startsWith(S.label) || stream.startsWith('user/') && stream.includes('/label/')) {
    const name = decodeURIComponent(stream.slice(stream.indexOf('/label/') + 7));
    const cat = db.prepare('SELECT id FROM category WHERE name = ?').get(name) as { id: number } | undefined;
    if (cat) { f.where.push('f.category_id = ?'); f.args.push(cat.id); }
    else { f.where.push('e.id IN (SELECT entry_id FROM tag WHERE name = ?)'); f.args.push(name); }
    return true;
  }
  return false;
}

async function params(c: Context): Promise<URLSearchParams> {
  const p = new URL(c.req.url).searchParams;
  if (c.req.method === 'POST') {
    const body = new URLSearchParams(await c.req.text());
    for (const [k, v] of body) p.append(k, v);
  }
  return p;
}

interface ItemRow {
  id: number; feed_id: number; title: string; title_zh: string | null; author: string | null; link: string | null;
  content: string | null; content_full: string | null; ai_summary: string | null; published: number;
  is_read: number; is_starred: number; feed_title: string; site_url: string | null; cat: string | null;
}

function toItem(r: ItemRow): Record<string, unknown> {
  const cats = [S.reading];
  if (r.is_read) cats.push(S.read);
  if (r.is_starred) cats.push(S.starred);
  if (r.cat) cats.push(S.label + r.cat);
  const html = r.content_full || r.content || '';
  return {
    id: longItemId(r.id),
    crawlTimeMsec: String(Math.floor(r.id / 1000)),
    timestampUsec: String(r.id),
    published: r.published,
    updated: r.published,
    title: r.title,
    author: r.author ?? '',
    canonical: [{ href: r.link ?? '' }],
    alternate: [{ href: r.link ?? '', type: 'text/html' }],
    categories: cats,
    origin: { streamId: `feed/${r.feed_id}`, title: r.feed_title, htmlUrl: r.site_url ?? '' },
    summary: { content: html },
    content: { content: html },
    lumen: { titleZh: r.title_zh, aiSummary: r.ai_summary },
  };
}

const ITEM_SQL = `SELECT e.id, e.feed_id, e.title, e.title_zh, e.author, e.link, e.content, e.content_full, e.ai_summary, e.published,
  e.is_read, e.is_starred, f.title AS feed_title, f.site_url, c.name AS cat
  FROM entry e JOIN feed f ON f.id = e.feed_id LEFT JOIN category c ON c.id = f.category_id`;

export function greaderApp(db: DB, getSecrets: () => Secrets, onChange: () => void,
  gate = new FailGate(), remoteOf: (c: Context) => string = () => ''): Hono {
  const app = new Hono();

  app.post('/accounts/ClientLogin', async (c) => {
    const p = await params(c);
    const s = getSecrets();
    const user = p.get('Email') ?? '', pass = p.get('Passwd') ?? '';
    const addr = remoteOf(c);
    if (gate.locked(addr)) return c.text('Error=BadAuthentication\n', 429);
    if (!s.apiPassword || !safeEq(user, s.apiUser) || !checkPassword(s.apiPassword, pass)) {
      gate.fail(addr);
      return c.text('Error=BadAuthentication\n', 401);
    }
    gate.pass(addr);
    // From the stored password (a hash), so the token changes when the password does.
    const t = authToken(user, s.apiPassword);
    return c.text(`SID=${t}\nLSID=null\nAuth=${t}\n`);
  });
  app.get('/accounts/ClientLogin', (c) => c.text('Error=BadAuthentication\n', 401));

  app.use('/reader/*', async (c, next) => {
    const s = getSecrets();
    const h = c.req.header('authorization') ?? '';
    const token = h.match(/GoogleLogin\s+auth=(\S+)/i)?.[1] ?? '';
    if (!s.apiPassword || !safeEq(token, authToken(s.apiUser, s.apiPassword))) return c.text('Unauthorized', 401);
    await next();
  });

  app.get('/reader/api/0/token', (c) => c.text(authToken(getSecrets().apiUser, getSecrets().apiPassword).split('/')[1].slice(0, 57) + 'ZZZZZZZZZZZZZZZZZ'));
  app.get('/reader/api/0/user-info', (c) => {
    const u = getSecrets().apiUser;
    return c.json({ userId: '1', userName: u, userProfileId: '1', userEmail: '' });
  });

  app.get('/reader/api/0/tag/list', (c) => {
    const cats = db.prepare('SELECT name FROM category ORDER BY sort, name').all() as { name: string }[];
    return c.json({ tags: [{ id: S.starred }, ...cats.map((x) => ({ id: S.label + x.name, type: 'folder' }))] });
  });

  app.get('/reader/api/0/subscription/list', (c) => {
    const rows = db.prepare(`SELECT f.id, f.title, f.url, f.site_url, c.name AS cat FROM feed f LEFT JOIN category c ON c.id = f.category_id WHERE f.removed = 0 ORDER BY f.title`)
      .all() as { id: number; title: string; url: string; site_url: string | null; cat: string | null }[];
    return c.json({
      subscriptions: rows.map((r) => ({
        id: `feed/${r.id}`, title: r.title, url: r.url, htmlUrl: r.site_url ?? '', iconUrl: `/icon/${r.id}`,
        categories: r.cat ? [{ id: S.label + r.cat, label: r.cat }] : [],
      })),
    });
  });

  app.get('/reader/api/0/unread-count', (c) => {
    const rows = db.prepare('SELECT feed_id, COUNT(*) AS n, MAX(id) AS newest FROM entry WHERE is_read = 0 GROUP BY feed_id').all() as { feed_id: number; n: number; newest: number }[];
    const total = rows.reduce((a, r) => a + r.n, 0);
    return c.json({
      max: total,
      unreadcounts: [{ id: S.reading, count: total, newestItemTimestampUsec: String(Math.max(0, ...rows.map((r) => r.newest))) },
        ...rows.map((r) => ({ id: `feed/${r.feed_id}`, count: r.n, newestItemTimestampUsec: String(r.newest) }))],
    });
  });

  // Shared by stream/contents and stream/items/ids.
  const query = (p: URLSearchParams, stream: string): { rows: ItemRow[]; continuation?: string } | null => {
    const f: StreamFilter = { where: ['f.removed = 0'], args: [] };
    if (!streamFilter(db, stream, f)) return null;
    for (const xt of p.getAll('xt')) if (xt === S.read) f.where.push('e.is_read = 0');
    for (const it of p.getAll('it')) if (it === S.starred) f.where.push('e.is_starred = 1'); else if (it === S.read) f.where.push('e.is_read = 1');
    const ot = Number(p.get('ot') ?? 0), nt = Number(p.get('nt') ?? 0);
    if (ot) { f.where.push('e.id >= ?'); f.args.push(ot * 1_000_000); }
    if (nt) { f.where.push('e.id < ?'); f.args.push(nt * 1_000_000); }
    const asc = p.get('r') === 'o';
    const cont = Number(p.get('c') ?? 0);
    if (cont) { f.where.push(asc ? 'e.id > ?' : 'e.id < ?'); f.args.push(cont); }
    const n = Math.min(Math.max(Number(p.get('n') ?? 20) || 20, 1), MAX_N);
    const where = f.where.length ? ' WHERE ' + f.where.join(' AND ') : '';
    const rows = db.prepare(`${ITEM_SQL}${where} ORDER BY e.id ${asc ? 'ASC' : 'DESC'} LIMIT ?`).all(...f.args, n + 1) as unknown as ItemRow[];
    const more = rows.length > n;
    const page = rows.slice(0, n);
    return { rows: page, continuation: more ? String(page.at(-1)!.id) : undefined };
  };

  app.on(['GET', 'POST'], '/reader/api/0/stream/contents/*', async (c) => {
    const p = await params(c);
    const stream = decodeURIComponent(new URL(c.req.url).pathname.split('/stream/contents/')[1] ?? '') || p.get('s') || S.reading;
    const r = query(p, stream);
    if (!r) return c.text('Unknown stream', 400);
    return c.json({ id: stream, updated: Math.floor(Date.now() / 1000), items: r.rows.map(toItem), ...(r.continuation ? { continuation: r.continuation } : {}) });
  });

  app.on(['GET', 'POST'], '/reader/api/0/stream/items/ids', async (c) => {
    const p = await params(c);
    const r = query(p, p.get('s') ?? S.reading);
    if (!r) return c.text('Unknown stream', 400);
    return c.json({ itemRefs: r.rows.map((x) => ({ id: String(x.id), timestampUsec: String(x.id) })), ...(r.continuation ? { continuation: r.continuation } : {}) });
  });

  app.on(['GET', 'POST'], '/reader/api/0/stream/items/contents', async (c) => {
    const p = await params(c);
    const ids = p.getAll('i').map(parseItemId).filter((x): x is number => x !== null).slice(0, MAX_N);
    if (!ids.length) return c.json({ items: [] });
    const rows = db.prepare(`${ITEM_SQL} WHERE e.id IN (${ids.map(() => '?').join(',')}) ORDER BY e.id DESC`).all(...ids) as unknown as ItemRow[];
    return c.json({ id: S.reading, items: rows.map(toItem) });
  });

  app.post('/reader/api/0/edit-tag', async (c) => {
    const p = await params(c);
    const ids = p.getAll('i').map(parseItemId).filter((x): x is number => x !== null);
    const add = p.getAll('a'), rem = p.getAll('r');
    const set = (col: 'is_read' | 'is_starred', v: number): void => {
      const stmt = db.prepare(`UPDATE entry SET ${col} = ?${col === 'is_read' ? ', read_at = ?' : ''} WHERE id = ?`);
      for (const id of ids) col === 'is_read' ? stmt.run(v, v ? Math.floor(Date.now() / 1000) : null, id) : stmt.run(v, id);
    };
    if (add.includes(S.read)) set('is_read', 1);
    if (rem.includes(S.read)) set('is_read', 0);
    if (add.includes(S.starred)) set('is_starred', 1);
    if (rem.includes(S.starred)) set('is_starred', 0);
    onChange();
    return c.text('OK');
  });

  app.post('/reader/api/0/mark-all-as-read', async (c) => {
    const p = await params(c);
    const f: StreamFilter = { where: ['e.is_read = 0'], args: [] };
    if (!streamFilter(db, p.get('s') ?? S.reading, f)) return c.text('Unknown stream', 400);
    const ts = Number(p.get('ts') ?? 0);   // microseconds
    if (ts) { f.where.push('e.id <= ?'); f.args.push(ts); }
    db.prepare(`UPDATE entry SET is_read = 1, read_at = ? WHERE id IN (SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id WHERE ${f.where.join(' AND ')})`)
      .run(Math.floor(Date.now() / 1000), ...f.args);
    onChange();
    return c.text('OK');
  });

  return app;
}
