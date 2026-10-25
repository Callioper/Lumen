// 新书's months, each cut into shelves by 主题 (bookkinds.ts), coarse enough that a shelf holds a
// handful of books, not one or two. The 21 主题 spread thin: of a month's 30–120 books most 主题 have
// one to three (counted 2026-10-24). So a 主题 stands as a shelf of its own only when it has a fair
// share of the month; the rest of its field (文学, 社会科学 …) go on the field's shelf together, and
// what is still too few for that on one last shelf, 其余. A month too small to be worth cutting is one shelf.
import { OTHER_TOPIC } from './bookkinds.ts';

// The fields, in the order shelves come: 豆瓣读书's own 文学 / 文化 / 社科 / 科技 headings, 历史 and
// 哲学 apart from 文化 since these 书单 are mostly those.
export const BOOK_FIELDS: readonly { label: string; topics: readonly string[] }[] = [
  { label: '文学', topics: ['小说', '诗歌', '散文随笔', '文学研究'] },
  { label: '历史与传记', topics: ['历史', '传记'] },
  { label: '哲学与宗教', topics: ['哲学', '宗教'] },
  { label: '社会科学', topics: ['社会学', '人类学', '政治', '经济', '心理学', '教育', '女性主义'] },
  { label: '艺术与文化', topics: ['艺术', '电影', '文化研究', '媒介研究'] },
  { label: '科普与其他', topics: ['科普', OTHER_TOPIC] },
];
export const REST_SHELF = '其余';
const MIN_MONTH = 12;           // fewer books than this: the month is not cut
const MIN_OWN = 5;              // a 主题 with this many (or its share below, if more) is a shelf
const OWN_SHARE = 0.08;
const MIN_SHELF = 4;            // no shelf holds fewer
const LARGE_SHARE = 0.2;        // a field's shared shelf with more of the month than this is split
const NAMED_TOPICS = 3;         // a shelf of up to this many 主题 is named by them, more by its field
const UNSORTED = '未归类';

export interface Shelf { label: string; n: number; topics: string[] }

const fieldOf = (topic: string): number => {
  const i = BOOK_FIELDS.findIndex((f) => f.topics.includes(topic));
  return i < 0 ? BOOK_FIELDS.length - 1 : i;
};

// The shelves of one month's books, given each book's 主题 (null: not classified yet), and the shelf
// each book goes on, in the books' order. Field by field: a 主题 with its share stands alone (largest
// first), the field's others share a shelf; too few of those for a shelf join the field's smallest,
// or, in a field with no shelf, go to 其余. A 其余 too small joins the smallest shelf there is: the
// 主题 a shelf lists say what is on it.
interface Group { topics: string[]; n: number; field: number | null }
export function shelvesOf(topics: readonly (string | null)[]): { shelves: Shelf[]; of: string[] } {
  const none = { shelves: [], of: topics.map(() => '') };
  if (topics.length < MIN_MONTH) return none;
  const counts = new Map<string, number>();
  for (const t of topics) counts.set(t ?? UNSORTED, (counts.get(t ?? UNSORTED) ?? 0) + 1);
  const own = Math.max(MIN_OWN, Math.ceil(topics.length * OWN_SHARE));
  const groups: Group[] = [];
  const rest: Group = { topics: [], n: 0, field: null };
  const smallest = (gs: Group[]): Group | undefined => gs.reduce<Group | undefined>((m, g) => (!m || g.n < m.n ? g : m), undefined);
  BOOK_FIELDS.forEach((_, fi) => {
    const here = [...counts].filter(([t]) => t !== UNSORTED && fieldOf(t) === fi).sort((a, b) => b[1] - a[1]);
    const alone = here.filter(([, n]) => n >= own).map(([t, n]): Group => ({ topics: [t], n, field: fi }));
    let left = here.filter(([, n]) => n < own);
    let n = left.reduce((x, [, k]) => x + k, 0);
    // A field's shared shelf grown past its share gives its largest 主题 a shelf each, while they have enough.
    while (n > topics.length * LARGE_SHARE && left.length > 1 && left[0][1] >= MIN_OWN) {
      alone.push({ topics: [left[0][0]], n: left[0][1], field: fi });
      n -= left[0][1];
      left = left.slice(1);
    }
    groups.push(...alone);
    if (!left.length) return;
    const into = n < MIN_SHELF ? smallest(alone) : undefined;
    if (n >= MIN_SHELF) groups.push({ topics: left.map(([t]) => t), n, field: fi });
    else if (into) { into.topics.push(...left.map(([t]) => t)); into.n += n; }
    else { rest.topics.push(...left.map(([t]) => t)); rest.n += n; }
  });
  const unsorted = counts.get(UNSORTED) ?? 0;
  if (unsorted) { rest.topics.push(UNSORTED); rest.n += unsorted; }
  if (rest.n >= MIN_SHELF || !groups.length) groups.push(rest);
  else if (rest.n) { const g = smallest(groups)!; g.topics.push(...rest.topics); g.n += rest.n; }
  // One shelf is no cut.
  if (groups.length < 2) return none;
  const shelfOf = new Map<string, string>();
  const shelves = groups.map((g): Shelf => {
    // Named by its own field's 主题: what joined it from 其余 is listed, not named.
    const named = g.field === null ? [] : g.topics.filter((t) => t !== UNSORTED && fieldOf(t) === g.field);
    const label = g.field === null ? REST_SHELF : named.length <= NAMED_TOPICS ? named.join('·') : BOOK_FIELDS[g.field].label;
    for (const t of g.topics) shelfOf.set(t, label);
    return { label, n: g.n, topics: g.topics };
  });
  return { shelves, of: topics.map((t) => shelfOf.get(t ?? UNSORTED) ?? REST_SHELF) };
}
