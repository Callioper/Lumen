// How fast the running server answers each page the UI opens, against a budget: node scripts/bench.mjs
// Each is asked a few times and the median judged, so one cold cache does not fail it (the first,
// cold time is printed beside it); the server's own record of stalls and slow requests
// (server/stall.ts) is printed after.
const B = process.env.LUMEN_URL ?? 'http://127.0.0.1:8780';
const RUNS = 3;
const FAST = 100, SLOWER = 300;      // ms: lists the reader waits on, and pages computed on the spot
const pages = [
  ['/api/state', FAST], ['/api/entries?limit=50', FAST], ['/api/entries?filter=unread&limit=50', FAST],
  ['/api/entries?q=%E5%93%B2%E5%AD%A6&limit=50', SLOWER], ['/api/entries?q=%E7%8A%AC%E5%84%92%E4%B8%BB%E4%B9%89&limit=50', SLOWER],
  ['/api/books', SLOWER], ['/api/books?sort=date', SLOWER], ['/api/tocs', SLOWER], ['/api/tocs?source=cnki', SLOWER],
  ['/api/notices', SLOWER], ['/api/hot', SLOWER], ['/api/marks', SLOWER], ['/api/profile/stats', SLOWER], ['/api/reports', FAST],
];

let failed = 0;
for (const [path, budget] of pages) {
  const times = [];
  let status = 0, bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await fetch(B + path);
    bytes = (await res.arrayBuffer()).byteLength;
    status = res.status;
    times.push(performance.now() - t);
  }
  const ms = Math.round([...times].sort((a, b) => a - b)[Math.floor(RUNS / 2)]);
  const ok = status === 200 && ms <= budget;
  if (!ok) failed++;
  const first = Math.round(times[0]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(ms).padStart(5)} ms / ${budget}  首次 ${String(first).padStart(5)} ms  ${String(Math.round(bytes / 1024)).padStart(4)} KB  ${path}${status === 200 ? '' : `  status=${status}`}`);
}

const { loop } = await (await fetch(`${B}/api/jobs`)).json();
if (loop) {
  const hours = ((Date.now() - loop.since) / 3600_000).toFixed(1);
  const when = (at) => new Date(at).toLocaleString('zh-CN', { hour12: false });
  console.log(`\n${hours} 小时内：卡住 ${loop.stalls} 次，最长 ${loop.worstMs} ms；慢请求 ${loop.slow.length} 个`);
  for (const s of loop.recent.slice(0, 5)) console.log(`  卡住 ${String(s.ms).padStart(6)} ms  ${when(s.at)}`);
  for (const s of loop.slow.slice(0, 5)) console.log(`  慢请求 ${String(s.ms).padStart(5)} ms  ${when(s.at)}  ${s.path}`);
}
process.exit(failed ? 1 : 0);
