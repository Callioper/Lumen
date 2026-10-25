import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../server/api/update.ts';

test('versions are compared number by number, a tag\'s v left off', () => {
  assert.equal(isNewer('0.10.0', '0.9.2'), true);
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('1.0', '0.9.9'), true);
});
