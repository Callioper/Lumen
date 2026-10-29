// Native RSSHub bridge for Lumen: runs the rsshub npm package in-process and serves
// each route as JSON Feed on 127.0.0.1:1200 (same port the Docker container used).
// Cookies and other route secrets live in rsshub.env next to this file.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_ROUTE, doubanBookChart } from './douban-chart.mjs';

const HERE = import.meta.dirname;
const PORT = Number(process.env.RSSHUB_PORT ?? 1200);
const ROUTE_TIMEOUT_MS = 60_000;

function loadEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^"(.*)"$/s, '$1');
  }
  return out;
}

// The douban timeline route sends no cookie (rexxar answers 403) and links to an
// app-only dispatch URL. Same fix the Docker setup applied at container start; idempotent.
function patchDouban() {
  const dir = join(HERE, 'node_modules', 'rsshub', 'dist-lib');
  const file = readdirSync(dir).find((f) => f.startsWith('status-') && readFileSync(join(dir, f), 'utf8').includes('rexxar/api/v2/status/user_timeline'));
  if (!file) { console.warn('[douban-patch] status route not found; skipped'); return; }
  const path = join(dir, file);
  let s = readFileSync(path, 'utf8');
  if (s.includes('/*lumen-patched*/')) return;
  const headers = '{headers:{Referer:"https://m.douban.com/",Cookie:process.env.DOUBAN_COOKIE||""}}';
  const before = s;
  s = s.replaceAll('await got_default(url)', `await got_default(url,${headers})`);
  s = s.replace('link: item.status.sharing_url.replace(/\\?_i=(.*)/, ""),',
    'link: `https://www.douban.com/people/${item.status.author.id}/status/${item.status.id}/`,');
  if (s === before) { console.warn('[douban-patch] patterns not found; RSSHub version changed?'); return; }
  writeFileSync(path, '/*lumen-patched*/' + s);
  console.log(`[douban-patch] applied to ${file}`);
}

// bilibili's browser cookie grab waits for a /x/web-interface/nav request with no timeout;
// when it never fires the route hangs and the headless Chrome is never closed. Bound the wait.
function patchBilibiliCookieWait() {
  const dir = join(HERE, 'node_modules', 'rsshub', 'dist-lib');
  const needle = 'const cookieString = await waitForRequest;';
  const file = readdirSync(dir).find((f) => f.startsWith('cache-') && readFileSync(join(dir, f), 'utf8').includes(needle));
  if (!file) {
    const done = readdirSync(dir).some((f) => f.startsWith('cache-') && readFileSync(join(dir, f), 'utf8').includes('/*lumen-patched*/'));
    if (!done) console.warn('[bili-patch] cookie wait not found; RSSHub version changed?');
    return;
  }
  const path = join(dir, file);
  const s = readFileSync(path, 'utf8').replace(needle,
    'const cookieString = await Promise.race([waitForRequest, new Promise((r) => setTimeout(() => r(""), 20000))]);');
  writeFileSync(path, '/*lumen-patched*/' + s);
  console.log(`[bili-patch] applied to ${file}`);
}

// Small route fixes, one marker each so they apply independently and only once.
// Returns quietly when already applied; warns when the upstream code has moved.
function patchRoute(tag, prefix, needle, edits) {
  const dir = join(HERE, 'node_modules', 'rsshub', 'dist-lib');
  const marker = `/*lumen-${tag}*/`;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix));
  const file = files.find((f) => { const t = readFileSync(join(dir, f), 'utf8'); return t.includes(marker) || t.includes(needle); });
  if (!file) { console.warn(`[${tag}] route not found; RSSHub version changed?`); return; }
  const path = join(dir, file);
  let s = readFileSync(path, 'utf8');
  if (s.includes(marker)) return;
  for (const [from, to] of edits) {
    if (!s.includes(from)) { console.warn(`[${tag}] pattern not found; skipped`); return; }
    s = s.replace(from, to);
  }
  writeFileSync(path, marker + s);
  console.log(`[${tag}] applied to ${file}`);
}

// A douban timeline with a deleted status (no .status) failed the whole feed.
const patchDoubanDeleted = () => patchRoute('douban-deleted', 'status-', 'rexxar/api/v2/status/user_timeline', [
  ['if (items) await getFullTextItems(items);',
    'if (items) { for (let i = items.length - 1; i >= 0; i--) if (!items[i]?.status) items.splice(i, 1); await getFullTextItems(items); }'],
  ['items ? items[0].status.author.name : userid', 'items?.length ? items[0].status.author.name : userid'],
]);

// A post written straight into a 话题 (or a long post) comes back as an empty status with a topic card;
// the post itself is the topic page, not the status page our first patch links everything to. The
// status page stays the guid, so a post already in Lumen is not taken for a new one.
const patchDoubanTopicLink = () => patchRoute('douban-topic-link', 'status-', 'link: `https://www.douban.com/people/${item.status.author.id}/status/${item.status.id}/`,', [
  ['link: `https://www.douban.com/people/${item.status.author.id}/status/${item.status.id}/`,',
    'guid: `https://www.douban.com/people/${item.status.author.id}/status/${item.status.id}/`, link: item.status.card?.type === "topic" && item.status.card.url && !item.status.text && !item.status.activity ? item.status.card.url.replace(/\\?.*$/, "") : `https://www.douban.com/people/${item.status.author.id}/status/${item.status.id}/`,'],
]);

// The same holds for a 书评/日记 put out as a status (a review card, no text), and for a plain 转发 of
// such a post or of a 话题 (转发小组讨论; no comment of one's own): the link goes to the post, not to whoever shared it
// (2026-10-28). Applied over douban-topic-link, which it widens.
const patchDoubanCardLink = () => patchRoute('douban-card-link', 'status-', 'link: item.status.card?.type === "topic"', [
  ['link: item.status.card?.type === "topic" && item.status.card.url && !item.status.text && !item.status.activity ? item.status.card.url.replace(/\\?.*$/, "") : `',
    'link: ((s) => { const post = (x) => !x || x.text ? null : x.activity === "转发" ? post(x.reshared_status) : (!x.activity || x.activity === "转发小组讨论") && x.card?.url && /^(topic|review|note)$/.test(x.card.type) ? x.card.url.replace(/\\?.*$/, "") : null; return post(s); })(item.status) ?? `'],
]);

// Friends' timelines and statuses are public: asked without the login cookie (tried 2026-10-24, 200
// with only a Referer, even for timelines that answered 403 with it). ~94 timelines a day, each with
// a full-text request per status, went out logged in, and douban ended the session (ck and dbcl2
// deleted) — which also broke 想读. The login is kept for the reader's own clicks (server/content/douban.ts).
// A status's full text does not change: kept a month, not the hour every other content gets.
const patchDoubanAnon = () => patchRoute('douban-anon', 'status-', 'rexxar/api/v2/status/user_timeline', [
  ...Array.from({ length: 3 }, () => [',Cookie:process.env.DOUBAN_COOKIE||""', '']),
  ...Array.from({ length: 2 }, () => ['cache_default.set(url, text);', 'cache_default.set(url, text, 30 * 86400);']),
]);

// sspai added activity kinds (e.g. community_release_topic) the route throws on.
const patchSspaiUnknown = () => patchRoute('sspai-unknown', 'activity-', 'Unknown action key', [
  ['default: throw new Error(`Unknown action key: ${item.key}`);',
    'default: { const t = content_data?.topic ?? content_data?.article ?? content_data ?? {}; item_title = `${item.author.nickname}${item.action}：${t.title || ""}`; item_desc = t.summary || t.body || item_title; item_url = t.id_hash ? `https://sspai.com/t/${t.id_hash}` : t.id ? `https://sspai.com/post/${t.id}` : `https://sspai.com/u/${slug}/updates`; }'],
]);

// Without any BILIBILI_COOKIE_* RSSHub falls back to the browser path for every request.
// An anonymous buvid pair from the public fingerprint endpoint is enough for most users;
// a logged-in cookie in rsshub.env (BILIBILI_COOKIE_<uid>) still takes precedence.
async function anonymousBilibiliCookie() {
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
    const { code, data } = await res.json();
    if (code !== 0 || !data?.b_3) throw new Error(`spi code ${code}`);
    return `buvid3=${data.b_3}; buvid4=${encodeURIComponent(data.b_4)}; b_nut=${Math.floor(Date.now() / 1000)}`;
  } catch (e) {
    console.warn(`[bili-cookie] anonymous cookie unavailable: ${e.message}`);
    return null;
  }
}

// One unparsable item date must not fail the whole feed.
function isoDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toJsonFeed(path, data) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: data.title ?? path,
    home_page_url: data.link,
    description: data.description,
    icon: data.image,
    items: (data.item ?? []).map((it) => ({
      id: it.guid ?? it.link ?? it.title,
      url: it.link,
      title: it.title,
      content_html: it.description ?? '',
      date_published: isoDate(it.pubDate),
      authors: it.author ? [{ name: typeof it.author === 'string' ? it.author : it.author.map?.((a) => a.name).join(', ') }] : undefined,
      image: it.image ?? it.itunes_item_image,
      tags: Array.isArray(it.category) ? it.category.map(String) : it.category ? [String(it.category)] : undefined,
      attachments: it.enclosure_url ? [{ url: it.enclosure_url, mime_type: it.enclosure_type ?? 'application/octet-stream', size_in_bytes: Number(it.enclosure_length) || undefined }] : undefined,
    })),
  };
}

// A route that blows up outside its promise must not take the whole bridge down.
process.on('uncaughtException', (e) => console.error('[rsshub] uncaught', e?.stack ?? e));
process.on('unhandledRejection', (e) => console.error('[rsshub] unhandled rejection', e?.stack ?? e));

// weibo/bilibili render through a headless browser; reuse the installed Chrome
// instead of downloading Playwright's build.
const SYSTEM_CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find((p) => existsSync(p));

// header-generator 2.1.88 presets ask for "last 5 chrome versions", which browserslist now
// resolves past the newest browser in its bundled dataset, so zhihu and others fail with
// "No headers based on this input can be generated". Retry with the same browser family, unversioned.
async function relaxHeaderGenerator() {
  const { HeaderGenerator } = await import('header-generator');
  const original = HeaderGenerator.prototype.getHeaders;
  // getHeaders drops falsy options and falls back to the constructor's query, so the
  // unversioned retry needs a generator of its own (built once per preset instance).
  const relaxed = new WeakMap();
  HeaderGenerator.prototype.getHeaders = function (options = {}, ...rest) {
    try {
      return original.call(this, options, ...rest);
    } catch (e) {
      const query = options.browserListQuery || this.globalOptions?.browserListQuery || '';
      if (!query) throw e;
      if (!relaxed.has(this)) {
        const family = ['chrome', 'firefox', 'safari', 'edge'].filter((b) => query.includes(b));
        const { operatingSystems, devices, locales } = this.globalOptions;
        relaxed.set(this, new HeaderGenerator({ operatingSystems, devices, locales, ...(family.length ? { browsers: family } : {}) }));
      }
      const { browserListQuery, ...rest0 } = options;
      return relaxed.get(this).getHeaders(rest0, ...rest);
    }
  };
}

const env = loadEnv(join(HERE, 'rsshub.env'));
Object.assign(process.env, env);
// Room for the douban statuses' full texts kept a month (douban-anon): 94 timelines × 10 statuses
// overflowed the default 256 entries, and every daily pass asked douban for all of them again.
process.env.MEMORY_MAX ??= '4096';
patchDouban();
patchBilibiliCookieWait();
patchDoubanDeleted();
patchDoubanTopicLink();
patchDoubanCardLink();
patchDoubanAnon();
patchSspaiUnknown();
await relaxHeaderGenerator();
// A cookie exported from the browser often lacks buvid3/buvid4, which bilibili's
// risk control (-352) keys on; borrow the anonymous fingerprint for those.
const biliKeys = Object.keys(env).filter((k) => k.startsWith('BILIBILI_COOKIE_'));
const needsFingerprint = !biliKeys.length || biliKeys.some((k) => !/buvid3=/.test(env[k]));
const anonBili = needsFingerprint ? await anonymousBilibiliCookie() : null;
for (const k of biliKeys) if (anonBili && !/buvid3=/.test(env[k])) env[k] = `${env[k]}; ${anonBili}`;
const biliCookie = biliKeys.length ? null : anonBili;
const { init, request } = await import('rsshub');
await init({
  CACHE_TYPE: 'memory',
  CACHE_EXPIRE: '3600',
  CACHE_CONTENT_EXPIRE: '86400',
  REQUEST_TIMEOUT: '30000',
  NO_LOGFILES: 'true',
  LOGGER_LEVEL: 'warn',
  // header-generator can't build random browser headers in this install; use RSSHub's fixed UA.
  NO_RANDOM_UA: 'true',
  ...(SYSTEM_CHROME ? { CHROMIUM_EXECUTABLE_PATH: SYSTEM_CHROME } : {}),
  ...(biliCookie ? { BILIBILI_COOKIE_anon: biliCookie } : {}),
  ...env,
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`route timeout ${ms}ms`)), ms))]);

// request() reports route failures as { error } rather than throwing.
async function runRoute(path, ms) {
  const data = await withTimeout(request(path), ms);
  if (data?.error) throw new Error(data.error.message || 'not found');
  return data;
}

// bilibili's uploads API (/x/space/wbi/arc/search) answers -352 even with a logged-in
// cookie and the browser fallback times out. Uploads also appear in the user's dynamic
// timeline, so serve those (linked straight to the video page) instead.
const BILI_UPLOADS = /^\/bilibili\/user\/video\/(\d+)/;
const BILI_FALLBACK_TIMEOUT_MS = 20_000;

async function routeWithFallback(path) {
  const chart = CHART_ROUTE.exec(new URL(path, 'http://x').pathname);
  if (chart) return doubanBookChart(chart[1] ?? 'all');
  const uid = path.match(BILI_UPLOADS)?.[1];
  if (!uid) return runRoute(path, ROUTE_TIMEOUT_MS);
  try {
    return await runRoute(`/bilibili/user/dynamic/${uid}/directLink=1`, BILI_FALLBACK_TIMEOUT_MS)
      .then((d) => ({ ...d, item: (d.item ?? []).filter((it) => /bilibili\.com\/video\//.test(it.link ?? '')) }))
      .then((d) => { if (!d.item.length) throw new Error('no uploads in dynamic timeline'); return d; });
  } catch (e) {
    console.warn(`[bili-uploads] dynamic fallback failed for ${uid}: ${e.message}; trying uploads route`);
    return runRoute(path, ROUTE_TIMEOUT_MS);
  }
}

// Routes run with the douban/bilibili cookies; a DNS-rebinding page must not be able to read them.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has((req.headers.host ?? '').toLowerCase())) {
    res.writeHead(421, { 'content-type': 'text/plain' });
    res.end('Host not allowed');
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  const path = url.pathname + url.search;
  try {
    const data = await routeWithFallback(path);
    res.writeHead(200, { 'content-type': 'application/feed+json; charset=utf-8' });
    res.end(JSON.stringify(toJsonFeed(path, data)));
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 500);
    const status = /not found|404/i.test(msg) ? 404 : /403|forbidden/i.test(msg) ? 403 : /429|rate.?limit|too many requests/i.test(msg) ? 429 : 503;
    console.warn(`[rsshub] ${path} -> ${status} ${msg}`);
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...(status === 429 ? { 'retry-after': '3600' } : {}) });
    res.end(msg);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`RSSHub bridge on http://127.0.0.1:${PORT}/`));
