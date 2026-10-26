import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../server/fetch/parse.ts';

const rss = (channel: string): string => `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>t</title><link>https://example.org/</link>${channel}</channel></rss>`;

test('a feed\'s image is its <image>, else a podcast\'s itunes:image', async () => {
  assert.equal((await parseFeed(rss('<image><url>https://example.org/a.jpg</url></image>'))).image, 'https://example.org/a.jpg');
  assert.equal((await parseFeed(rss('<itunes:image href="https://example.org/cover.jpg"/>'))).image, 'https://example.org/cover.jpg');
  assert.equal((await parseFeed(rss(''))).image, '');
});
