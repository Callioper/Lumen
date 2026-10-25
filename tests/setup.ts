// Loaded before every test file (package.json "test"): the tests' logs, caches and copies go to a
// directory of their own, never into the reader's data/.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LUMEN_DATA ??= mkdtempSync(join(tmpdir(), 'lumen-test-'));
