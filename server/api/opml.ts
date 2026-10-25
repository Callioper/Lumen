import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import { inferView } from '../fetch/ingest.ts';
import { restoreFeed } from '../unsubscribe.ts';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function exportOpml(db: DB, resolve: (url: string) => string): string {
  const cats = db.prepare('SELECT id, name FROM category ORDER BY sort, name').all() as { id: number; name: string }[];
  const feeds = db.prepare('SELECT title, url, site_url, category_id FROM feed WHERE removed = 0 ORDER BY title').all() as
    { title: string; url: string; site_url: string | null; category_id: number | null }[];
  const line = (f: (typeof feeds)[number]): string =>
    `      <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(resolve(f.url))}"${f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ''}/>`;
  const body = cats.map((c) => {
    const inner = feeds.filter((f) => f.category_id === c.id).map(line);
    return `    <outline text="${esc(c.name)}" title="${esc(c.name)}">\n${inner.join('\n')}\n    </outline>`;
  });
  const loose = feeds.filter((f) => f.category_id == null).map(line);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Lumen</title></head>\n  <body>\n${[...body, ...loose].join('\n')}\n  </body>\n</opml>\n`;
}

// Minimal OPML reader: tracks nesting of non-feed outlines as categories.
export function importOpml(db: DB, xml: string): { added: number; skipped: number } {
  const attrs = (tag: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = unesc(m[2]);
    return out;
  };
  const getCat = db.prepare('SELECT id FROM category WHERE name = ?');
  const addCat = db.prepare('INSERT INTO category (name) VALUES (?)');
  const addFeed = db.prepare('INSERT OR IGNORE INTO feed (url, title, site_url, category_id, view) VALUES (?, ?, ?, ?, ?)');
  const removedFeed = db.prepare('SELECT id FROM feed WHERE url = ? AND removed = 1');
  const stack: (number | null)[] = [];
  let added = 0, skipped = 0;
  tx(db, () => {
    for (const m of xml.matchAll(/<outline\b[^>]*?(\/?)>|<\/outline>/gi)) {
      const tag = m[0];
      if (tag.startsWith('</')) { stack.pop(); continue; }
      const a = attrs(tag);
      const selfClosing = m[1] === '/';
      if (a.xmlurl) {
        const r = addFeed.run(a.xmlurl, a.title || a.text || a.xmlurl, a.htmlurl || null, stack.at(-1) ?? null, inferView(a.xmlurl));
        // A feed unsubscribed before comes back, as it does when added by hand; it used to stay removed.
        const gone = r.changes ? undefined : removedFeed.get(a.xmlurl) as { id: number } | undefined;
        if (gone) restoreFeed(db, gone.id, stack.at(-1) ?? null);
        if (r.changes || gone) added++; else skipped++;
        if (!selfClosing) stack.push(stack.at(-1) ?? null);
      } else if (!selfClosing) {
        const name = a.title || a.text || '未分类';
        const row = getCat.get(name) as { id: number } | undefined;
        stack.push(row ? row.id : Number(addCat.run(name).lastInsertRowid));
      }
    }
  });
  return { added, skipped };
}
