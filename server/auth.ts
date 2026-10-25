// The optional web login, and the password it shares with the GReader API.
//
// Off by default: Lumen listens on this machine only. With settings.webLogin on, a request from any
// other device needs a session cookie, got on /login with the GReader user name and password; this
// machine itself never has to sign in. The remote address decides, not the Host header, which any
// client can set to 127.0.0.1.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { DB } from './db.ts';

const SCRYPT_PREFIX = 'scrypt$';
const KEY_BYTES = 32;
const SCRYPT_N = 2 ** 15;        // kept in the hash, so it can be raised later; hashes without it used Node's 2^14
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const FAIL_KEYS_MAX = 1000;
export const SESSION_COOKIE = 'lumen_session';
export const SESSION_DAYS = 30;
const FAIL_LIMIT = 5;            // wrong passwords from one address before it has to wait
const FAIL_LOCK_MS = 60_000;

export function hashPassword(password: string): string {
  if (!password) return '';
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, maxmem: SCRYPT_MAXMEM });
  return `${SCRYPT_PREFIX}${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export const isHashed = (stored: string): boolean => stored.startsWith(SCRYPT_PREFIX);

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Plain text is what files from before hashing hold, and what LUMEN_API_PASSWORD gives.
export function checkPassword(stored: string, given: string): boolean {
  if (!stored || !given) return false;
  if (!isHashed(stored)) return safeEq(Buffer.from(stored), Buffer.from(given));
  const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
  const [n, salt, key] = parts.length === 3 ? parts : ['16384', ...parts];
  const N = Number(n);
  if (!salt || !key || !Number.isSafeInteger(N) || N < 2 || N > 2 ** 20) return false;
  return safeEq(scryptSync(given, Buffer.from(salt, 'hex'), KEY_BYTES, { N, maxmem: SCRYPT_MAXMEM }), Buffer.from(key, 'hex'));
}

// Behind a proxy on this same machine every request comes from 127.0.0.1; one that says it was
// forwarded is never taken for this machine.
export function isLocalRequest(c: Context, remote: string | undefined): boolean {
  return isLoopback(remote) && !c.req.header('x-forwarded-for') && !c.req.header('forwarded') && !c.req.header('x-real-ip');
}

// Addresses are counted per IPv6 /64, which one device can roam within.
const gateKey = (addr: string): string => (addr.includes(':') && !addr.startsWith('::ffff:') ? addr.split(':').slice(0, 4).join(':') : addr);

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

// Wrong passwords per address: the web login and GReader's ClientLogin both count here.
export class FailGate {
  private fails = new Map<string, { n: number; until: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  locked(addr: string): boolean {
    const f = this.fails.get(gateKey(addr));
    return !!f && f.n >= FAIL_LIMIT && this.now() < f.until;
  }
  fail(addr: string): void {
    const k = gateKey(addr);
    const f = this.fails.get(k);
    const n = f && this.now() < f.until ? f.n + 1 : 1;
    if (this.fails.size >= FAIL_KEYS_MAX) {
      for (const [key, v] of this.fails) if (this.now() >= v.until) this.fails.delete(key);
      if (this.fails.size >= FAIL_KEYS_MAX) this.fails.delete(this.fails.keys().next().value!);
    }
    this.fails.set(k, { n, until: this.now() + FAIL_LOCK_MS });
  }
  pass(addr: string): void { this.fails.delete(gateKey(addr)); }
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newSession(db: DB, now = Date.now()): string {
  const token = randomBytes(32).toString('base64url');
  const at = Math.floor(now / 1000);
  db.prepare('DELETE FROM web_session WHERE expires < ?').run(at);
  db.prepare('INSERT INTO web_session (hash, created, expires) VALUES (?, ?, ?)').run(tokenHash(token), at, at + SESSION_DAYS * 86400);
  return token;
}

export function validSession(db: DB, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM web_session WHERE hash = ? AND expires >= ?').get(tokenHash(token), Math.floor(now / 1000));
}

export const endSession = (db: DB, token: string | undefined): void => {
  if (token) db.prepare('DELETE FROM web_session WHERE hash = ?').run(tokenHash(token));
};

// A new password signs every device out.
export const endAllSessions = (db: DB): void => { db.prepare('DELETE FROM web_session').run(); };

export function cookieOf(c: Context, name: string): string | undefined {
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export const sessionCookie = (token: string, maxAge = SESSION_DAYS * 86400): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

// Paths a device that has not signed in may still ask for: the login itself, and the GReader API,
// which has its own password check.
const OPEN_PATHS = /^\/(login(\.css)?|favicon\.svg|api\/greader\.php(\/.*)?)$/;

export interface GuardDeps {
  db: DB;
  enabled: () => boolean;
  remoteOf: (c: Context) => string | undefined;
}

export function webLoginGuard(d: GuardDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!d.enabled() || isLocalRequest(c, d.remoteOf(c))) return next();
    const path = new URL(c.req.url).pathname;
    if (OPEN_PATHS.test(path) || validSession(d.db, cookieOf(c, SESSION_COOKIE))) return next();
    // A page asked for by the browser goes to the login; an image, a script or an API call is refused.
    const isPage = c.req.method === 'GET' && !path.startsWith('/api/') && (c.req.header('accept') ?? '').includes('text/html');
    return isPage ? c.redirect('/login', 303) : c.json({ error: '需要登录' }, 401);
  };
}
