import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

const LOG_FILE = join(DATA_DIR, 'lumen.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
mkdirSync(DATA_DIR, { recursive: true });

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}\n`;
  process.stdout.write(line);
  try {
    if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) renameSync(LOG_FILE, LOG_FILE + '.1');
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never take the server down; stdout already has the line.
  }
}

export const log = {
  info: (m: string): void => write('INFO', m),
  warn: (m: string): void => write('WARN', m),
  error: (m: string): void => write('ERROR', m),
};
