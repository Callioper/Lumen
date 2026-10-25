// Whether a newer Lumen is out: GitHub is asked only when someone presses 检查更新 (设置 → 关于, or the
// desktop app's 帮助 menu), and the answer kept an hour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../config.ts';
import { httpGet } from '../fetch/http.ts';

export const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const LATEST = 'https://api.github.com/repos/Callioper/Lumen/releases/latest';
const RELEASES = 'https://github.com/Callioper/Lumen/releases/latest';
const KEPT_MS = 60 * 60_000;

export interface UpdateInfo { current: string; latest: string | null; newer: boolean; url: string; error?: string }

// 0.10.0 after 0.9.2: compared number by number; a tag's leading v left off.
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

let kept: { at: number; info: UpdateInfo } | null = null;

export async function checkUpdate(settings: Settings, now = Date.now()): Promise<UpdateInfo> {
  if (kept && now - kept.at < KEPT_MS) return kept.info;
  try {
    const res = await httpGet(LATEST, settings, { headers: { accept: 'application/vnd.github+json' }, timeoutMs: 10_000, publicOnly: true });
    if (res.status !== 200) return { current: VERSION, latest: null, newer: false, url: RELEASES, error: `GitHub 回复 HTTP ${res.status}` };
    const r = JSON.parse(res.body.toString('utf8')) as { tag_name?: string; html_url?: string };
    const latest = (r.tag_name ?? '').replace(/^v/, '') || null;
    const info = { current: VERSION, latest, newer: !!latest && isNewer(latest, VERSION), url: r.html_url ?? RELEASES };
    kept = { at: now, info };
    return info;
  } catch (e) {
    return { current: VERSION, latest: null, newer: false, url: RELEASES, error: `连不上 GitHub：${(e as Error).message}` };
  }
}
