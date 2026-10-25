// One-off import of a FreshRSS user database into Lumen.
// Usage: node server/migrate-freshrss.ts --src migrate-source --user <FreshRSS 用户名> [--force]
//   env LUMEN_API_PASSWORD  GReader password to store (FreshRSS only keeps a hash)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { openDb, tx, VIEWS, type View } from './db.ts';
import { indexEntry } from './search.ts';
import { DATA_DIR, loadSecrets, saveSecrets } from './config.ts';
import { inferView, titleHash } from './fetch/ingest.ts';
import { sanitize, plainText, decodeEntities } from './content/sanitize.ts';
import { ICON_DIR } from './api/media.ts';

const SUMMARY_MARK = '✨ AI 摘要';
const CATEGORY_VIEW: Record<string, View> = { Videos: 'video', Audios: 'audio', 小宇宙: 'audio', 豆瓣: 'social' };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// FreshRSS user config is a PHP array literal; we only need a few scalar keys.
export function phpString(src: string, key: string): string | undefined {
  const m = src.match(new RegExp(`'${key}' => '((?:[^'\\\\]|\\\\.)*)'`));
  return m?.[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function idSet(json: string | undefined): Set<number> {
  if (!json) return new Set();
  try { return new Set(Object.keys(JSON.parse(json)).map(Number)); } catch { return new Set(); }
}

// Pull the TranslateDigest summary card out of the content. Returns [summaryHtml|null, rest].
export function splitSummary(content: string): [string | null, string] {
  const at = content.indexOf(SUMMARY_MARK);
  if (at < 0 || at > 600) return [null, content];
  const start = content.lastIndexOf('<div', content.lastIndexOf('<div', at) - 1);
  if (start !== 0) return [null, content];
  let depth = 0, i = 0;
  const re = /<div\b|<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { i = m.index + m[0].length; break; }
  }
  if (!i) return [null, content];
  const card = content.slice(0, i);
  const rest = content.slice(i);
  const inner = card.replace(/^<div[^>]*>\s*<div[^>]*>[^<]*<\/div>/i, '').replace(/<\/div>\s*$/i, '');
  // Without an API key the extension "summarised" by truncating the article: drop those.
  const head = plainText(inner, 80).slice(0, 40);
  const isTruncation = head.length >= 20 && plainText(rest, 4000).includes(head);
  return [isTruncation ? null : sanitize(inner), rest];
}

function sniffType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF') return 'image/webp';
  if (/<svg/i.test(buf.subarray(0, 300).toString())) return 'image/svg+xml';
  return 'image/x-icon';
}

interface FrFeed { id: number; url: string; name: string; website: string | null; description: string | null; category: number | null; ttl: number; attributes: string | null }
interface FrEntry { id: number; guid: string; title: string; author: string | null; content: string | null; link: string; date: number | null;
  is_read: number; is_favorite: number; id_feed: number; tags: string | null; attributes: string | null }

function main(): void {
  const src = arg('src') ?? 'migrate-source';
  const target = join(DATA_DIR, 'lumen.db');
  if (existsSync(target) && !process.argv.includes('--force')) throw new Error(`${target} 已存在；确认要覆盖请加 --force`);
  // FreshRSS names a user's database and config after the user.
  const user = arg('user');
  if (!user) throw new Error('缺少 --user：FreshRSS 的用户名（data/users/<用户名>/ 那一层）');
  const fr = new DatabaseSync(join(src, `${user}.sqlite`), { readOnly: true });
  const userConf = readFileSync(join(src, `${user}-config.php`), 'utf8');
  const salt = phpString(readFileSync(join(src, 'system-config.php'), 'utf8'), 'salt') ?? '';
  const summarize = idSet(phpString(userConf, 'SummarizeContents'));
  const translate = idSet(phpString(userConf, 'TranslateTitles'));
  const fulltext = idSet(phpString(userConf, 'ext_af_readability_feeds'));

  const db = openDb(target);
  if (process.argv.includes('--force')) db.exec('DELETE FROM tag; DELETE FROM entry_fts; DELETE FROM entry; DELETE FROM feed; DELETE FROM category;');
  const now = Math.floor(Date.now() / 1000);

  const cats = fr.prepare('SELECT id, name FROM category').all() as { id: number; name: string }[];
  const feeds = fr.prepare('SELECT id, url, name, website, description, category, ttl, attributes FROM feed').all() as unknown as FrFeed[];
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const uncategorized = cats.find((c) => c.name === 'Uncategorized')?.id;

  tx(db, () => {
    const ic = db.prepare('INSERT INTO category (id, name, sort) VALUES (?, ?, ?)');
    cats.filter((c) => c.id !== uncategorized).forEach((c, i) => ic.run(c.id, c.name, i));
    const ins = db.prepare(`INSERT INTO feed (id, url, title, site_url, description, category_id, view, ttl, dedupe,
      ai_summary, ai_translate_title, ai_classify, fulltext, icon_url, next_fetch_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const f of feeds) {
      const a = (() => { try { return JSON.parse(f.attributes ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
      const url = f.url.replace(/^https?:\/\/rsshub:1200\//, 'rsshub://');
      const hinted = CATEGORY_VIEW[catName.get(f.category ?? -1) ?? ''];
      const view = hinted ?? inferView(url);
      const ttl = f.ttl > 0 ? f.ttl : 0;
      // Spread the first fetch over one TTL so 100 douban feeds don't fire at once.
      const spread = Math.floor(Math.random() * (ttl || 3600));
      ins.run(f.id, url, decodeEntities(f.name), f.website, f.description, f.category === uncategorized ? null : f.category, view, ttl,
        a.unicityCriteria === 'sha1:title' ? 'title' : 'guid',
        summarize.has(f.id) ? 1 : 0, translate.has(f.id) ? 1 : 0, view === 'article' ? 1 : 0, fulltext.has(f.id) ? 1 : 0,
        typeof a.feedIconUrl === 'string' ? a.feedIconUrl : null, now + 60 + spread);
    }
  });

  const total = (fr.prepare('SELECT COUNT(*) AS n FROM entry').get() as { n: number }).n;
  const read = fr.prepare('SELECT id, guid, title, author, content, link, date, is_read, is_favorite, id_feed, tags, attributes FROM entry WHERE id > ? ORDER BY id LIMIT 1000');
  const ins = db.prepare(`INSERT OR IGNORE INTO entry (id, feed_id, guid, title, title_hash, author, link, content, thumbnail, enclosures,
    published, is_read, is_starred, read_at, ai_state, ai_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tag = db.prepare("INSERT OR IGNORE INTO tag (entry_id, name, source) VALUES (?, ?, 'feed')");
  let last = 0, done = 0, summaries = 0, dropped = 0;
  for (;;) {
    const batch = read.all(last) as unknown as FrEntry[];
    if (!batch.length) break;
    tx(db, () => {
      for (const e of batch) {
        const a = (() => { try { return JSON.parse(e.attributes ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
        const [summary, rest] = splitSummary(e.content ?? '');
        if (summary) summaries++; else if (rest !== (e.content ?? '')) dropped++;
        const content = sanitize(rest, e.link);
        const title = decodeEntities(e.title) || '(无标题)';
        const thumb = (a.thumbnail as { url?: string } | undefined)?.url?.replace(/&amp;/g, '&') ?? content.match(/<img[^>]+src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
        const encl = Array.isArray(a.enclosures) && a.enclosures.length
          ? JSON.stringify((a.enclosures as Record<string, string>[]).map((x) => ({ url: x.url, type: x.type ?? x.medium ?? '' })).filter((x) => x.url)) : null;
        const r = ins.run(e.id, e.id_feed, e.guid, title, titleHash(title), e.author?.replace(/^;|;$/g, '') ?? null, e.link.replace(/&amp;/g, '&'), content, thumb, encl,
          e.date || Math.floor(e.id / 1e6), e.is_read, e.is_favorite, e.is_read ? Math.floor(e.id / 1e6) : null, summary ? 2 : 0, summary);
        if (!r.changes) continue;
        for (const t of (e.tags ?? '').split(/\s+/).map((x) => x.replace(/^#/, '')).filter(Boolean).slice(0, 10)) tag.run(e.id, t);
        indexEntry(db, e.id);
      }
    });
    last = batch.at(-1)!.id;
    done += batch.length;
    process.stdout.write(`\r文章 ${done}/${total}`);
  }
  process.stdout.write('\n');

  // Favicons: FreshRSS names them crc32b(salt . website).
  mkdirSync(ICON_DIR, { recursive: true });
  const favDir = join(src, 'favicons');
  const have = new Set(existsSync(favDir) ? readdirSync(favDir) : []);
  let icons = 0;
  for (const f of feeds) {
    const h = (crc32(salt + (f.website ?? '')) >>> 0).toString(16).padStart(8, '0');
    if (!have.has(h + '.ico')) continue;
    const buf = readFileSync(join(favDir, h + '.ico'));
    if (!buf.length) continue;
    copyFileSync(join(favDir, h + '.ico'), join(ICON_DIR, String(f.id)));
    writeFileSync(join(ICON_DIR, `${f.id}.type`), sniffType(buf));
    icons++;
  }

  const secrets = loadSecrets();
  saveSecrets({
    aiApiKey: secrets.aiApiKey || phpString(userConf, 'DeepSeekApiKey') || phpString(userConf, 'api_key') || '',
    embeddingApiKey: secrets.embeddingApiKey,
    apiUser: user,
    apiPassword: process.env.LUMEN_API_PASSWORD ?? secrets.apiPassword,
  });

  db.exec("INSERT INTO entry_fts(entry_fts) VALUES('optimize')");
  db.exec('VACUUM');
  const views = Object.fromEntries(VIEWS.map((v) => [v, (db.prepare('SELECT COUNT(*) AS n FROM feed WHERE view = ?').get(v) as { n: number }).n]));
  console.log(JSON.stringify({ categories: cats.length - (uncategorized ? 1 : 0), feeds: feeds.length, entries: done, summariesKept: summaries,
    fakeSummariesDropped: dropped, icons, views }, null, 2));
  db.close();
}

if (process.argv[1]?.endsWith('migrate-freshrss.ts')) main();
