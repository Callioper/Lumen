// Called on a schedule (Task Scheduler, cron, …), e.g. every half hour: node scripts/report-due.mjs --if-due
// Asks the running Lumen to build whichever report is due. Prints nothing when nothing was built,
// and nothing when Lumen is not running (the next call catches up); exits 1 on a failed build.
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../data/settings.json', import.meta.url), 'utf8'));
const ifDue = process.argv.includes('--if-due');
const BUILD_TIMEOUT_MS = 10 * 60_000;

let res;
try {
  res = await fetch(`http://127.0.0.1:${settings.port}/api/reports/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lumen': '1' },
    body: JSON.stringify({ ifDue }),
    signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
  });
} catch (e) {
  if (e.cause?.code === 'ECONNREFUSED') process.exit(0);
  console.log(`Lumen 报告：请求失败 ${e.message}`);
  process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log(`Lumen 报告失败：${body.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}
for (const r of body.results ?? []) if (r.built) console.log(`Lumen 报告已生成：${r.kind} ${r.period} → ${r.path}`);
// A failed build comes back as 200 with a note; it was printed nowhere and the call exited 0.
for (const r of body.results ?? []) if (r.failed) { console.log(`Lumen 报告失败：${r.kind} ${r.period}：${r.note}`); process.exitCode = 1; }
