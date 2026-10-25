import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, seedEntryId } from './db.ts';
import { rebuildSearchIndexIfStale } from './search.ts';
import { ROOT, DATA_DIR, loadSettings, saveSettings, loadSecrets, saveSecrets, type Secrets, type Settings } from './config.ts';
import { useZoteroDb } from './content/library.ts';
import { useOcr } from './content/ocr.ts';
import { warmNoticePictures } from './content/pictures.ts';
import { Scheduler } from './fetch/scheduler.ts';
import { Enricher } from './ai/enrich.ts';
import { Embedder } from './rec/embed.ts';
import { Translator } from './ai/translate.ts';
import { SnippetTranslator } from './ai/snippets.ts';
import { nameClusters } from './rec/recommend.ts';
import { apiApp, mediaApp, type Deps } from './api/routes.ts';
import { greaderApp } from './api/greader.ts';
import { loginApp } from './api/login.ts';
import { FailGate, hashPassword, isHashed, isLocalRequest, webLoginGuard } from './auth.ts';
import { pruneImageCache, warmUnreadImages } from './api/media.ts';
import { runExtract } from './content/extract.ts';
import { tocExtractor } from './content/tocs.ts';
import { noticeExtractor } from './content/notices.ts';
import { findReplays } from './content/replays.ts';
import { bookPostIds } from './content/booklists.ts';
import { log } from './log.ts';
import { loadExtras } from './extras.ts';
import { Jobs } from './jobs.ts';
import { pruneOld, compactIfWasteful } from './retention.ts';
import { trimWal, backupIfDue } from './backup.ts';
import { tagByNeighbours, backfillKnnTags, awaitsVector } from './rec/tagknn.ts';
import { setPeopleSource } from './rec/keywords.ts';
import { Libraries } from './clip/library.ts';
import { watchLoop, timeRequests } from './stall.ts';

const RETENTION_EVERY_MS = 6 * 3600_000;
const WEB_DIST = join(ROOT, 'web', 'dist');

function securityHeaders(allowedHosts: Set<string>, port: number) {
  // Article images are served from the other loopback name too (web/src/util.ts imageOrigin).
  const imgSrc = `'self' data: blob: http://127.0.0.1:${port} http://localhost:${port}`;
  return async (c: import('hono').Context, next: () => Promise<void>): Promise<Response | void> => {
    // DNS-rebinding guard: only answer to the names we are bound to.
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return c.text('Host not allowed', 421);
    const path = new URL(c.req.url).pathname;
    // CSRF guard for the UI API: a cross-site form can't set custom headers without a preflight we never grant.
    if (path.startsWith('/api/') && !(path === '/api/greader.php' || path.startsWith('/api/greader.php/')) && c.req.method !== 'GET' && c.req.header('x-lumen') !== '1') {
      return c.json({ error: 'missing x-lumen header' }, 403);
    }
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) {
      c.header('content-security-policy', `default-src 'self'; img-src ${imgSrc}; media-src * blob:; style-src 'self' 'unsafe-inline'; ` +
        'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.bilibili.com https://player.vimeo.com https://open.spotify.com; ' +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    }
  };
}

function main(): void {
  // Fire-and-forget jobs (scheduler ticks, AI queue) must not take the server down on a stray DB error.
  process.on('unhandledRejection', (e) => log.error(`[unhandled] ${(e as Error)?.stack ?? String(e)}`));
  process.on('uncaughtException', (e) => { log.error(`[uncaught] ${e.stack ?? String(e)}`); process.exit(1); });
  let settings = loadSettings();
  let secrets = loadSecrets();
  // A password kept in plain text by an older version is hashed in place (not one given by LUMEN_API_PASSWORD).
  if (secrets.apiPassword && !isHashed(secrets.apiPassword) && !process.env.LUMEN_API_PASSWORD) {
    secrets = { ...secrets, apiPassword: hashPassword(secrets.apiPassword) };
    saveSecrets(secrets);
  }
  const dbPath = join(DATA_DIR, 'lumen.db');
  const db = openDb(dbPath);
  seedEntryId(db);
  rebuildSearchIndexIfStale(db);
  db.prepare('UPDATE entry SET ai_state = 1 WHERE ai_state = 5').run();   // jobs interrupted by a restart

  const events = new EventTarget();
  const changed = (): void => { events.dispatchEvent(new Event('changed')); };
  const scheduler = new Scheduler(db, () => settings, changed);
  const enricher = new Enricher(db, () => settings, () => secrets, changed);
  const embedder = new Embedder(db, () => settings, () => secrets);
  setPeopleSource(() => (settings.clip.vaultPath
    ? new Libraries(settings.clip.vaultPath, settings.clip.tagLibrary, settings.clip.nameLibrary, settings.clip.authorsFolder).people() : []));
  // Where Zotero and the OCR engine are, from the settings; again whenever they are saved.
  const useLocalPaths = (s: Settings): void => { useZoteroDb(s.zoteroDb); useOcr(s.ocrPython, s.ocrEngine); };
  useLocalPaths(settings);
  enricher.tagByNeighbours = (id) => tagByNeighbours(db, embedder.index, settings.embedding.model, id);
  enricher.awaitsVector = (id) => awaitsVector(embedder.index, settings, !!secrets.embeddingApiKey, id);
  const translator = new Translator(db, () => settings, () => secrets, changed);
  const snippets = new SnippetTranslator(db, () => settings, () => secrets, () => { events.dispatchEvent(new Event('snippets')); });
  const remoteOf = (c: Context): string => getConnInfo(c).remote.address ?? '';
  const deps: Deps = {
    db, scheduler, enricher, embedder, translator, events, jobs: new Jobs(events),
    isLocal: (c) => isLocalRequest(c, remoteOf(c)),
    getSettings: () => settings, setSettings: (s) => { settings = s; saveSettings(s); useLocalPaths(s); },
    getSecrets: () => secrets, setSecrets: (s: Secrets) => { secrets = s; saveSecrets(s); },
  };

  const app = new Hono();
  const port = settings.port;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(process.env.LUMEN_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  // The Host list stops DNS rebinding; it is not a lock: anyone on the network can send an allowed Host.
  if (settings.host !== '127.0.0.1' && !settings.webLogin) {
    log.warn(`监听 ${settings.host} 而网页版没开登录：同一网络里的任何设备都能打开和改设置。在 设置 → 数据与接口 里打开「别的设备要登录」`);
  }
  const gate = new FailGate();
  app.use('*', securityHeaders(hosts, port));
  app.use('*', webLoginGuard({ db, enabled: () => settings.webLogin, remoteOf }));
  app.use('/api/*', timeRequests);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    log.error(`${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: err.message }, 500);
  });
  app.route('/', loginApp({ db, enabled: () => settings.webLogin, getSecrets: () => secrets, gate, remoteOf }));
  app.route('/api/greader.php', greaderApp(db, () => secrets, changed, gate, remoteOf));
  app.route('/api', apiApp(deps));
  app.route('/', mediaApp(deps));

  if (existsSync(WEB_DIST)) {
    const root = relative(process.cwd(), WEB_DIST) || '.';
    app.use('/assets/*', serveStatic({ root, onFound: (_p, c) => { c.header('cache-control', 'public, max-age=31536000, immutable'); } }));
    // The page itself is never cached: it names the current bundle, and an old one breaks against a newer API.
    const noCache = (c: { header: (k: string, v: string) => void }): void => { c.header('cache-control', 'no-cache'); };
    app.use('/*', serveStatic({ root, onFound: (p, c) => { if (p.endsWith('.html')) noCache(c); } }));
    const index = readFileSync(join(WEB_DIST, 'index.html'), 'utf8');
    app.get('*', (c) => { noCache(c); return c.html(index); });
  } else {
    app.get('/', (c) => c.text('前端尚未构建：在项目目录运行 npm run build'));
  }

  const unwatch = watchLoop();
  scheduler.start();
  enricher.start();
  embedder.start();
  translator.start();
  snippets.start();
  // Recommendation clusters get short names from their titles, a few per pass.
  const NAME_CLUSTERS_MS = 15 * 60_000;
  const runNaming = (): void => { nameClusters(db, embedder.index, settings, secrets).catch((e) => log.warn(`[rec] naming: ${(e as Error).message}`)); };
  const nameTimer = setInterval(runNaming, NAME_CLUSTERS_MS);
  const firstNaming = setTimeout(runNaming, 60_000);
  const prune = (): void => {
    try {
      const n = pruneOld(db, settings, bookPostIds(db));
      if (n) { log.info(`[retention] 清理 ${n} 篇过期文章`); embedder.index.reset(); }
      const freed = compactIfWasteful(db);
      if (freed) log.info(`[retention] 压缩数据库，释放 ${Math.round(freed / 1e6)} MB`);
      const images = pruneImageCache();
      if (images) log.info(`[retention] 清理 ${images} 张缓存封面`);
      trimWal(db);
      backfillKnnTags(db, embedder.index, settings.embedding.model);
    } catch (e) { log.error(`[retention] ${(e as Error).message}`); }
    void backupIfDue(dbPath);
  };
  setTimeout(prune, 60_000);
  setInterval(prune, RETENTION_EVERY_MS);
  // Unread articles' images, into the cache before they are opened (server/api/media.ts); also
  // catches full texts fetched after their entry and whatever a restart cut short.
  const WARM_IMAGES_MS = 10 * 60_000;
  const warmImages = (): void => { warmUnreadImages(db, settings).catch((e) => log.warn(`[img] 预取文章图片：${(e as Error).message}`)); };
  const warmTimer = setInterval(warmImages, WARM_IMAGES_MS);
  const firstWarm = setTimeout(warmImages, 90_000);
  // 期刊目录 and 学术动态 (server/content/extract.ts): the posts that came in since, read by the AI.
  const EXTRACT_MS = 10 * 60_000;
  // Then the pictures of the notices still listed, read for 首页's preview (content/pictures.ts).
  const extractPosts = (): void => {
    void runExtract(db, tocExtractor, settings, secrets).then(() => runExtract(db, noticeExtractor, settings, secrets))
      .then(() => warmNoticePictures(db, settings)).catch((e) => log.warn(`[ocr] 首页配图预读：${(e as Error).message}`));
  };
  const extractTimer = setInterval(extractPosts, EXTRACT_MS);
  const firstExtract = setTimeout(extractPosts, 120_000);
  // 学术动态's talks and conferences once over: whether a recording went up on B站 (content/replays.ts).
  const REPLAYS_MS = 30 * 60_000;
  const lookForReplays = (): void => { void findReplays(db, settings); };
  const replayTimer = setInterval(lookForReplays, REPLAYS_MS);
  const firstReplays = setTimeout(lookForReplays, 180_000);

  serve({ fetch: app.fetch, hostname: settings.host, port }, () => {
    log.info(`Lumen 已启动 http://127.0.0.1:${port}/`);
    // Started by the desktop app (desktop/main.js): tell it where to point the window.
    process.send?.({ ready: port });
  });
  // A restart once went unexplained (nothing in stderr, no crash event), so every way out is logged.
  const shutdown = (signal: string): void => {
    log.warn(`收到 ${signal}，正在退出`);
    unwatch(); scheduler.stop(); enricher.stop(); embedder.stop(); translator.stop(); snippets.stop(); clearInterval(nameTimer); clearTimeout(firstNaming); clearInterval(warmTimer); clearTimeout(firstWarm); clearInterval(extractTimer); clearTimeout(firstExtract); clearInterval(replayTimer); clearTimeout(firstReplays); db.close(); process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // Windows has no SIGTERM to send a child; the desktop app asks over IPC so the database closes cleanly.
  process.on('message', (m) => { if (m === 'shutdown') shutdown('桌面版退出'); });
  process.on('exit', (code) => log.warn(`进程退出，code ${code}`));
}

// Optional local extensions (server/extras.ts) register before the routes are built.
await loadExtras();
main();
