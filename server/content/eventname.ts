// Whether a title elsewhere — a B站 video (replays.ts), a 回顾 posted after the day (recaps.ts) — is
// about an event of 学术动态: two of its speakers, one and half its title, or nearly all its title.
import type { Notice } from './notices.ts';

const MIN_NAME = 2;
const MIN_CORE = 4;

export const squeeze = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// The title an event goes by, without its quotes, series and subtitle: 「“一生所念”——2026年第25场知名
// 学者学术讲座（远川讲座第58讲）」 is 一生所念.
export function coreName(name: string): string {
  const bare = name.replace(/[“”"《》「」『』]/g, '').replace(/[（(][^）)]*[）)]/g, '').trim();
  return bare.split(/——|—|：|:|｜|\|/).map((x) => x.trim()).find(Boolean) ?? bare;
}
export const speakerNames = (n: Notice): string[] =>
  [...new Set(n.speakers.map((s) => s.replace(/[（(][^）)]*[）)]/g, '').replace(/(教授|老师|博士|研究员|先生|女士)$/, '').trim()))]
    .filter((s) => s.length >= MIN_NAME);

// How much of the event's title another title has: the share of its two-character pieces in it.
export function overlap(core: string, title: string): number {
  const c = squeeze(core), t = squeeze(title);
  if (c.length < MIN_NAME) return 0;
  const pairs = [...c].slice(0, -1).map((ch, i) => ch + c[i + 1]);
  return pairs.filter((p) => t.includes(p)).length / pairs.length;
}

export function namedFor(n: Notice, title: string): boolean {
  const core = coreName(n.name);
  const named = speakerNames(n).filter((s) => title.includes(s)).length;
  const share = overlap(core, title);
  return named >= 2 || (named >= 1 && share >= 0.5) || (squeeze(core).length >= MIN_CORE && share >= 0.8);
}
