// Accounts the 论文周报 watches closely, by feed title. A key account's long post with notes and an
// author in the headline counts as a paper even when it names no journal: these accounts post papers
// and translated papers, not news. Which accounts those are is the reader's own, so the list lives in
// data/key-sources.json, beside the settings, and is not part of the code:
//   { "某刊公众号": { "journal": "某刊" }, "某文学刊": { "journal": "某文学刊", "literary": true }, "某学人号": {} }
// Without the file there are no key accounts and papers are found by their abstract, notes and source line.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { log } from '../log.ts';

export interface SourceRule {
  journal?: string;     // the account is this journal's own: papers there need not name it
  literary?: boolean;   // also posts poems and fiction: those carry no abstract and no notes
}

const FILE = join(DATA_DIR, 'key-sources.json');

function readKeySources(): Record<string, SourceRule> {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应为对象：{ "公众号名": { "journal"?, "literary"? } }');
    return raw as Record<string, SourceRule>;
  } catch (e) {
    log.warn(`[论文周报] ${FILE} 读不了，当作没有重点公众号：${(e as Error).message}`);
    return {};
  }
}

let keySources: Record<string, SourceRule> | null = null;

// Tests set their own (made-up) accounts instead of reading the file.
export const setKeySources = (rules: Record<string, SourceRule>): void => { keySources = rules; };
export const sourceRule = (feed: string): SourceRule | undefined => (keySources ??= readKeySources())[feed];
