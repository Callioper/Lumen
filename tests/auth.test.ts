import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../server/db.ts';
import { checkPassword, endAllSessions, FailGate, hashPassword, isHashed, isLoopback, newSession, validSession, webLoginGuard, SESSION_COOKIE } from '../server/auth.ts';
import { loginApp } from '../server/api/login.ts';
import type { Secrets } from '../server/config.ts';

test('a password is kept as a scrypt hash, and the plain text of older files still checks', () => {
  const h = hashPassword('松溪-密码');
  assert.ok(isHashed(h));
  assert.ok(!h.includes('松溪'));
  assert.notEqual(hashPassword('松溪-密码'), h);   // salted
  assert.equal(checkPassword(h, '松溪-密码'), true);
  assert.equal(checkPassword(h, '松溪-密码 '), false);
  assert.equal(checkPassword('plain', 'plain'), true);
  assert.equal(checkPassword('plain', 'other'), false);
  assert.equal(checkPassword('', ''), false);
  assert.equal(hashPassword(''), '');
});

test('only this machine counts as loopback, whatever the Host says', () => {
  for (const a of ['127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.5', '::ffff:192.168.1.5', '10.0.0.2', '', undefined]) assert.equal(isLoopback(a), false, String(a));
});

test('five wrong passwords lock an address for a minute', () => {
  let now = 0;
  const g = new FailGate(() => now);
  for (let i = 0; i < 4; i++) g.fail('a');
  assert.equal(g.locked('a'), false);
  g.fail('a');
  assert.equal(g.locked('a'), true);
  assert.equal(g.locked('b'), false);
  now = 61_000;
  assert.equal(g.locked('a'), false);
  g.fail('a');
  assert.equal(g.locked('a'), false);   // the count started again
});

test('sessions are kept by hash, run out, and all end together', () => {
  const db = openDb(':memory:');
  const t = newSession(db, 0);
  assert.equal(validSession(db, t, 0), true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM web_session WHERE hash = ?').get(t) as { n: number }).n, 0);
  assert.equal(validSession(db, t, 31 * 86400_000), false);
  assert.equal(validSession(db, 'forged', 0), false);
  endAllSessions(db);
  assert.equal(validSession(db, t, 0), false);
});

function site(remote: string, enabled = true) {
  const db = openDb(':memory:');
  const secrets: Secrets = { aiApiKey: '', embeddingApiKey: '', apiUser: 'lumen', apiPassword: hashPassword('pw') };
  const gate = new FailGate();
  const app = new Hono();
  const remoteOf = (): string => remote;
  app.use('*', webLoginGuard({ db, enabled: () => enabled, remoteOf }));
  app.route('/', loginApp({ db, enabled: () => enabled, getSecrets: () => secrets, gate, remoteOf }));
  app.get('/api/state', (c) => c.json({ ok: true }));
  app.get('/api/greader.php/reader/api/0/user-info', (c) => c.text('own auth'));
  app.get('/', (c) => c.html('app'));
  return { app, db };
}
const page = { accept: 'text/html' };
const login = (app: Hono, user: string, password: string) =>
  app.request('/login', { method: 'POST', body: new URLSearchParams({ user, password }) });

test('another device is sent to the login, and its API calls are refused', async () => {
  const { app } = site('192.168.1.7');
  const r = await app.request('/', { headers: page });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login');
  assert.equal((await app.request('/api/state')).status, 401);
  assert.equal((await app.request('/login', { headers: page })).status, 200);
  assert.equal(await (await app.request('/api/greader.php/reader/api/0/user-info')).text(), 'own auth');
});

test('this machine never signs in, and with the login off nobody does', async () => {
  assert.equal((await site('127.0.0.1').app.request('/api/state')).status, 200);
  assert.equal((await site('192.168.1.7', false).app.request('/api/state')).status, 200);
  const r = await site('127.0.0.1').app.request('/login', { headers: page });
  assert.equal(r.headers.get('location'), '/');
});

test('the right password gives a cookie that opens the app', async () => {
  const { app } = site('192.168.1.7');
  const r = await login(app, 'lumen', 'pw');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  const cookie = r.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const token = cookie.split(';')[0];
  assert.ok(token.startsWith(`${SESSION_COOKIE}=`));
  assert.equal((await app.request('/api/state', { headers: { cookie: token } })).status, 200);
});

test('a wrong password says so, and the sixth try has to wait', async () => {
  const { app } = site('192.168.1.7');
  const r = await login(app, 'lumen', 'nope');
  assert.match(r.headers.get('location') ?? '', /e=bad/);
  assert.equal(r.headers.get('set-cookie'), null);
  for (let i = 0; i < 4; i++) await login(app, 'lumen', 'nope');
  assert.match((await login(app, 'lumen', 'pw')).headers.get('location') ?? '', /e=wait/);
});

test('a hash keeps its cost, and one from before the cost was kept still checks', () => {
  assert.match(hashPassword('pw'), /^scrypt\$32768\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  const salt = Buffer.alloc(16, 7);
  const old = `scrypt$${salt.toString('hex')}$${scryptSync('pw', salt, 32).toString('hex')}`;
  assert.equal(checkPassword(old, 'pw'), true);
  assert.equal(checkPassword('scrypt$99999999$aa$bb', 'pw'), false);
});

test('a request forwarded by a proxy on this machine is not taken for this machine', async () => {
  const { app } = site('127.0.0.1');
  assert.equal((await app.request('/api/state', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 401);
  assert.equal((await app.request('/api/state', { headers: { forwarded: 'for=203.0.113.9' } })).status, 401);
});

test('the wrong-password count is per IPv6 /64 and does not grow without end', () => {
  let now = 0;
  const g = new FailGate(() => now);
  for (let i = 0; i < 5; i++) g.fail(`2001:db8:1:2::${i}`);
  assert.equal(g.locked('2001:db8:1:2::ffff'), true);
  for (let i = 0; i < 1500; i++) g.fail(`10.0.${i >> 8}.${i & 255}`);
  assert.ok((g as unknown as { fails: Map<string, unknown> }).fails.size <= 1000);
});

test('an odd message key on the login page is ignored, not a crash', async () => {
  const { app } = site('192.168.1.7');
  for (const e of ['constructor', '__proto__', 'toString']) {
    const r = await app.request(`/login?e=${e}`, { headers: page });
    assert.equal(r.status, 200, e);
  }
});
