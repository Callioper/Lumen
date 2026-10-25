// Does a packaged app's own runtime start Lumen? Runs the server the way desktop/main.js does (the app's
// binary as Node, ELECTRON_RUN_AS_NODE) on a throwaway data folder, and asks it for a page and the API.
//   node desktop/smoke.mjs <packaged binary> <packaged app folder>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 8796;
const WAIT_MS = 60_000;
const [binary, appDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!binary || !appDir) { console.error('usage: node desktop/smoke.mjs <binary> <app folder>'); process.exit(2); }

const data = mkdtempSync(join(tmpdir(), 'lumen-smoke-'));
writeFileSync(join(data, 'settings.json'), JSON.stringify({ port: PORT }));
const child = spawn(binary, [join(appDir, 'server', 'main.ts')], {
  cwd: appDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LUMEN_DATA: data }, stdio: ['ignore', 'inherit', 'inherit'],
});

const done = (code, why) => { console.log(why); child.kill(); setTimeout(() => { rmSync(data, { recursive: true, force: true }); process.exit(code); }, 1000); };
child.on('exit', (code) => done(1, `服务进程提前退出（code ${code}）`));

const started = Date.now();
while (Date.now() - started < WAIT_MS) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const state = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    const page = await fetch(`http://127.0.0.1:${PORT}/`);
    const html = await page.text();
    if (state.ok && page.ok && html.includes('<div id=')) { child.removeAllListeners('exit'); done(0, `ok：${binary} 跑起了 Lumen`); break; }
  } catch { /* not up yet */ }
}
if (Date.now() - started >= WAIT_MS) { child.removeAllListeners('exit'); done(1, `${WAIT_MS / 1000} 秒内没起来`); }
