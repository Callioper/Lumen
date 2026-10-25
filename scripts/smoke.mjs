// End-to-end smoke check against a running server: node scripts/smoke.mjs [password]
const B = process.env.LUMEN_URL ?? 'http://127.0.0.1:8780';
const pass = process.argv[2] ?? process.env.LUMEN_API_PASSWORD ?? '';
const user = process.env.LUMEN_API_USER ?? 'lumen';
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);

const state = await (await fetch(`${B}/api/state`)).json();
check('state', state.feeds.length > 0, `feeds=${state.feeds.length} unread=${state.totals.unread} starred=${state.totals.starred} total=${state.totals.total} aiKey=${state.hasAiKey}`);

const unread = await (await fetch(`${B}/api/entries?filter=unread&limit=3`)).json();
check('list unread', unread.items.every((i) => i.is_read === 0), `n=${unread.items.length}`);

const last = unread.items.at(-1);
const page2 = await (await fetch(`${B}/api/entries?limit=3&before=${last.published}:${last.id}&filter=unread`)).json();
check('cursor paging', page2.items.length > 0 && page2.items.every((i) => i.published < last.published || (i.published === last.published && i.id < last.id)));

const q = await (await fetch(`${B}/api/entries?q=${encodeURIComponent('犬儒主义')}&limit=5`)).json();
check('fts search', q.items.length > 0, q.items.slice(0, 2).map((i) => i.title).join(' | '));

const short = await (await fetch(`${B}/api/entries?q=${encodeURIComponent('哲学')}&limit=3`)).json();
check('short query LIKE fallback', short.items.length > 0);

const one = await (await fetch(`${B}/api/entries/${unread.items[0].id}`)).json();
check('entry detail', typeof one.content === 'string' && Array.isArray(one.tags));

const csrf = await fetch(`${B}/api/refresh`, { method: 'POST' });
check('csrf guard', csrf.status === 403, `status=${csrf.status}`);

// Host header can't be forged through fetch(); node:http lets us.
const { request } = await import('node:http');
const rebind = await new Promise((r) => request(`${B}/api/state`, { headers: { host: 'evil.com' } }, (res) => r(res.statusCode)).end());
check('host guard', rebind === 421, `status=${rebind}`);

const bad = await fetch(`${B}/api/greader.php/accounts/ClientLogin`, { method: 'POST', body: new URLSearchParams({ Email: user, Passwd: 'wrong' }) });
check('greader wrong password', bad.status === 401);

if (pass) {
  const login = await (await fetch(`${B}/api/greader.php/accounts/ClientLogin`, { method: 'POST', body: new URLSearchParams({ Email: user, Passwd: pass }) })).text();
  const auth = login.match(/Auth=(\S+)/)?.[1];
  check('greader login', !!auth);
  const h = { authorization: `GoogleLogin auth=${auth}` };
  const subs = await (await fetch(`${B}/api/greader.php/reader/api/0/subscription/list?output=json`, { headers: h })).json();
  check('greader subscriptions keep feed/N ids', subs.subscriptions.some((s) => s.id === 'feed/28'), `n=${subs.subscriptions.length}`);
  const st = await (await fetch(`${B}/api/greader.php/reader/api/0/stream/contents/user/-/state/com.google/reading-list?n=2&xt=user/-/state/com.google/read`, { headers: h })).json();
  check('greader reading-list unread', st.items.length > 0 && st.items.every((i) => !i.categories.includes('user/-/state/com.google/read')), `continuation=${!!st.continuation}`);
  const label = await (await fetch(`${B}/api/greader.php/reader/api/0/stream/contents/${encodeURIComponent('user/-/label/学术期刊')}?n=3`, { headers: h })).json();
  check('greader label stream', label.items.length > 0, label.items[0]?.origin?.title);
}

const icon = await fetch(`${B}/icon/${state.feeds[0].id}`);
check('icon', icon.status === 200 || icon.status === 404, `status=${icon.status} ${icon.headers.get('content-type')}`);

const priv = await fetch(`${B}/img?u=${encodeURIComponent('http://127.0.0.1:8780/api/state')}`);
check('img proxy blocks private hosts', priv.status === 403);

// A public name that resolves to loopback must be refused too (DNS check, not just literals).
const rebound = await fetch(`${B}/img?u=${encodeURIComponent('http://127.0.0.1.nip.io:1200/healthz')}`);
check('img proxy blocks names resolving to loopback', rebound.status === 403, `status=${rebound.status}`);

// SVG can carry script; it must never be served from our origin.
const svg = await fetch(`${B}/img?u=${encodeURIComponent('https://www.w3.org/Icons/SVG/svg-logo.svg')}`);
check('img proxy rejects svg', svg.status === 415 || svg.status >= 500, `status=${svg.status}`);
check('media responses are sandboxed', (icon.headers.get('content-security-policy') ?? '').includes('sandbox') || icon.status === 404);

const frame = await fetch(`${B}/`);
check('ui cannot be framed', (frame.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));

const badScope = await fetch(`${B}/api/entries/mark-all`, { method: 'POST', headers: { 'x-lumen': '1', 'content-type': 'application/json' }, body: JSON.stringify({ feed: 'abc' }) });
check('mark-all rejects a non-numeric scope', badScope.status === 400, `status=${badScope.status}`);

const badSettings = await fetch(`${B}/api/settings`, { method: 'PUT', headers: { 'x-lumen': '1', 'content-type': 'application/json' }, body: JSON.stringify({ settings: { noProxy: 'x' } }) });
check('settings validation', badSettings.status === 400, `status=${badSettings.status}`);

const RSSHUB = process.env.RSSHUB_URL ?? 'http://127.0.0.1:1200';
const bridgeHost = await new Promise((r) => request(`${RSSHUB}/healthz`, { headers: { host: 'evil.com:1200' } }, (res) => r(res.statusCode)).on('error', () => r('down')).end());
check('rsshub bridge host guard', bridgeHost === 421, `status=${bridgeHost}`);

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
