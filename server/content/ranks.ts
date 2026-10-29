// 期刊等级: whether a journal is in CSSCI (来源期刊, 扩展版) or 北大核心, by edition (ranks.json, built by
// scripts/dev/ranks-build.mjs), and in the reader's own school's list of 权威 journals when there is one
// (data/journal-school.json: not part of Lumen, each school keeps its own). Shown by 期刊目录's issues,
// 学术动态's calls for papers and the reader's source line.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { log } from '../log.ts';

export type ListKind = 'cssci' | 'cssci-ext' | 'pku' | 'ami' | 'ami-jikan' | 'rdfy' | 'nssf';
// AMI's lists are one a level (顶级, 权威, 核心, 扩展; 集刊 核心).
interface List { id: string; kind: ListKind; level?: string; edition: string; current: boolean; journals: string[] }
export interface School { school: string; short: string; from: string; note: string; authority: Record<string, string[]>; aliases?: Record<string, string> }

// Where a journal stands: each list it is in (latest edition first), and its level in the school's list.
export interface JournalRank {
  in: { kind: ListKind; level?: string; edition: string; current: boolean }[];
  school?: { short: string; level: string; from: string };
}

// One key for the ways a name is written: 「北京大学学报（哲学社会科学版）」, 「北京大学学报.哲学社会科学版」 and
// 「《北京大学学报(哲学社会科学版)》」 are one; 「课程·教材·教法」 and 「课程.教材.教法」 too.
// 期刊目录's short forms of an edition (「哲社版」, 「社科版」) are spelled out first.
const SHORT_EDITIONS: [RegExp, string][] = [[/人文社科版/g, '人文社会科学版'], [/哲社版/g, '哲学社会科学版'], [/社科版/g, '社会科学版']];
export const rankKey = (name: string): string =>
  SHORT_EDITIONS.reduce((n, [re, full]) => n.replace(re, full), name.normalize('NFKC'))
    .replace(/[《》〈〉“”"'\s()（）[\]【】·・.．,，、:：\-—–_]/g, '').toLowerCase();

// The editions of a 学报 a humanities reader does not mean when they leave the edition out.
const SCIENCE_EDITION = /自然科学|医学|理工|工学|农学|农业科学|技术科学|信息科学/;

interface Index { byKey: Map<string, JournalRank>; keys: string[] }
let index: Index | null = null;

function load(): Index {
  const lists = (JSON.parse(readFileSync(new URL('./ranks.json', import.meta.url), 'utf8')) as { lists: List[] }).lists;
  const byKey = new Map<string, JournalRank>();
  const at = (k: string): JournalRank => byKey.get(k) ?? (byKey.set(k, { in: [] }), byKey.get(k)!);
  for (const l of lists) for (const name of l.journals) {
    const r = at(rankKey(name));
    if (!r.in.some((x) => x.kind === l.kind && x.edition === l.edition)) r.in.push({ kind: l.kind, ...(l.level ? { level: l.level } : {}), edition: l.edition, current: l.current });
  }
  // One list names a journal without its edition where another gives it (CSSCI 「上海财经大学学报」, 北大
  // 「上海财经大学学报(哲学社会科学版)」): the bare name takes the lists of its one non-science edition.
  for (const [k, r] of byKey) {
    const editions = [...byKey.keys()].filter((x) => x !== k && x.startsWith(k) && !SCIENCE_EDITION.test(x.slice(k.length)));
    if (editions.length !== 1) continue;
    for (const x of byKey.get(editions[0])!.in) if (!r.in.some((y) => y.kind === x.kind && y.edition === x.edition)) r.in.push(x);
  }
  for (const r of byKey.values()) r.in.sort((a, b) => b.edition.localeCompare(a.edition));
  const school = readSchool();
  if (school) {
    for (const [level, journals] of Object.entries(school.authority)) for (const name of journals) {
      at(rankKey(school.aliases?.[name] ?? name)).school = { short: school.short, level, from: school.from };
    }
  }
  return { byKey, keys: [...byKey.keys()] };
}

const SCHOOL_FILE = (): string => join(DATA_DIR, 'journal-school.json');
function readSchool(): School | null {
  if (!existsSync(SCHOOL_FILE())) return null;
  try {
    return JSON.parse(readFileSync(SCHOOL_FILE(), 'utf8')) as School;
  } catch (e) {
    log.warn(`[期刊等级] ${SCHOOL_FILE()} 读不了：${(e as Error).message}`);
    return null;
  }
}

// A journal's standing by its name; null when it is in none of the lists. A name without its edition
// (「华东师范大学学报」) is taken for the one journal it begins, and for none when it begins several.
const MIN_PREFIX = 4;
export function journalRank(name: string, opts: { exact?: boolean } = {}): JournalRank | null {
  index ??= load();
  const k = rankKey(name);
  if (!k) return null;
  const exact = index.byKey.get(k);
  if (exact) return exact;
  if (opts.exact || k.length < MIN_PREFIX) return null;
  const longer = index.keys.filter((x) => x.startsWith(k) && !SCIENCE_EDITION.test(x.slice(k.length)));
  return longer.length === 1 ? index.byKey.get(longer[0])! : null;
}

// Narrowing 期刊目录 to a level: in the current CSSCI (not 扩展版), the current 北大核心, AMI 核心 or above, or the
// school's 权威 list.
export const RANK_FILTERS = ['cssci', 'pku', 'ami', 'school'] as const;
const AMI_RANKED = new Set(['顶级', '权威', '核心']);
export type RankFilter = '' | typeof RANK_FILTERS[number];
export function rankIs(r: JournalRank | null, f: RankFilter): boolean {
  if (!f) return true;
  if (!r) return false;
  if (f === 'school') return !!r.school;
  if (f === 'ami') return r.in.some((x) => (x.kind === 'ami' || x.kind === 'ami-jikan') && x.current && AMI_RANKED.has(x.level ?? ''));
  return r.in.some((x) => x.kind === f && x.current);
}
// The school's short name for the filter's label (「某校权威」), '' when there is no school list.
export const schoolShort = (): string => readSchool()?.short ?? '';

// The journal a call for papers is for: the title in 《》, else none.
export const calledJournal = (name: string): string => /《([^》]+)》/.exec(name)?.[1] ?? '';
