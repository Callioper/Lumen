import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchLoop, loopHealth } from '../server/stall.ts';

test('a synchronous job holding the server up is counted as a stall', async () => {
  const stop = watchLoop();
  await new Promise((ok) => setTimeout(ok, 150));
  const until = Date.now() + 600;
  while (Date.now() < until) { /* hold the event loop */ }
  await new Promise((ok) => setTimeout(ok, 150));
  stop();
  assert.equal(loopHealth().stalls, 1);
  assert.ok(loopHealth().worstMs >= 400, String(loopHealth().worstMs));
});
