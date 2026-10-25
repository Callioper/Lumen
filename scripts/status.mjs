// Print a one-screen health summary: node scripts/status.mjs
const B = process.env.LUMEN_URL ?? 'http://127.0.0.1:8780';
try {
  const s = await (await fetch(`${B}/api/state`)).json();
  const bad = s.feeds.filter((f) => f.error_count > 0);
  const byErr = {};
  for (const f of bad) { const k = (f.last_error ?? '').replace(/\d{2,}/g, 'N').slice(0, 60); byErr[k] = (byErr[k] ?? 0) + 1; }
  console.log(`running  feeds=${s.feeds.length} ok=${s.feeds.filter((f) => f.last_ok_at && !f.error_count).length} failing=${bad.length} pending=${s.feeds.filter((f) => !f.last_fetch_at).length}`);
  console.log(`entries total=${s.totals.total} unread=${s.totals.unread} starred=${s.totals.starred}  ai-queue=${s.aiQueue} fetching=${s.fetching}`);
  const { loop } = await (await fetch(`${B}/api/jobs`)).json();
  if (loop) console.log(`loop    stalls=${loop.stalls} worst=${loop.worstMs}ms slow-requests=${loop.slow.length}${loop.slow[0] ? ` (last ${loop.slow[0].path} ${loop.slow[0].ms}ms)` : ''}`);
  for (const [k, n] of Object.entries(byErr).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(4)}  ${k}`);
} catch (e) {
  console.log(`down (${e.cause?.code ?? e.message})`);
  process.exit(1);
}
