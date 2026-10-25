// The web login page (server/auth.ts): a plain form, no script, so it works before the app loads.
import { Hono, type Context } from 'hono';
import type { DB } from '../db.ts';
import type { Secrets } from '../config.ts';
import { checkPassword, cookieOf, endSession, FailGate, isLocalRequest, newSession, sessionCookie, SESSION_COOKIE } from '../auth.ts';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const MESSAGES = new Map<string, string>([
  ['bad', '用户名或密码不对。'],
  ['wait', '错得太多了，等一分钟再试。'],
]);

// The 纸墨 palette's paper and ink, light and dark (web/src/themes.ts).
function page(message: string, user: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Lumen</title><link rel="icon" href="/favicon.svg">
<style>
:root { --paper: #fffcf0; --raised: #fff; --ink: #100f0f; --ink-3: #6f6e69; --line: #e6e4d9; --accent: #24837b; --warn: #af3029; }
@media (prefers-color-scheme: dark) { :root { --paper: #100f0f; --raised: #1c1b1a; --ink: #cecdc3; --ink-3: #878580; --line: #343331; --accent: #3aa99f; --warn: #d14d41; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--paper); color: var(--ink);
  font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
form { width: min(340px, 100%); display: grid; gap: 14px; padding: 28px 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--raised); }
h1 { margin: 0 0 4px; display: flex; align-items: center; gap: 10px; font-size: 20px; }
p { margin: 0; color: var(--ink-3); font-size: 13px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--ink-3); }
input { padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.warn { color: var(--warn); }
</style></head><body>
<form method="post" action="/login">
  <h1><img src="/favicon.svg" alt="" width="24" height="24">Lumen</h1>
  <p>从这台设备打开需要登录。用户名和密码是 设置 → 数据与接口 里那一组，和手机客户端共用。</p>
  ${message ? `<p class="warn" role="alert">${esc(message)}</p>` : ''}
  <label>用户名<input name="user" autocomplete="username" required value="${esc(user)}"></label>
  <label>密码<input name="password" type="password" autocomplete="current-password" required autofocus></label>
  <button>登录</button>
</form></body></html>`;
}

export interface LoginDeps {
  db: DB;
  enabled: () => boolean;
  getSecrets: () => Secrets;
  gate: FailGate;
  remoteOf: (c: Context) => string | undefined;
}

export function loginApp(d: LoginDeps): Hono {
  const app = new Hono();
  // Nothing to sign in to here: login off, or this very machine.
  const needless = (c: Context): boolean => !d.enabled() || isLocalRequest(c, d.remoteOf(c));

  app.get('/login', (c) => {
    if (needless(c)) return c.redirect('/', 303);
    c.header('cache-control', 'no-store');
    return c.html(page(MESSAGES.get(c.req.query('e') ?? '') ?? '', c.req.query('u') ?? ''));
  });

  app.post('/login', async (c) => {
    if (needless(c)) return c.redirect('/', 303);
    const addr = d.remoteOf(c) ?? '';
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const user = typeof form.user === 'string' ? form.user : '';
    const password = typeof form.password === 'string' ? form.password : '';
    const back = (e: string): Response => c.redirect(`/login?e=${e}&u=${encodeURIComponent(user)}`, 303);
    if (d.gate.locked(addr)) return back('wait');
    const s = d.getSecrets();
    // The password is checked even for a wrong user name, so the time taken does not tell them apart.
    const passwordOk = checkPassword(s.apiPassword, password);
    if (!s.apiPassword || user !== s.apiUser || !passwordOk) {
      d.gate.fail(addr);
      return back(d.gate.locked(addr) ? 'wait' : 'bad');
    }
    d.gate.pass(addr);
    c.header('set-cookie', sessionCookie(newSession(d.db)));
    return c.redirect('/', 303);
  });

  app.post('/api/logout', (c) => {
    endSession(d.db, cookieOf(c, SESSION_COOKIE));
    c.header('set-cookie', sessionCookie('', 0));
    return c.json({ ok: true });
  });

  return app;
}
