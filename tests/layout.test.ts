import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { resolveLayout, inheritedLayout, layoutTarget, groupByDay, effectiveLayout, type LayoutContext } from '../web/src/layout.ts';
import { EFFECTIVE_LAYOUT_SQL } from '../server/api/queries.ts';
import type { Layout, View } from '../web/src/api.ts';

const feed = (id: number, view: View, category_id: number | null, layout: Layout | null = null) => [id, { id, view, category_id, layout }] as const;
const ctx = (over: Partial<LayoutContext> = {}): LayoutContext => ({
  feeds: new Map([feed(1, 'article', 10), feed(2, 'video', 20), feed(3, 'video', 20), feed(4, 'article', 10, 'compact'), feed(5, 'social', 30)]),
  categories: [{ id: 10, layout: null }, { id: 20, layout: null }, { id: 30, layout: null }],
  local: {},
  ...over,
});

test('without any choice a feed is shown the way its type suggests', () => {
  assert.equal(resolveLayout({ kind: 'feed', id: 1 }, 'all', ctx()), 'list');
  assert.equal(resolveLayout({ kind: 'feed', id: 2 }, 'all', ctx()), 'masonry');
  assert.equal(resolveLayout({ kind: 'feed', id: 5 }, 'all', ctx()), 'social');
  assert.equal(resolveLayout({ kind: 'category', id: 20 }, 'all', ctx()), 'masonry');
  assert.equal(resolveLayout({ kind: 'category', id: 10 }, 'all', ctx()), 'list');
  assert.equal(resolveLayout({ kind: 'all' }, 'all', ctx()), 'list');
  assert.equal(resolveLayout({ kind: 'marks' }, 'social', ctx()), 'list');
});

test('a feed choice beats its category, a category choice beats the type', () => {
  const c = ctx({ categories: [{ id: 10, layout: 'cards' }, { id: 20, layout: 'list' }, { id: 30, layout: null }] });
  assert.equal(resolveLayout({ kind: 'feed', id: 1 }, 'all', c), 'cards');
  assert.equal(resolveLayout({ kind: 'feed', id: 4 }, 'all', c), 'compact');
  assert.equal(resolveLayout({ kind: 'feed', id: 2 }, 'all', c), 'list');
  assert.equal(resolveLayout({ kind: 'category', id: 20 }, 'all', c), 'list');
});

test('a mode tab shows everything in it in that mode, and only lets single feeds or categories change', () => {
  assert.equal(resolveLayout({ kind: 'all' }, 'compact', ctx()), 'compact');
  assert.equal(resolveLayout({ kind: 'category', id: 10 }, 'compact', ctx()), 'compact');
  assert.equal(resolveLayout({ kind: 'starred' }, 'masonry', ctx()), 'masonry');
  assert.deepEqual(layoutTarget({ kind: 'all' }, 'compact'), { kind: 'tab' });
  assert.deepEqual(layoutTarget({ kind: 'category', id: 10 }, 'compact'), { kind: 'category', id: 10 });
  assert.deepEqual(layoutTarget({ kind: 'feed', id: 4 }, 'list'), { kind: 'feed', id: 4 });
});

test('under 全部, lists that are not a feed or category keep their choice in this browser', () => {
  const c = ctx({ local: { all: 'compact', 'tag:哲学': 'cards' } });
  assert.equal(resolveLayout({ kind: 'all' }, 'all', c), 'compact');
  assert.equal(resolveLayout({ kind: 'tag', name: '哲学' }, 'all', c), 'cards');
  assert.deepEqual(layoutTarget({ kind: 'starred' }, 'all'), { kind: 'local', key: 'starred' });
});

test('every feed belongs to exactly the tab of its effective layout', () => {
  const c = ctx({ categories: [{ id: 10, layout: 'digest' }, { id: 20, layout: null }, { id: 30, layout: null }] });
  assert.deepEqual([...c.feeds.values()].map((f) => [f.id, effectiveLayout(f, c.categories)]),
    [[1, 'digest'], [2, 'masonry'], [3, 'masonry'], [4, 'compact'], [5, 'social']]);
});

test('「恢复默认」 shows what a feed or category falls back to once its own choice is cleared', () => {
  const c = ctx({ categories: [{ id: 10, layout: 'cards' }, { id: 20, layout: 'masonry' }, { id: 30, layout: null }] });
  assert.equal(inheritedLayout({ kind: 'feed', id: 4 }, 'all', c), 'cards');
  assert.equal(inheritedLayout({ kind: 'category', id: 20 }, 'all', c), 'masonry');
  assert.equal(inheritedLayout({ kind: 'category', id: 10 }, 'all', c), 'list');
  assert.equal(inheritedLayout({ kind: 'all' }, 'all', c), 'list');
});

test('the server puts each feed in the same tab as the web app does', () => {
  const db = openDb(':memory:');
  const views: View[] = ['article', 'social', 'picture', 'video', 'audio'];
  const layouts: (Layout | null)[] = [null, 'list', 'social', 'cards', 'masonry', 'compact', 'digest'];
  db.prepare("INSERT INTO category (id, name, layout) VALUES (1, 'none', NULL), (2, 'set', 'compact')").run();
  const categories = [{ id: 1, layout: null }, { id: 2, layout: 'compact' as Layout }];
  const add = db.prepare('INSERT INTO feed (id, url, title, view, category_id, layout) VALUES (?, ?, ?, ?, ?, ?)');
  const feeds: { id: number; view: View; category_id: number | null; layout: Layout | null }[] = [];
  let id = 0;
  for (const view of views) for (const layout of layouts) for (const category_id of [null, 1, 2]) {
    id++;
    add.run(id, `u${id}`, `f${id}`, view, category_id, layout);
    feeds.push({ id, view, category_id, layout });
  }
  const sql = db.prepare(`SELECT f.id, ${EFFECTIVE_LAYOUT_SQL} AS l FROM feed f ORDER BY f.id`).all() as { id: number; l: string }[];
  assert.deepEqual(sql.map((r) => r.l), feeds.map((f) => effectiveLayout(f, categories)));
});

test('标题流 groups consecutive entries by local day and labels today and yesterday', () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime();
  const at = (d: number, h: number) => ({ published: new Date(2026, 9, d, h).getTime() / 1000 });
  const old = { published: new Date(2025, 2, 4, 9).getTime() / 1000 };
  const groups = groupByDay([at(21, 14), at(21, 1), at(20, 23), at(19, 8), at(19, 7), old], now);
  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [['今天', 2], ['昨天', 1], ['10月19日 周一', 2], ['2025年3月4日 周二', 1]]);
});

test('existing databases gain the layout columns when opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-layout-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE category (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0); INSERT INTO category (name) VALUES ('新书');");
    old.close();
    const db = openDb(path);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('category').includes('layout'));
    assert.ok(cols('feed').includes('layout'));
    assert.equal((db.prepare("SELECT layout FROM category WHERE name = '新书'").get() as { layout: string | null }).layout, null);
    db.close();
    openDb(path).close();   // a second open must not try to add the columns again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('动态 opened from the sidebar is a timeline unless changed there, and keeps its own choice', () => {
  assert.equal(resolveLayout({ kind: 'social' }, 'all', ctx()), 'social');
  assert.deepEqual(layoutTarget({ kind: 'social' }, 'all'), { kind: 'local', key: 'social' });
  assert.equal(resolveLayout({ kind: 'social' }, 'all', ctx({ local: { social: 'cards' } })), 'cards');
  assert.equal(inheritedLayout({ kind: 'social' }, 'all', ctx()), 'social');
});
