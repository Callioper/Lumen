import { Hono, type Context } from 'hono';
import { endAllSessions, hashPassword } from '../auth.ts';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { DB } from '../db.ts';
import { tx, VIEWS, LAYOUTS } from '../db.ts';
import { mergeSettings, type Settings, type Secrets } from '../config.ts';
import { appState, listEntries, searchEntries, getEntry, scopeWhere, parseCursor, type Scope } from './queries.ts';
import { withDestinations, destinationsOf } from '../content/destinations.ts';
import { withSubjects } from '../content/subjects.ts';
import { exportOpml, importOpml } from './opml.ts';
import { listMarks, markMarksRead, friendsMarks } from './marks.ts';
import { keptIntros, fillIntros } from '../content/hotintros.ts';
import { wantSnippets, snippetMap, snippetsSince, pageTexts, groupTexts, foreignTitle, foreignText } from '../ai/snippets.ts';
import { commentsFor, CommentsError } from '../comments/comments.ts';
import { proxyImage, feedIcon, COVER_WIDTHS } from './media.ts';
import { httpGet, decodeBody } from '../fetch/http.ts';
import { parseFeed, discoverFeedLinks } from '../fetch/parse.ts';
import { inferView } from '../fetch/ingest.ts';
import { recognizeSource } from '../fetch/recognize.ts';
import { runReports, rerenderReports } from '../report/run.ts';
import { postBooks, newBooks, bookPostIds } from '../content/booklists.ts';
import { removeFeed, restoreFeed } from '../unsubscribe.ts';
import { runExtract, pendingCount, canExtract, isExtracting, isStalled, type Extractor } from '../content/extract.ts';
import { canSortKinds, sortKinds } from '../content/bookkinds.ts';
import { tocExtractor, journalTocs } from '../content/tocs.ts';
import { RANK_FILTERS, schoolShort, type RankFilter } from '../content/ranks.ts';
import { noticeExtractor, academicNotices } from '../content/notices.ts';
import { reprintExtractor, reprintIndex } from '../content/reprints.ts';
import { markWish, detailsFor, editionsOf, markInterest, DoubanError, type SubjectPage } from '../content/douban.ts';
import { fillDates } from '../content/bookdates.ts';
import { moviePage } from '../content/doubanmovie.ts';
import { extras } from '../extras.ts';
import { hotPage, refreshLists } from '../report/hot.ts';
import { resolveFeedUrl, type Scheduler } from '../fetch/scheduler.ts';
import type { Enricher } from '../ai/enrich.ts';
import type { Translator } from '../ai/translate.ts';
import { recommendPage, reasonsFor, profileView, updateCluster } from '../rec/recommend.ts';
import { clipEntry } from '../clip/service.ts';
import { validatePage, saveWebPage } from '../clip/web.ts';
import { log } from '../log.ts';
import { listModels } from '../ai/llm.ts';
import { validateDigestIds, summarizeDigest } from '../ai/digest.ts';
import type { Jobs } from '../jobs.ts';
import { embedTexts, type Embedder } from '../rec/embed.ts';
import { relatedEntries } from '../rec/related.ts';
import { semanticSearch, queryEmbedder } from '../rec/semantic.ts';
import { sharePage, keepShare, getShare, wantsAi, enhanceShare } from './share.ts';
import { logEvent, logView, setReaction, profileStats, REACTIONS, type Reaction, type ListContext } from '../rec/signals.ts';
import { loopHealth } from '../stall.ts';
import { hasLibrary, zoteroLibrary, ownedState, type Owned } from '../content/library.ts';
import { postPictures } from '../content/pictures.ts';
import { checkUpdate, knownUpdate } from './update.ts';

export interface Deps {
  db: DB;
  scheduler: Scheduler;
  enricher: Enricher;
  embedder: Embedder;
  translator: Translator;
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
  getSecrets: () => Secrets;
  setSecrets: (s: Secrets) => void;
  // Whether a request comes from this machine (server/auth.ts); omitted, every request does.
  isLocal?: (c: Context) => boolean;
  events: EventTarget;
  jobs: Jobs;
}

// null clears the override so the layout follows the view type again.
const isLayout = (v: unknown): boolean => v === null || LAYOUTS.includes(v as never);
const isScrollRead = (v: unknown): boolean => v === null || v === 0 || v === 1 || typeof v === 'boolean';

const FEED_FIELDS = ['title', 'url', 'site_url', 'category_id', 'view', 'ttl', 'dedupe', 'ai_summary', 'ai_translate_title', 'ai_classify', 'fulltext', 'paused', 'layout', 'scroll_read', 'noisy', 'quiet'] as const;
const PAGE = 40;
const PICTURES_DEFAULT = 5;
const PICTURES_MAX = 8;

// A non-numeric id must not silently widen the scope (mark-all would mark everything read).
function idParam(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new HTTPException(400, { message: `无效的 id: ${String(v).slice(0, 20)}` });
  return n;
}

function scopeFrom(q: Record<string, string | undefined>): Scope {
  return {
    view: q.view, layout: q.layout, feed: idParam(q.feed), category: idParam(q.category),
    tag: q.tag, q: q.q, filter: (['all', 'unread', 'starred'].includes(q.filter ?? '') ? q.filter : 'all') as Scope['filter'],
    snippet: q.snippet === 'long' ? 'long' : undefined,
    since: Number.isSafeInteger(Number(q.since)) && Number(q.since) > 0 ? Number(q.since) : undefined,
    kept: q.kept === 'starred' || q.kept === 'archived' ? q.kept : undefined,
  };
}

const SCOPE_TEXT_MAX = 80;
const BOOK_PAGE = 60;
const BOOK_PAGE_MAX = 1000;
const TOC_PAGE = 20;
const RECENT_MONTHS = [0, 3, 6, 12];
// List position and origin travel with each view, to compare 最新 and 推荐 later.
function listContext(b: Record<string, unknown>): ListContext {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, SCOPE_TEXT_MAX) : undefined);
  const pos = Number(b.position);
  return { listScope: str(b.listScope), sortMode: str(b.sortMode), position: Number.isSafeInteger(pos) && pos >= 0 ? pos : undefined };
}

const MIN_FEED_TTL = 300;

function bad(msg: string): Response {
  return Response.json({ error: msg }, { status: 400 });
}

// A body that is not JSON, or is null or an array, reads as {}: the field checks below then answer 400,
// where reading b.ids off null used to answer 500.
async function body<T extends object>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  const v = await c.req.json().catch(() => null);
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Partial<T> : {};
}

export function apiApp(d: Deps): Hono {
  const app = new Hono();
  const { db } = d;
  extras.routes?.(app, db);
  const changed = (): void => { d.events.dispatchEvent(new Event('changed')); };
  const embedQuery = queryEmbedder(d.getSettings, () => d.getSecrets().embeddingApiKey);
  // 期刊目录 and 学术动态 start a pass over the posts not read yet: how many those are (0 when no pass
  // can run), and whether the last pass was stopped by an outage and waits before the next.
  const readInBackground = <T,>(ex: Extractor<T>): { reading: number; stalled: boolean } => {
    if (!canExtract(d.getSettings(), d.getSecrets())) return { reading: 0, stalled: false };
    const left = pendingCount(db, ex);
    if (left) void runExtract(db, ex, d.getSettings(), d.getSecrets());
    return { reading: left && isExtracting(ex.kind) ? left : 0, stalled: left > 0 && isStalled(ex.kind) };
  };

  // 设置 → 关于's 检查更新: the one time Lumen asks GitHub anything.
  app.get('/update', async (c) => c.json(await checkUpdate(d.getSettings())));

  app.get('/state', (c) => {
    const s = d.getSettings();
    return c.json({ ...appState(db), views: VIEWS, aiQueue: d.enricher.queueSize(), fetching: d.scheduler.busy,
      settings: s, hasAiKey: !!d.getSecrets().aiApiKey, hasEmbeddingKey: !!d.getSecrets().embeddingApiKey, translateError: d.translator.lastError, apiUser: d.getSecrets().apiUser, hasApiPassword: !!d.getSecrets().apiPassword,
      doubanSync: !!extras.doubanWish, hasZotero: hasLibrary(), update: knownUpdate() });
  });

  app.get('/entries', async (c) => {
    const q = c.req.query();
    const limit = Math.max(1, Math.min(Math.trunc(Number(q.limit)) || PAGE, 200));
    if (q.sort === 'rec') {
      const offset = Math.max(0, Math.trunc(Number(q.offset)) || 0);
      const page = recommendPage(db, d.embedder.index, d.getSettings().embedding.model, scopeFrom(q), offset, limit);
      return c.json({ ...page, items: withSubjects(db, withDestinations(db, page.items)) });
    }
    if (q.sort === 'relevance' && q.q?.trim()) {
      const offset = Math.max(0, Math.trunc(Number(q.offset)) || 0);
      return c.json({ items: withSubjects(db, withDestinations(db, searchEntries(db, scopeFrom(q), offset, limit))) });
    }
    if (q.sort === 'semantic' && q.q?.trim()) {
      const offset = Math.max(0, Math.trunc(Number(q.offset)) || 0);
      try {
        return c.json({ items: withSubjects(db, withDestinations(db, await semanticSearch(db, d.embedder.index, d.getSettings().embedding.model, embedQuery, scopeFrom(q), offset, limit))) });
      } catch (e) {
        return c.json({ error: `「意思相近」没搜成：${(e as Error).message}` }, 502);
      }
    }
    const before = parseCursor(q.before);
    return c.json({ items: withSubjects(db, withDestinations(db, listEntries(db, scopeFrom(q), before, limit))) });
  });

  // Why the 推荐 order placed an entry where it did; shown under the article.
  app.get('/entries/:id/rec', (c) => {
    const id = idParam(c.req.param('id'));
    return c.json({ rec: id === undefined ? null : reasonsFor(id) ?? null });
  });

  app.get('/rec/profile', (c) => c.json(profileView(db, d.embedder.index, d.getSettings().embedding.model)));

  // Rename (name: string, or null to let the model name it again) or hide a cluster.
  app.put('/rec/clusters/:anchor', async (c) => {
    const anchor = idParam(c.req.param('anchor'));
    const b = await c.req.json<{ name?: unknown; hidden?: unknown }>().catch(() => ({} as { name?: unknown; hidden?: unknown }));
    if (anchor === undefined) return bad('anchor 无效');
    if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 20)) return bad('名称应为 1–20 字');
    if (b.hidden !== undefined && typeof b.hidden !== 'boolean') return bad('hidden 应为 true / false');
    updateCluster(db, anchor, { name: typeof b.name === 'string' ? b.name.trim() : (b.name as null | undefined), hidden: b.hidden as boolean | undefined });
    return c.json({ ok: true });
  });

  // The books a 书单 or 书讯 post lists (or the 豆列 a 关注书单 broadcast points to, fetched on this request
  // if never seen), each marked with whether Zotero has it (null: its database could not be read).
  // 评论区: fetched when the reader opens it, kept a day; refresh=1 asks the site again.
  app.get('/entries/:id/comments', async (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('id 无效');
    try {
      const r = await commentsFor(db, id, c.req.query('refresh') === '1');
      return r ? c.json(r) : c.json({ error: '这篇文章的来源不支持评论区' }, 404);
    } catch (err) {
      if (err instanceof CommentsError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });

  // 友邻标记: who among the followed Douban people marked the subjects this entry links to.
  app.get('/entries/:id/friends', (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('id 无效');
    return c.json({ subjects: friendsMarks(db, id) });
  });

  // The post's own pictures for 首页's preview, page furniture left out the way the archive leaves it.
  app.get('/entries/:id/pictures', async (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('id 无效');
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || PICTURES_DEFAULT, 1), PICTURES_MAX);
    const e = db.prepare('SELECT COALESCE(content_full, content) AS html FROM entry WHERE id = ?').get(id) as { html: string | null } | undefined;
    if (!e) return c.json({ error: '文章不存在' }, 404);
    return c.json(await postPictures(id, e.html ?? '', d.getSettings(), limit));
  });

  app.get('/entries/:id/books', async (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('id 无效');
    const e = db.prepare('SELECT title, COALESCE(content_full, content) AS html FROM entry WHERE id = ?').get(id) as { title: string; html: string | null } | undefined;
    if (!e) return c.json({ error: '文章不存在' }, 404);
    try {
      return c.json(await postBooks(db, e, true));
    } catch (err) {
      if (err instanceof DoubanError) return c.json({ books: [], pending: false, error: err.message });
      throw err;
    }
  });

  // 新书: every listed book once, by post or by date, perhaps only recent ones or ones not in Zotero.
  app.get('/books', async (c) => {
    const offset = Math.max(0, Math.trunc(Number(c.req.query('offset'))) || 0);
    const months = Math.trunc(Number(c.req.query('recent'))) || 0;
    const topic = (c.req.query('topic') ?? '').slice(0, 20);
    const kind = (c.req.query('kind') ?? '').slice(0, 8);
    // A jump to a month further down asks for everything up to it at once.
    const limit = Math.min(BOOK_PAGE_MAX, Math.max(1, Math.trunc(Number(c.req.query('limit'))) || BOOK_PAGE));
    const { unsorted, undated, ...page } = newBooks(db, { offset, limit, byDate: c.req.query('sort') === 'date',
      recentMonths: RECENT_MONTHS.includes(months) ? months : 0, notOwned: c.req.query('notOwned') === '1', topic, kind,
      humanities: c.req.query('reprints') !== 'all', shelves: c.req.query('shelves') === '1' });
    // Books with no date yet are looked up on 豆瓣 in the background, a few seconds apart.
    const dating = fillDates(db, undated);
    // Books not sorted by 类型 and 主题 yet are, by the AI, a batch at a time; the page shows them unsorted meanwhile.
    const willSort = unsorted.length > 0 && canSortKinds(d.getSettings(), d.getSecrets());
    if (willSort) void sortKinds(db, unsorted, d.getSettings(), d.getSecrets());
    return c.json({ ...page, sorting: willSort ? unsorted.length : 0, dating });
  });

  // 期刊目录: each issue's contents, newest first, perhaps of one journal. Posts not read yet are, in
  // the background; `reading` says how many are left.
  app.get('/tocs', (c) => {
    const offset = Math.max(0, Math.trunc(Number(c.req.query('offset'))) || 0);
    const src = c.req.query('source');
    const page = journalTocs(db, { journal: (c.req.query('journal') ?? '').slice(0, 60), group: (c.req.query('group') ?? '').slice(0, 12), source: src === 'post' || src === 'cnki' || src === 'reprint' ? src : '',
      rank: (RANK_FILTERS as readonly string[]).includes(c.req.query('rank') ?? '') ? c.req.query('rank') as RankFilter : '',
      humanities: c.req.query('reprints') !== 'all', offset, limit: TOC_PAGE });
    // 人大复印's contents are read beside the journals' own: they mark what was reprinted.
    const tocs = readInBackground(tocExtractor);
    const reprints = readInBackground(reprintExtractor);
    return c.json({ ...page, school: schoolShort(), reading: tocs.reading + reprints.reading, stalled: tocs.stalled || reprints.stalled });
  });

  // 学术动态: conferences, calls and talks still to come, nearest first; with `past=1` those over too,
  // with `online=1` only those that can be followed online, with `replayable=1` only those over with a
  // recording or a write-up.
  app.get('/notices', (c) => {
    const page = academicNotices(db, { kind: (c.req.query('kind') ?? '').slice(0, 8), past: c.req.query('past') === '1',
      online: c.req.query('online') === '1', replayable: c.req.query('replayable') === '1' });
    return c.json({ ...page, ...readInBackground(noticeExtractor) });
  });

  // 豆瓣's cover, date, authors and publisher for a listed book its post leaves some of out,
  // asked for as its tile comes into view.
  app.get('/books/details', async (c) => {
    const title = (c.req.query('title') ?? '').trim();
    if (!title || title.length > 200) return bad('书名无效');
    const isbn = /^[0-9X]{10,13}$/.test(c.req.query('isbn') ?? '') ? c.req.query('isbn')! : '';
    try {
      return c.json(await detailsFor(db, { title, isbn }));
    } catch (err) {
      if (err instanceof DoubanError) return c.json({ error: err.message });
      throw err;
    }
  });

  // Mark a listed book 想读, on the reader's click (on 豆瓣 too where an extra does that).
  app.post('/books/wish', async (c) => {
    const b = await c.req.json<{ title?: unknown; isbn?: unknown; subject?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) return bad('书名无效');
    const isbn = typeof b.isbn === 'string' && /^[0-9X]{10,13}$/.test(b.isbn) ? b.isbn : '';
    const subject = typeof b.subject === 'string' && /^\d{1,12}$/.test(b.subject) ? b.subject : null;
    try {
      const r = await markWish(db, { title: b.title.trim(), isbn, subject });
      log.info(`[books] 想读：${b.title}（豆瓣 ${r.subject}${r.synced ? '，已同步' : ''}）`);
      return c.json({ ok: true, subject: r.subject, synced: r.synced });
    } catch (err) {
      if (err instanceof DoubanError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });

  app.get('/entries/:id', (c) => {
    const e = getEntry(db, Number(c.req.param('id')));
    if (!e) return c.json({ error: '文章不存在' }, 404);
    const pages = destinationsOf(db, [{ id: e.id as number, feed_id: e.feed_id as number }]).get(e.id as number);
    const [withSubject] = withSubjects(db, [{ ...e, link: (e.link as string | null) ?? null }]);
    return c.json(pages ? { ...withSubject, pages } : withSubject);
  });

  // On request from the reader: any entry, or the other body of one already translated.
  app.post('/entries/:id/translate', async (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('id 无效');
    const b = await c.req.json<{ source?: unknown }>().catch(() => ({} as { source?: unknown }));
    const source = b.source === 'full' || b.source === 'feed' ? b.source : undefined;
    if (!d.getSecrets().aiApiKey) return bad('未配置 AI 密钥');
    try {
      await d.translator.translate(id, source);
    } catch (e) {
      return c.json({ error: `翻译失败：${(e as Error).message}` }, 502);
    }
    const e = getEntry(db, id);
    return e ? c.json(e) : c.json({ error: '文章不存在' }, 404);
  });

  app.post('/entries/mark', async (c) => {
    const b = await body<{ ids: number[]; read?: boolean; starred?: boolean }>(c);
    if (!Array.isArray(b.ids) || !b.ids.every(Number.isSafeInteger)) return bad('ids 无效');
    const now = Math.floor(Date.now() / 1000);
    tx(db, () => {
      for (const id of b.ids!.slice(0, 5000)) {
        if (b.read !== undefined) db.prepare('UPDATE entry SET is_read = ?, read_at = ? WHERE id = ?').run(b.read ? 1 : 0, b.read ? now : null, id);
        if (b.starred !== undefined) {
          const r = db.prepare('UPDATE entry SET is_starred = ? WHERE id = ? AND is_starred != ?').run(b.starred ? 1 : 0, id, b.starred ? 1 : 0);
          if (r.changes) logEvent(db, id, b.starred ? 'star' : 'unstar');
        }
      }
    });
    changed();
    return c.json({ ok: true });
  });

  // Sent by the reader when an article is left: how far it got and how long it was actively on screen.
  app.post('/entries/:id/view', async (c) => {
    const id = idParam(c.req.param('id'));
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const progress = Number(b.progress), activeMs = Number(b.activeMs);
    if (id === undefined || !Number.isFinite(progress) || !Number.isFinite(activeMs)) return bad('progress / activeMs 无效');
    const type = logView(db, id, progress, activeMs, listContext(b));
    return type ? c.json({ ok: true, type }) : c.json({ error: '文章不存在' }, 404);
  });

  app.post('/entries/:id/reaction', async (c) => {
    const id = idParam(c.req.param('id'));
    const b = await c.req.json<{ reaction?: unknown }>().catch(() => ({} as { reaction?: unknown }));
    if (id === undefined) return bad('缺少 id');
    if (b.reaction !== null && !REACTIONS.includes(b.reaction as Reaction)) return bad('reaction 无效');
    if (!setReaction(db, id, b.reaction as Reaction | null)) return c.json({ error: '文章不存在' }, 404);
    return c.json({ ok: true });
  });

  app.get('/entries/:id/related', (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('缺少 id');
    const model = d.getSettings().embedding.model;
    return c.json({ ready: !!d.embedder.index.get(model, id), items: relatedEntries(db, d.embedder.index, model, id) });
  });

  app.get('/embedding/status', (c) => {
    const st = d.embedder.status();
    return c.json(c.req.query('calibrate') ? { ...st, background: d.embedder.index.background(st.model) } : st);
  });

  // Uses the saved address and key, like /ai/models.
  app.post('/embedding/test', async (c) => {
    const s = d.getSettings();
    try {
      const [v] = await embedTexts(['测试：向量服务是否可用'], s.embedding, s, d.getSecrets().embeddingApiKey);
      return c.json({ ok: true, dim: v.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get('/profile/stats', (c) => {
    const days = Math.max(1, Math.min(Math.trunc(Number(c.req.query('days'))) || 30, 365));
    return c.json(profileStats(db, days));
  });

  app.post('/entries/mark-all', async (c) => {
    const b = await body<Record<string, string> & { upTo?: number }>(c);
    const w = scopeWhere({ ...scopeFrom(b), filter: 'unread' });
    const upTo = Number(b.upTo) || Number.MAX_SAFE_INTEGER;
    const r = db.prepare(`UPDATE entry SET is_read = 1, read_at = ? WHERE id IN (SELECT e.id FROM entry e JOIN feed f ON f.id = e.feed_id ${w.sql} AND e.id <= ?)`)
      .run(Math.floor(Date.now() / 1000), ...w.args, upTo);
    changed();
    return c.json({ ok: true, count: r.changes });
  });

  // 热点: friends' hot list beside 豆瓣's public ones. Stale public lists refresh in the background.
  app.get('/hot', (c) => {
    void refreshLists(db, d.getSettings().rsshubBase);
    return c.json(withTr(withIntros(hotPage(db)), hotTexts));
  });
  app.post('/hot/refresh', async (c) => {
    await refreshLists(db, d.getSettings().rsshubBase, undefined, true);
    return c.json(withTr(withIntros(hotPage(db)), hotTexts));
  });

  // A 书影音标记 answer with the Chinese of its foreign texts there is so far (tr); the rest are queued.
  const withTr = <T extends object>(r: T, texts: (r: T) => string[]): T & { tr: Record<string, string>; trAt: number } => {
    const all = texts(r);
    wantSnippets(db, all);
    return { ...r, tr: snippetMap(db, all), trAt: Math.floor(Date.now() / 1000) };
  };

  // 书影榜 with each subject's blurb where its 豆瓣 page is kept; the rest are fetched slowly behind.
  const withIntros = (p: ReturnType<typeof hotPage>): ReturnType<typeof hotPage> => {
    const all = [p.book, p.movie].flatMap((k) => [...k.friends, ...k.lists]);
    const subjects = [...new Map(all.map((x) => [x.subject, { kind: x.kind === 'movie' ? 'movie' as const : 'book' as const, subject: x.subject }])).values()];
    const kept = keptIntros(db, subjects);
    fillIntros(db, subjects.filter((s) => !kept.has(s.subject)));
    const put = (xs: typeof all): typeof all => xs.map((x) => (kept.get(x.subject) ? { ...x, intro: kept.get(x.subject) } : x));
    return { ...p, book: { friends: put(p.book.friends), lists: put(p.book.lists) }, movie: { friends: put(p.movie.friends), lists: put(p.movie.lists) } };
  };
  const hotTexts = (p: ReturnType<typeof hotPage>): string[] =>
    [p.book, p.movie].flatMap((k) => [...k.friends, ...k.lists]).flatMap((x) => [x.title, ...(x.intro && foreignText(x.intro) ? [x.intro] : [])]).filter((t) => t === '' ? false : foreignTitle(t) || foreignText(t));

  // Whether Zotero has the book on this page, and its PDF; read anew each time (the library copy is
  // kept half an hour), not with the page, which is kept a month. null: no Zotero here, or unreadable.
  const ownedOf = (page: SubjectPage | null): Owned | null => {
    const lib = page ? zoteroLibrary() : null;
    if (!lib || !page) return null;
    const f = new Map(page.fields);
    return ownedState(lib, { title: page.title, subtitle: f.get('副标题') ?? '', isbn: f.get('ISBN') ?? '' });
  };
  // A book's other editions (这本书的其他版本), fetched from its 豆瓣 page at most once a month.
  app.get('/douban/editions/:subject', async (c) => {
    const subject = c.req.param('subject');
    if (!/^\d{1,12}$/.test(subject)) return bad('条目号无效');
    try {
      const r = await editionsOf(db, subject);
      return c.json(withTr({ ...r, owned: ownedOf(r.page) }, (x) => pageTexts(x.page)));
    } catch (err) {
      if (err instanceof DoubanError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });

  // A film's or a series' page (via 豆瓣's mobile API), at most once a month.
  app.get('/douban/movie/:subject', async (c) => {
    const subject = c.req.param('subject');
    if (!/^\d{1,12}$/.test(subject)) return bad('条目号无效');
    try { return c.json(withTr(await moviePage(db, subject), (r) => pageTexts(r.page))); } catch (err) {
      if (err instanceof DoubanError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });

  // 想读 / 想看 a subject from a 书影音标记 card, on the reader's click; synced as /books/wish.
  app.post('/douban/wish', async (c) => {
    const b = await c.req.json<{ kind?: unknown; subject?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (b.kind !== 'book' && b.kind !== 'movie') return bad('只能想读书或想看影视');
    if (typeof b.subject !== 'string' || !/^\d{1,12}$/.test(b.subject)) return bad('条目号无效');
    try { return c.json({ ok: true, ...await markInterest(db, b.kind, b.subject) }); } catch (err) {
      if (err instanceof DoubanError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });

  app.get('/marks', (c) => {
    const groups = listMarks(db, { unreadOnly: c.req.query('filter') !== 'all' });
    return c.json(withTr({ groups }, (r) => groupTexts(r.groups)));
  });
  // Translations of 书影音标记's foreign texts finished since a moment (s), after a 'snippets' event.
  app.get('/snippets', (c) => c.json({ tr: snippetsSince(db, Number(c.req.query('since')) || 0), at: Math.floor(Date.now() / 1000) }));

  app.post('/marks/read', async (c) => {
    const b = await c.req.json<{ upTo?: number }>().catch(() => ({} as { upTo?: number }));
    const count = markMarksRead(db, Number.isSafeInteger(b.upTo) ? b.upTo : undefined);
    changed();
    return c.json({ ok: true, count });
  });

  // From the browser extension: the rendered page, archived like a feed entry.
  app.post('/clip/page', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { selectedText?: unknown } | null;
    const page = validatePage(b);
    if (typeof page === 'string') return bad(page);
    try {
      const saved = saveWebPage(db, page);
      changed();
      if (!saved.existed && d.getSettings().ai.enabled && d.getSecrets().aiApiKey) {
        // The note's summary line comes from the entry's AI summary; a failure only leaves it empty.
        await d.enricher.process(saved.id, { summary: true, classify: true }).catch((e: Error) => log.warn(`[clip] web summary ${saved.id}: ${e.message}`));
      }
      const r = await clipEntry(d, saved.id, typeof b?.selectedText === 'string' ? b.selectedText : '');
      changed();
      return c.json({ ...r, entryId: saved.id });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // From the browser extension: read the page, keep the card's content for /share/<id> to render.
  app.post('/share/page', async (c) => {
    const r = sharePage(db, await c.req.json().catch(() => null));
    if (typeof r === 'string') return bad(r);
    const settings = d.getSettings(), key = d.getSecrets().aiApiKey;
    // The card is shown at once; the AI's summary or translation replaces it when it comes.
    const ai = wantsAi(r.input, settings, !!key);
    const id = keepShare(ai ? { ...r.data, pending: true } : r.data);
    if (ai) void enhanceShare(id, r.input, settings, key!);
    return c.json({ id });
  });

  app.get('/share/:id', (c) => {
    const data = getShare(c.req.param('id'));
    return data ? c.json(data) : c.json({ error: '分享内容已过期（保留一小时），回到网页重新生成' }, 404);
  });

  app.post('/entries/:id/clip', async (c) => {
    const id = idParam(c.req.param('id'));
    if (id === undefined) return bad('缺少 id');
    const b = await c.req.json<{ selectedText?: unknown }>().catch(() => ({} as { selectedText?: unknown }));
    try {
      const r = await clipEntry(d, id, typeof b?.selectedText === 'string' ? b.selectedText : '');
      if (!r.existed) logEvent(db, id, 'clip');
      changed();
      return c.json(r);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/entries/:id/ai', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await body<{ summary?: boolean; title?: boolean; classify?: boolean; fulltext?: boolean }>(c);
    const what = [b.fulltext && '抓取全文', b.summary && '生成摘要', b.title && '翻译标题', b.classify && '打标签'].filter(Boolean).join('、') || 'AI 处理';
    const entry = getEntry(db, id) as { title?: string } | undefined;
    const job = d.jobs.start('ai', id, String(entry?.title ?? `#${id}`), `${what}中`);
    try {
      await d.enricher.process(id, b);
    } catch (e) {
      d.jobs.finish(job, 'failed', `${what}失败`, (e as Error).message);
      return c.json({ error: (e as Error).message }, 502);
    }
    d.jobs.finish(job, 'done', `${what}完成`);
    return c.json(getEntry(db, id));
  });

  // A scheduler calls this with ifDue (scripts/report-due.mjs, e.g. every half hour); a run already going answers busy instead of starting a second.
  let reporting = false;
  app.post('/reports/run', async (c) => {
    const b = await c.req.json<{ ifDue?: boolean; kinds?: unknown }>().catch(() => ({} as { ifDue?: boolean; kinds?: unknown }));
    // Regenerating from the page names its kind; the scheduled run builds whatever is due.
    const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k): k is 'daily' | 'weekly' | 'papers' => k === 'daily' || k === 'weekly' || k === 'papers') : undefined;
    const s = d.getSettings();
    if (!s.ai.enabled) return bad('AI 功能未开启');
    if (reporting) return c.json({ busy: true, results: [] });
    reporting = true;
    try {
      return c.json({ busy: false, results: await runReports({ db, index: d.embedder.index, settings: s, secrets: d.getSecrets() }, { ifDue: b.ifDue !== false, kinds }) });
    } catch (e) {
      log.warn(`[report] ${(e as Error).message}`);
      return c.json({ error: (e as Error).message }, 502);
    } finally {
      reporting = false;
    }
  });

  app.post('/reports/rerender', (c) => c.json({ results: rerenderReports({ db, index: d.embedder.index, settings: d.getSettings(), secrets: d.getSecrets() }) }));

  app.get('/reports', (c) => c.json({ reports: db.prepare(`SELECT kind, period, path, created, json_extract(data, '$.from') AS "from",
      json_extract(data, '$.to') AS "to", json_extract(data, '$.total') AS total FROM report ORDER BY "from" DESC LIMIT 200`).all() }));

  // The report as built, plus each entry's state now: what was unread when it was written may be read since.
  app.get('/reports/:kind/:period', (c) => {
    const row = db.prepare('SELECT data, path FROM report WHERE kind = ? AND period = ?').get(c.req.param('kind'), c.req.param('period')) as
      { data: string; path: string | null } | undefined;
    if (!row) return c.json({ error: '没有这一期' }, 404);
    type Listed = { items: { id: number; title?: string }[] };
    const report = JSON.parse(row.data) as { picks?: { id: number; title?: string }[]; groups?: Listed[]; journals?: Listed[]; threads?: Listed[] };
    const listed = [...(report.picks ?? []), ...[report.groups, report.journals, report.threads].flatMap((l) => (l ?? []).flatMap((g) => g.items))];
    const ids = [...new Set(listed.map((x) => x.id))];
    // The papers 人大复印 has taken up since, looked up now: a report written before the reprint marks it too.
    const reprinted = reprintIndex(db);
    const reprints: Record<number, string> = {};
    for (const x of listed) { const r = x.title ? reprinted(x.title) : undefined; if (r) reprints[x.id] = r; }
    const q = db.prepare('SELECT is_read, is_starred FROM entry WHERE id = ?');
    const state: Record<number, { read: boolean; starred: boolean } | null> = {};
    for (const id of ids) {
      const r = q.get(id) as { is_read: number; is_starred: number } | undefined;
      state[id] = r ? { read: !!r.is_read, starred: !!r.is_starred } : null;   // null: no longer in the library
    }
    return c.json({ report, path: row.path, state, reprints });
  });

  app.post('/digest', async (c) => {
    const ids = validateDigestIds(await c.req.json().catch(() => null));
    if (typeof ids === 'string') return bad(ids);
    const s = d.getSettings();
    if (!s.ai.enabled) return bad('AI 功能未开启');
    try {
      return c.json(await summarizeDigest(db, ids, s, d.getSecrets().aiApiKey));
    } catch (e) {
      log.warn(`[digest] ${(e as Error).message}`);
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get('/jobs', (c) => c.json({ jobs: d.jobs.list(), aiQueue: d.enricher.queueSize(), fetching: d.scheduler.busy, loop: loopHealth() }));

  app.delete('/jobs', (c) => {
    d.jobs.clearFinished();
    return c.json({ ok: true });
  });

  // Uses the saved interface address and key, so the key never goes to an address typed but not yet saved.
  app.get('/ai/models', async (c) => {
    try {
      return c.json({ models: await listModels(d.getSettings(), d.getSecrets().aiApiKey) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post('/feeds/discover', async (c) => {
    const { url } = await body<{ url: string }>(c);
    if (typeof url !== 'string' || !/^(https?|rsshub):\/\//i.test(url)) return bad('请输入 http(s):// 或 rsshub:// 开头的地址');
    const s = d.getSettings();
    const subscribed = (u: string): boolean => !!db.prepare('SELECT 1 FROM feed WHERE url = ? AND removed = 0').get(u);
    const known = recognizeSource(url, s.wechat2rssBase);
    if (known.length) {
      // A recognized page: probe each feed it maps to, and keep a failed one with its reason (a WeChat
      // account the wechat2rss server does not follow answers 404).
      const candidates = await Promise.all(known.map(async (k) => {
        try {
          const res = await httpGet(resolveFeedUrl(k.url, s), s);
          if (res.status >= 400) return { ...k, title: k.url, items: null, view: inferView(k.url), error: `HTTP ${res.status}` };
          const f = await parseFeed(decodeBody(res.body, res.headers.get('content-type')));
          return { ...k, title: f.title || k.url, siteUrl: f.siteUrl, items: f.items.length, view: inferView(k.url, f.items) };
        } catch (e) {
          return { ...k, title: k.url, items: null, view: inferView(k.url), error: (e as Error).message };
        }
      }));
      return c.json({ candidates: candidates.map((k) => ({ ...k, subscribed: subscribed(k.url) })) });
    }
    try {
      const res = await httpGet(resolveFeedUrl(url, s), s);
      if (res.status >= 400) return bad(`HTTP ${res.status}`);
      const text = decodeBody(res.body, res.headers.get('content-type'));
      try {
        const f = await parseFeed(text);
        return c.json({ candidates: [{ url, title: f.title || url, siteUrl: f.siteUrl, items: f.items.length, view: inferView(url, f.items), subscribed: subscribed(url) }] });
      } catch {
        const links = discoverFeedLinks(text, res.url).slice(0, 5);
        if (!links.length) return bad('这个页面里没找到 RSS 链接');
        return c.json({ candidates: links.map((l) => ({ url: l, title: l, items: null, view: inferView(l), subscribed: subscribed(l) })) });
      }
    } catch (e) {
      return bad(`抓取失败：${(e as Error).message}`);
    }
  });

  app.post('/feeds', async (c) => {
    const b = await body<{ url: string; title?: string; category_id?: number | null; view?: string }>(c);
    if (typeof b.url !== 'string' || !/^(https?|rsshub):\/\//i.test(b.url)) return bad('地址无效');
    const exists = db.prepare('SELECT id, removed FROM feed WHERE url = ?').get(b.url) as { id: number; removed: number } | undefined;
    if (exists && !exists.removed) return bad('已经订阅过这个源');
    if (exists) {
      restoreFeed(db, exists.id, b.category_id ?? null);
      const out = await d.scheduler.refreshNow(exists.id);
      changed();
      return c.json({ id: exists.id, fetch: out });
    }
    const view = VIEWS.includes(b.view as never) ? b.view! : inferView(b.url);
    const r = db.prepare('INSERT INTO feed (url, title, category_id, view, ai_summary) VALUES (?, ?, ?, ?, ?)')
      .run(b.url, b.title || b.url, b.category_id ?? null, view, view === 'article' ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    const out = await d.scheduler.refreshNow(id);
    changed();
    return c.json({ id, fetch: out });
  });

  app.patch('/feeds/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await body<Record<string, unknown>>(c);
    const sets: string[] = [], args: (string | number | null)[] = [];
    for (const k of FEED_FIELDS) {
      if (!(k in b)) continue;
      const v = b[k];
      if (k === 'view' && !VIEWS.includes(v as never)) return bad('view 无效');
      if (k === 'dedupe' && v !== 'guid' && v !== 'title') return bad('dedupe 无效');
      if (k === 'layout' && !isLayout(v)) return bad('layout 无效');
      if (k === 'scroll_read' && !isScrollRead(v)) return bad('scroll_read 无效');
      // 0 is the default; anything else under five minutes kept a feed always due (and NaN, never fetched).
      if (k === 'ttl' && !(v === 0 || (Number.isSafeInteger(v) && (v as number) >= MIN_FEED_TTL))) return bad('ttl 无效');
      if (v !== null && typeof v === 'object') return bad(`${k} 无效`);
      sets.push(`${k} = ?`);
      args.push(typeof v === 'boolean' ? Number(v) : (v as string | number | null));
    }
    if (!sets.length) return bad('没有可改的字段');
    db.prepare(`UPDATE feed SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    changed();
    return c.json({ ok: true });
  });

  app.delete('/feeds/:id', (c) => {
    const id = Number(c.req.param('id'));
    const { kept } = removeFeed(db, id, bookPostIds(db));
    changed();
    return c.json({ ok: true, kept });
  });

  app.post('/feeds/:id/refresh', async (c) => {
    const out = await d.scheduler.refreshNow(Number(c.req.param('id')));
    changed();
    return c.json(out);
  });

  app.post('/refresh', async (c) => {
    await d.scheduler.refreshNow();
    return c.json({ ok: true });
  });

  app.post('/categories', async (c) => {
    const { name } = await body<{ name: string }>(c);
    if (typeof name !== 'string' || !name.trim()) return bad('分类名不能为空');
    try {
      const r = db.prepare('INSERT INTO category (name) VALUES (?)').run(name.trim());
      changed();
      return c.json({ id: Number(r.lastInsertRowid) });
    } catch {
      return bad('分类已存在');
    }
  });

  app.patch('/categories/:id', async (c) => {
    const b = await body<{ name?: string; sort?: number; layout?: unknown; scroll_read?: unknown }>(c);
    if (b.name !== undefined && typeof b.name !== 'string') return bad('name 无效');
    if (b.sort !== undefined && !Number.isSafeInteger(b.sort)) return bad('sort 无效');
    if (b.layout !== undefined && !isLayout(b.layout)) return bad('layout 无效');
    if (b.scroll_read !== undefined && !isScrollRead(b.scroll_read)) return bad('scroll_read 无效');
    if (b.name !== undefined) db.prepare('UPDATE category SET name = ? WHERE id = ?').run(b.name.trim(), Number(c.req.param('id')));
    if (b.sort !== undefined) db.prepare('UPDATE category SET sort = ? WHERE id = ?').run(b.sort, Number(c.req.param('id')));
    if (b.layout !== undefined) db.prepare('UPDATE category SET layout = ? WHERE id = ?').run(b.layout as string | null, Number(c.req.param('id')));
    if (b.scroll_read !== undefined) {
      const v = b.scroll_read === null ? null : Number(b.scroll_read);
      db.prepare('UPDATE category SET scroll_read = ? WHERE id = ?').run(v, Number(c.req.param('id')));
    }
    changed();
    return c.json({ ok: true });
  });

  app.delete('/categories/:id', (c) => {
    db.prepare('DELETE FROM category WHERE id = ?').run(Number(c.req.param('id')));
    changed();
    return c.json({ ok: true });
  });

  app.get('/opml', (c) => {
    const s = d.getSettings();
    c.header('content-disposition', 'attachment; filename="lumen.opml"');
    return c.body(exportOpml(db, (u) => resolveFeedUrl(u, s)), 200, { 'content-type': 'text/x-opml; charset=utf-8' });
  });

  app.post('/opml', async (c) => {
    const r = importOpml(db, await c.req.text());
    changed();
    void d.scheduler.tick();
    return c.json(r);
  });

  app.put('/settings', async (c) => {
    const b = await body<{ settings?: Partial<Settings>; aiApiKey?: string; embeddingApiKey?: string; apiPassword?: string; apiUser?: string }>(c);
    // Every check before anything is saved: a 400 used to come back after the settings were already written.
    for (const k of ['aiApiKey', 'embeddingApiKey', 'apiPassword', 'apiUser'] as const) {
      if (b[k] !== undefined && typeof b[k] !== 'string') return bad(`${k} 应为字符串`);
    }
    const next = b.settings ? mergeSettings(d.getSettings(), b.settings) : d.getSettings();
    if (typeof next === 'string') return bad(next);
    // Paths on this machine name programs to run and folders to write: only this machine sets them.
    const cur = d.getSettings();
    const pathsMoved = next.zoteroDb !== cur.zoteroDb || next.ocrPython !== cur.ocrPython || next.ocrEngine !== cur.ocrEngine || next.clip.vaultPath !== cur.clip.vaultPath;
    if (pathsMoved && d.isLocal && !d.isLocal(c)) return bad('本机路径（Zotero、OCR、Obsidian 库）只能在这台电脑上改');
    // The web login signs in with the API password: on without one, nobody could get in from elsewhere.
    const password = b.apiPassword ?? d.getSecrets().apiPassword;
    if (next.webLogin && !password) return bad('先设一个密码，再打开「别的设备要登录」');
    if (b.settings) d.setSettings(next);
    if (b.aiApiKey !== undefined || b.embeddingApiKey !== undefined || b.apiPassword !== undefined || b.apiUser !== undefined) {
      const cur = d.getSecrets();
      d.setSecrets({ aiApiKey: b.aiApiKey ?? cur.aiApiKey, embeddingApiKey: b.embeddingApiKey ?? cur.embeddingApiKey,
        apiPassword: b.apiPassword === undefined ? cur.apiPassword : hashPassword(b.apiPassword), apiUser: b.apiUser || cur.apiUser });
      // A new password or user name signs every browser out; the phone clients' tokens change with it too.
      if (b.apiPassword !== undefined || (b.apiUser && b.apiUser !== cur.apiUser)) endAllSessions(db);
    }
    if (b.settings?.embedding !== undefined || b.embeddingApiKey !== undefined) d.embedder.resume();
    changed();
    return c.json({ ok: true });
  });

  app.get('/events', (c) => streamSSE(c, async (stream) => {
    let pending = false;
    const onChange = (): void => {
      if (pending) return;
      pending = true;   // coalesce bursts (a refresh-all fires hundreds of changes)
      setTimeout(() => { pending = false; void stream.writeSSE({ event: 'changed', data: '1' }); }, 1500);
    };
    const onClip = (ev: Event): void => { void stream.writeSSE({ event: 'clip', data: JSON.stringify((ev as CustomEvent).detail) }); };
    let snipPending = false;
    const onSnippets = (): void => {
      if (snipPending) return;
      snipPending = true;
      setTimeout(() => { snipPending = false; void stream.writeSSE({ event: 'snippets', data: '1' }); }, 1000);
    };
    let jobsPending = false;
    const onJobs = (): void => {
      if (jobsPending) return;
      jobsPending = true;
      setTimeout(() => { jobsPending = false; void stream.writeSSE({ event: 'jobs', data: '1' }); }, 300);
    };
    d.events.addEventListener('changed', onChange);
    d.events.addEventListener('clip', onClip);
    d.events.addEventListener('jobs', onJobs);
    d.events.addEventListener('snippets', onSnippets);
    stream.onAbort(() => {
      d.events.removeEventListener('changed', onChange);
      d.events.removeEventListener('clip', onClip);
      d.events.removeEventListener('jobs', onJobs);
      d.events.removeEventListener('snippets', onSnippets);
    });
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'ping', data: '' });
      await stream.sleep(25_000);
    }
  }));

  return app;
}

export function mediaApp(d: Deps): Hono {
  const app = new Hono();
  app.get('/img', async (c) => {
    const u = c.req.query('u');
    if (!u) return c.text('missing u', 400);
    const w = Number(c.req.query('w'));
    const width = (COVER_WIDTHS as readonly number[]).includes(w) ? w : undefined;
    try { return await proxyImage(u, d.getSettings(), width); } catch { return c.body(null, 502); }
  });
  app.get('/icon/:id', (c) => feedIcon(d.db, Number(c.req.param('id')), d.getSettings()));
  return app;
}
