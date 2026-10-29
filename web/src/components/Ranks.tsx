// 期刊等级: a journal's standing as small marks beside its name (server/content/ranks.ts). The current
// edition of a list shows as it is (C刊, C扩, 北核); one only an older edition has, with its years, muted:
// a school often counts a journal for some years after it drops out (five, at some).
import type { JournalRank, RankKind } from '../api.ts';
import { cx } from '../util.ts';

const NAME: Record<RankKind, string> = { cssci: 'C刊', 'cssci-ext': 'C扩', pku: '北核', ami: 'A刊', 'ami-jikan': 'A刊集刊', rdfy: '复印来源', nssf: '社科资助' };
const FULL: Record<RankKind, string> = { cssci: 'CSSCI 来源期刊', 'cssci-ext': 'CSSCI 扩展版来源期刊', pku: '北大《中文核心期刊要目总览》',
  ami: '中国人文社会科学期刊 AMI 综合评价', 'ami-jikan': '中国人文社会科学学术集刊 AMI 综合评价',
  rdfy: '复印报刊资料重要转载来源期刊', nssf: '国家社科基金资助期刊' };
// 「2023–2024」 → 「23–24」; 「2020 年版」 → 「2020」
const short = (edition: string): string => (edition.includes('–') ? edition.replace(/20(\d\d)/g, '$1') : edition.replace(/\s*年版$/, ''));

interface Mark { label: string; title: string; old: boolean; kind: string }

export function rankMarks(r: JournalRank | null | undefined): Mark[] {
  if (!r) return [];
  const out: Mark[] = [];
  const latest = (k: RankKind) => r.in.find((x) => x.kind === k && x.current);
  const older = (k: RankKind) => r.in.find((x) => x.kind === k && !x.current);
  const list = (k: RankKind): void => {
    const now = latest(k), was = older(k);
    if (now) out.push({ label: NAME[k], title: `${FULL[k]}（${now.edition}）`, old: false, kind: k });
    else if (was) out.push({ label: `${NAME[k]} ${short(was.edition)}`, title: `${FULL[k]}（${was.edition}）；现行版未收`, old: true, kind: k });
  };
  list('cssci');
  // 扩展版 only says something when it is not in the 来源期刊 list now
  if (!latest('cssci')) list('cssci-ext');
  list('pku');
  list('rdfy');
  list('nssf');
  // AMI by its level: 「A刊权威」; 扩展 muted, as a step below the ranked ones
  for (const k of ['ami', 'ami-jikan'] as const) {
    const a = r.in.find((x) => x.kind === k && x.current);
    if (a) out.push({ label: `${NAME[k]}${a.level ?? ''}`, title: `${FULL[k]}（${a.edition}）：${a.level}`, old: a.level === '扩展', kind: k });
  }
  if (r.school) out.push({ label: `${r.school.short}权威${r.school.level === '权威' ? '' : r.school.level}`, title: r.school.from, old: false, kind: 'school' });
  return out;
}

export function Ranks({ rank, class: extra }: { rank: JournalRank | null | undefined; class?: string }) {
  const marks = rankMarks(rank);
  if (!marks.length) return null;
  return (
    <span class={cx('ranks', extra)}>
      {marks.map((m) => <span key={m.label} class={cx('rank', `rank-${m.kind}`, m.old && 'old')} title={m.title}>{m.label}</span>)}
    </span>
  );
}
