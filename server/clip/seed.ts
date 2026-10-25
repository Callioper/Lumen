// First-run contents of the tag and name libraries, taken from what the vault already uses.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { aliasesOf, findPerson, isChinese, type Person } from './library.ts';

// Tags that describe the note's kind or the workflow, not the article's subject.
const WORKFLOW_TAGS = new Set(['概念卡片', '概念卡', '读书笔记', '分篇笔记', '论文笔记', '350Authors', '360Meeting', 'writing', 'excalidraw',
  '视频笔记', '分章', '人物', 'learning', 'thinking', '读书报告', '版本对比', 'Movie', '作者', '文献综述', '-', 'todo', 'TODO']);
const MIN_TAG_USES = 2;
const MAX_SEED_TAGS = 300;

function* markdownFiles(dir: string): Generator<string> {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* markdownFiles(p);
    else if (d.name.endsWith('.md')) yield p;
  }
}

function tagsIn(text: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const inline = [...text.matchAll(/^\s*-?\s*tags::(.*)$/gm)].flatMap((m) => [...m[1].matchAll(/#([^\s#,，]+)/g)].map((t) => t[1]));
  const fmInline = (/^tags:\s*\[?([^\]\n]*)\]?$/m.exec(fm)?.[1] ?? '').split(/[,\s]+/);
  const fmList = (/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(fm)?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return [...inline, ...fmInline, ...fmList].map((t) => t.trim().replace(/^#/, '')).filter((t) => t && !/^\d+$/.test(t));
}

export function seedTags(vault: string): string[] {
  const count = new Map<string, number>();
  for (const f of markdownFiles(vault)) for (const t of tagsIn(readFileSync(f, 'utf8'))) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].filter(([t, n]) => n >= MIN_TAG_USES && !WORKFLOW_TAGS.has(t))
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_SEED_TAGS).map(([t]) => t).sort((a, b) => a.localeCompare(b, 'zh'));
}

function personFrom(names: string[]): Person | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  const zh = clean.find(isChinese) ?? clean[0];
  if (!zh) return null;
  const original = clean.find((n) => !isChinese(n) && n !== zh) ?? '';
  return { zh, original, aliases: clean.filter((n) => n !== zh && n !== original) };
}

export function seedPeople(vault: string, authorsRel: string, clipsRel: string): Person[] {
  const people: Person[] = [];
  const add = (p: Person | null): void => {
    if (p && !findPerson(people, p.zh, p.original)) people.push(p);
  };
  const authors = join(vault, authorsRel);
  if (existsSync(authors)) {
    for (const f of readdirSync(authors)) {
      if (!f.endsWith('.md') || f.startsWith('MOC')) continue;
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(authors, f), 'utf8'))?.[1] ?? '';
      add(personFrom([f.slice(0, -3), ...aliasesOf(fm)]));
    }
  }
  const clips = join(vault, clipsRel);
  if (existsSync(clips)) {
    for (const f of markdownFiles(clips)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^- (?:author|translator|tranlator)::(.*)$/gm)) {
        for (const link of m[1].matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) add(personFrom([link[1], link[2] ?? '']));
      }
    }
  }
  return people.sort((a, b) => a.zh.localeCompare(b.zh, 'zh'));
}
