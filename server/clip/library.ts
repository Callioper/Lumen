// Tag and person-name libraries kept as plain notes in the vault, so they can be edited in
// Obsidian. Lumen reads them when archiving and appends what it meets for the first time.
//   标签库: "- 媒介研究" per line, "/" for hierarchy.
//   人名库: "- 中文名 | 原名 | 别名、别名" per line; original and aliases may be empty.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Person { zh: string; original: string; aliases: string[] }

const ENTRY = /^\s*-\s+(.+?)\s*$/;
const NEW_TAGS_HEADING = '## 待整理（Lumen 新增）';
const NEW_NAMES_HEADING = '## 待确认（Lumen 新增）';
// Seeded names that so far only appear in their original form; the AI's Chinese rendering wins over them.
const NO_CHINESE_HEADING = '## 待补中文名（暂以原名占位）';
const HAS_CJK = /[\u3400-\u9fff]/;

// "Mark Fisher", "mark·fisher" and "Mark  Fisher" are the same person.
export const nameKey = (s: string): string => s.toLowerCase().replace(/[\s·・.．\-‐_]/g, '');

export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const m = ENTRY.exec(line);
    if (m) seen.add(m[1].replace(/^#/, '').split(/\s+[—–-]\s+/)[0].trim());
  }
  return [...seen].filter(Boolean);
}

export function parsePeople(text: string): Person[] {
  const out: Person[] = [];
  for (const line of text.split('\n')) {
    const m = ENTRY.exec(line);
    if (!m) continue;
    const [zh = '', original = '', aliases = ''] = m[1].split(/\s*[|｜]\s*/);
    if (!zh.trim()) continue;
    out.push({ zh: zh.trim(), original: original.trim(), aliases: aliases.split(/[、,，;；]/).map((a) => a.trim()).filter(Boolean) });
  }
  return out;
}

export const formatPerson = (p: Person): string =>
  `- ${p.zh} | ${p.original}${p.aliases.length ? ` | ${p.aliases.join('、')}` : ''}`.replace(/ \| $/, '');

export function findPerson(people: Person[], ...names: string[]): Person | undefined {
  const keys = names.filter(Boolean).map(nameKey);
  return people.find((p) => [p.zh, p.original, ...p.aliases].some((n) => n && keys.includes(nameKey(n))));
}

function appendUnder(file: string, heading: string, lines: string[]): void {
  if (!lines.length) return;
  const text = readFileSync(file, 'utf8');
  const head = text.includes(heading) ? '' : `\n${heading}\n\n`;
  appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${head}${lines.join('\n')}\n`, 'utf8');
}

export class Libraries {
  private vault: string;
  private tagFile: string;
  private nameFile: string;
  private authorsDir: string;

  constructor(vault: string, tagRel: string, nameRel: string, authorsRel: string) {
    this.vault = vault;
    this.tagFile = join(vault, tagRel);
    this.nameFile = join(vault, nameRel);
    this.authorsDir = join(vault, authorsRel);
  }

  tags(): string[] { return existsSync(this.tagFile) ? parseTags(readFileSync(this.tagFile, 'utf8')) : []; }
  people(): Person[] { return existsSync(this.nameFile) ? parsePeople(readFileSync(this.nameFile, 'utf8')) : []; }

  addTags(tags: string[]): void {
    const known = new Set(this.tags());
    appendUnder(this.tagFile, NEW_TAGS_HEADING, tags.filter((t) => !known.has(t)).map((t) => `- ${t}`));
  }

  addPeople(people: Person[]): void {
    const known = this.people();
    const fresh = people.filter((p) => !findPerson(known, p.zh, p.original));
    appendUnder(this.nameFile, NEW_NAMES_HEADING, fresh.map(formatPerson));
  }

  // Author pages (350 Authors) by every name they answer to, for [[page|中文名]] links.
  authorPages(): Map<string, string> {
    const pages = new Map<string, string>();
    if (!existsSync(this.authorsDir)) return pages;
    for (const f of readdirSync(this.authorsDir)) {
      if (!f.endsWith('.md')) continue;
      const page = f.slice(0, -3);
      pages.set(nameKey(page), page);
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(this.authorsDir, f), 'utf8'))?.[1] ?? '';
      for (const a of aliasesOf(fm)) pages.set(nameKey(a), page);
    }
    return pages;
  }

  ensureSeeded(seedTags: () => string[], seedPeople: () => Person[]): void {
    if (!existsSync(this.tagFile)) {
      mkdirSync(dirname(this.tagFile), { recursive: true });
      writeFileSync(this.tagFile, TAG_HEADER + seedTags().map((t) => `- ${t}`).join('\n') + '\n', 'utf8');
    }
    if (!existsSync(this.nameFile)) {
      mkdirSync(dirname(this.nameFile), { recursive: true });
      const people = seedPeople();
      const named = people.filter((p) => isChinese(p.zh)).map(formatPerson);
      const pending = people.filter((p) => !isChinese(p.zh)).map(formatPerson);
      writeFileSync(this.nameFile, `${NAME_HEADER}${named.join('\n')}\n\n${NO_CHINESE_HEADING}\n\n${pending.join('\n')}\n`, 'utf8');
    }
  }

  get vaultPath(): string { return this.vault; }
}

export function aliasesOf(frontmatter: string): string[] {
  const inline = /^aliases:\s*\[([^\]]*)\]/m.exec(frontmatter)?.[1];
  if (inline !== undefined) return inline.split(',').map((a) => a.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const list = /^aliases:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(frontmatter)?.[1] ?? '';
  return list.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export const isChinese = (s: string): boolean => HAS_CJK.test(s);

const TAG_HEADER = `# 标签库

Lumen 存档文章时只从这里挑标签（每行一个，可用 / 分层，如 \`文学理论/叙事学\`）。
可以直接增删改；Lumen 遇到库里没有、又确实需要的标签，会追加到文末「待整理」一节。

## 标签

`;

const NAME_HEADER = `# 人名库

Lumen 存档时把作者、译者统一写成这里的中文名。每行：\`- 中文名 | 原名 | 别名、别名\`，原名和别名可空。
可以直接增删改；第一次遇到的人会追加到文末「待确认」一节，确认译名后挪到上面即可。

## 人名

`;
