import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutCredentials } from '../server/fetch/http.ts';

test('a redirect to another site drops the login but keeps the other headers', () => {
  assert.deepEqual(withoutCredentials({ Cookie: 'sid=x', authorization: 'Bearer y', accept: 'text/html' }), { accept: 'text/html' });
});
