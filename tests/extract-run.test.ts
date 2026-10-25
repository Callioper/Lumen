import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../server/db.ts';
import type { Settings, Secrets } from '../server/config.ts';
import { runExtract, isStalled, type Extractor, type Post } from '../server/content/extract.ts';

// A stand-in AI service: each test says what it answers.
let reply: { status: number; body: string } = { status: 200, body: '' };
let asked = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => { asked++; res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(reply.body); });
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const answer = (content: string) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) });

const settings = { ai: { enabled: true, baseUrl: base, model: 'm' }, translate: { model: 'm' }, proxy: '', noProxy: [] } as unknown as Settings;
const secrets = { aiApiKey: 'k' } as Secrets;
const LATER = 11 * 60_000;      // past the wait after a stopped pass

function setup(bodies: string[]) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO feed (id, url, title) VALUES (1, 'https://a/feed', '某号')").run();
  const add = db.prepare('INSERT INTO entry (id, feed_id, guid, title, content, published, is_read) VALUES (?, 1, ?, ?, ?, ?, 0)');
  const now = Math.floor(Date.now() / 1000);
  bodies.forEach((html, i) => add.run(i + 1, `g${i}`, `推文${i + 1}`, html, now - i));
  const rows = () => (db.prepare('SELECT entry_id, data FROM extract ORDER BY entry_id').all() as { entry_id: number; data: string | null }[]).map((r) => ({ ...r }));
  return { db, rows };
}

const extractor = (kind: 'toc' | 'notice'): Extractor<unknown> => ({
  kind, label: '测试', version: 1, maxTokens: 100,
  candidates: (db, since) => db.prepare('SELECT id, title, published FROM entry WHERE published > ?').all(since) as unknown as Post[],
  ask: (post, text) => [{ role: 'user', content: `${post.title}\n${text}` }],
  read: (raw) => ((raw as { ok?: boolean }).ok ? raw : null),
});

test('a refused account stops the pass and sets nothing down as not one', async () => {
  const { db, rows } = setup(['<p>正文一</p>', '<p>正文二</p>']);
  reply = { status: 401, body: '{"error":"invalid key"}' };
  asked = 0;
  assert.equal(await runExtract(db, extractor('notice'), settings, secrets), 0);
  assert.equal(asked, 1);
  assert.deepEqual(rows(), []);
  assert.equal(isStalled('notice'), true);
  reply = answer('{"ok":true}');
  assert.equal(await runExtract(db, extractor('notice'), settings, secrets), 0);     // still waiting
  assert.equal(await runExtract(db, extractor('notice'), settings, secrets, Date.now() + LATER), 2);
});

test('a post refused for what it says, or with no text, is set down as not one', async () => {
  const { db, rows } = setup(['<p>敏感</p>', '<p> </p>']);
  reply = { status: 422, body: '{"error":"sensitive content"}' };
  asked = 0;
  await runExtract(db, extractor('toc'), settings, secrets);
  assert.equal(asked, 1);                   // the empty post was never sent
  assert.deepEqual(rows(), [{ entry_id: 1, data: null }, { entry_id: 2, data: null }]);
});

test('an answer that cannot be read is tried again on the next pass, then given up, without holding up the rest', async () => {
  const { db, rows } = setup(['<p>长目录</p>', '<p>下一篇</p>']);
  let n = 0;
  const flaky = { ...extractor('toc'), ask: (post: Post, text: string) => { n++; return extractor('toc').ask(post, text); } };
  reply = answer('{"ok": tru');           // cut short
  await runExtract(db, flaky, settings, secrets, Date.now() + 2 * LATER);
  assert.deepEqual(rows(), []);           // neither set down yet: one strike each
  await runExtract(db, flaky, settings, secrets, Date.now() + 2 * LATER);
  assert.deepEqual(rows(), [{ entry_id: 1, data: null }, { entry_id: 2, data: null }]);
  assert.equal(n, 4);
});
