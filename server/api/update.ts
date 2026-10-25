// Whether a newer Lumen is out. GitHub is asked once a day while 自动检查更新 is on (the default;
// 设置 → 关于), and whenever someone presses 检查更新 there or in the desktop app's 帮助 menu. Only the
// latest release's version number is asked for. What was found is kept in data/update.json, so a
// restart neither asks again within the day nor forgets a newer version it saw.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, type Settings } from '../config.ts';
import { httpGet } from '../fetch/http.ts';
import { log } from '../log.ts';

export const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const LATEST = 'https://api.github.com/repos/Callioper/Lumen/releases/latest';
const RELEASES = 'https://github.com/Callioper/Lumen/releases/latest';
const FILE = join(DATA_DIR, 'update.json');
// A button pressed twice in a row asks once; the daily check asks once a day.
const KEPT_MS = 60 * 60_000;
const DAILY_MS = 24 * 60 * 60_000;

export interface UpdateInfo { current: string; latest: string | null; newer: boolean; url: string; error?: string }
interface Found { at: number; latest: string; url: string }

// 0.10.0 after 0.9.2: compared number by number; a tag's leading v left off.
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

let found: Found | null = null;
const lastFound = (): Found | null => {
  if (!found) {
    // Missing or unreadable: as if never asked.
    try {
      const f = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Found>;
      if (typeof f.at === 'number' && typeof f.latest === 'string' && typeof f.url === 'string') found = { at: f.at, latest: f.latest, url: f.url };
    } catch { /* asked again */ }
  }
  return found;
};

function keep(f: Found): void {
  found = f;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(f));
    renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    log.warn(`[update] 记不下检查结果：${(e as Error).message}`);
  }
}

// Measured against the version running now: after an upgrade, what was found last week is not newer.
const infoOf = (f: Found): UpdateInfo => ({ current: VERSION, latest: f.latest, newer: isNewer(f.latest, VERSION), url: f.url });

export async function checkUpdate(settings: Settings, now = Date.now(), within = KEPT_MS): Promise<UpdateInfo> {
  const had = lastFound();
  if (had && now - had.at < within) return infoOf(had);
  try {
    const res = await httpGet(LATEST, settings, { headers: { accept: 'application/vnd.github+json' }, timeoutMs: 10_000, publicOnly: true });
    if (res.status !== 200) return { current: VERSION, latest: null, newer: false, url: RELEASES, error: `GitHub 回复 HTTP ${res.status}` };
    const r = JSON.parse(res.body.toString('utf8')) as { tag_name?: string; html_url?: string };
    const latest = (r.tag_name ?? '').replace(/^v/, '');
    if (!latest) return { current: VERSION, latest: null, newer: false, url: RELEASES, error: 'GitHub 没给出版本号' };
    const f = { at: now, latest, url: r.html_url ?? RELEASES };
    keep(f);
    return infoOf(f);
  } catch (e) {
    return { current: VERSION, latest: null, newer: false, url: RELEASES, error: `连不上 GitHub：${(e as Error).message}` };
  }
}

// The daily check (main.ts): nothing when it is turned off, or when asked within the day.
export async function dailyCheck(settings: Settings, now = Date.now()): Promise<void> {
  if (!settings.updateCheck) return;
  const r = await checkUpdate(settings, now, DAILY_MS);
  if (r.error) log.warn(`[update] 检查更新：${r.error}`);
  else if (r.newer) log.info(`[update] 有新版本 v${r.latest}（现在是 v${VERSION}）`);
}

// A newer version known from the last check, for 首页's notice and the desktop app's; null when none.
export function knownUpdate(): UpdateInfo | null {
  const f = lastFound();
  return f && isNewer(f.latest, VERSION) ? infoOf(f) : null;
}
