// How long the server kept you waiting: event-loop stalls (a synchronous job holding up every
// request) and slow requests, both logged as they happen and summed up for /api/jobs and
// scripts/status.mjs, so a slow day can be traced to what caused it.
import type { Context, Next } from 'hono';
import { log } from './log.ts';

const TICK_MS = 100;
const STALL_MS = 300;          // a tick this much late is logged
const SLOW_REQUEST_MS = 1000;
const KEEP = 20;               // the last few of each, newest first

export interface Stall { at: number; ms: number }
export interface SlowRequest { at: number; ms: number; path: string }
export interface LoopHealth { since: number; stalls: number; worstMs: number; recent: Stall[]; slow: SlowRequest[] }

const health: LoopHealth = { since: Date.now(), stalls: 0, worstMs: 0, recent: [], slow: [] };
const remember = <T>(list: T[], x: T): T[] => [x, ...list].slice(0, KEEP);

export function watchLoop(): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = Math.round(now - last - TICK_MS);
    last = now;
    if (late < STALL_MS) return;
    health.stalls++;
    health.worstMs = Math.max(health.worstMs, late);
    health.recent = remember(health.recent, { at: Date.now(), ms: late });
    log.warn(`[stall] 服务卡住 ${late} ms`);
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Long-lived streams (/api/events) are left out: they are meant to stay open.
export async function timeRequests(c: Context, next: Next): Promise<void> {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  const path = c.req.path;
  if (ms < SLOW_REQUEST_MS || path === '/api/events') return;
  health.slow = remember(health.slow, { at: Date.now(), ms, path });
  log.warn(`[slow] ${c.req.method} ${path} ${ms} ms`);
}

export const loopHealth = (): LoopHealth => health;
