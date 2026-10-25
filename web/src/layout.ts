// Display modes. The sidebar tabs are these modes: every feed sits in exactly one tab, the one
// of its effective layout (its own choice, else its category's, else the default for its type),
// and a tab shows its feeds in that mode.
import type { Category, Feed, Layout, View } from './api.ts';

export type Tab = Layout | 'all';

export const LAYOUTS: { key: Layout; label: string; icon: string; hint: string }[] = [
  { key: 'list', label: '列表', icon: 'list', hint: '标题、摘要和小图，适合公众号长文、播客' },
  // Named 时间线, not 动态: 动态 is the sidebar entry for person-centred sources, whatever their layout.
  { key: 'social', label: '时间线', icon: 'social', hint: '以人为主，正文直接显示，适合豆瓣、微博' },
  { key: 'cards', label: '大卡片', icon: 'cards', hint: '大封面配摘要，适合书评、短摘要' },
  { key: 'masonry', label: '瀑布流', icon: 'masonry', hint: '以封面为主，适合视频、新书、影视' },
  { key: 'compact', label: '标题流', icon: 'compact', hint: '一行一条、按天分组，适合期刊目录、只有标题的源' },
  { key: 'digest', label: '简报', icon: 'digest', hint: '一个源一天并成一块，可让 AI 归纳，适合高频新闻源' },
];

export const layoutLabel = (k: Tab): string => (k === 'all' ? '全部' : LAYOUTS.find((l) => l.key === k)?.label ?? k);

// Layouts that need the full width; the reader then opens over the list.
export const WIDE_LAYOUTS: ReadonlySet<Layout> = new Set(['cards', 'masonry']);
// Layouts whose list has the middle and the right to itself until an article is opened beside it:
// the wide ones, and 动态 (a timeline wants more than the narrow list column).
export const OPEN_BESIDE_LAYOUTS: ReadonlySet<Layout> = new Set([...WIDE_LAYOUTS, 'social']);

export type LayoutSelection =
  | { kind: 'all' } | { kind: 'starred' } | { kind: 'marks' } | { kind: 'reports' } | { kind: 'books' } | { kind: 'hot' } | { kind: 'tocs' } | { kind: 'notices' } | { kind: 'social' }
  | { kind: 'feed'; id: number } | { kind: 'category'; id: number } | { kind: 'tag'; name: string };

// Where a layout chosen while looking at this selection is saved. Inside a mode tab the list of
// the whole tab has no choice to make: its layout is the tab.
export type LayoutTarget =
  | { kind: 'feed'; id: number } | { kind: 'category'; id: number } | { kind: 'local'; key: string } | { kind: 'tab' };

export function layoutTarget(sel: LayoutSelection, tab: Tab): LayoutTarget {
  if (sel.kind === 'feed' || sel.kind === 'category') return { kind: sel.kind, id: sel.id };
  if (tab !== 'all') return { kind: 'tab' };
  if (sel.kind === 'social') return { kind: 'local', key: 'social' };
  if (sel.kind === 'tag') return { kind: 'local', key: `tag:${sel.name}` };
  if (sel.kind === 'starred') return { kind: 'local', key: 'starred' };
  return { kind: 'local', key: 'all' };
}

export const typeLayout = (view: View): Layout =>
  view === 'social' ? 'social' : view === 'picture' || view === 'video' ? 'masonry' : 'list';

// A group of feeds of one type gets that type's layout; a mixed group a plain list.
const groupDefault = (views: View[]): Layout => {
  const kinds = new Set(views.map(typeLayout));
  return kinds.size === 1 ? [...kinds][0] : 'list';
};

type FeedLayoutFields = Pick<Feed, 'id' | 'view' | 'category_id' | 'layout'> & Partial<Pick<Feed, 'scroll_read'>>;
type CategoryLayoutFields = Pick<Category, 'id' | 'layout'> & Partial<Pick<Category, 'scroll_read'>>;

export interface LayoutContext {
  feeds: ReadonlyMap<number, FeedLayoutFields>;
  categories: readonly CategoryLayoutFields[];
  local: Readonly<Record<string, Layout>>;
  localScrollRead?: Readonly<Record<string, boolean>>;
}

// Which tab a feed belongs to. Must match EFFECTIVE_LAYOUT_SQL in server/api/queries.ts.
export function effectiveLayout(f: FeedLayoutFields, categories: readonly CategoryLayoutFields[]): Layout {
  return f.layout ?? categories.find((c) => c.id === f.category_id)?.layout ?? typeLayout(f.view);
}

const categoryDefault = (id: number, ctx: LayoutContext): Layout =>
  groupDefault([...ctx.feeds.values()].filter((f) => f.category_id === id).map((f) => f.view));

export function resolveLayout(sel: LayoutSelection, tab: Tab, ctx: LayoutContext): Layout {
  if (sel.kind === 'marks' || sel.kind === 'reports') return 'list';
  if (sel.kind === 'books' || sel.kind === 'hot') return 'masonry';
  // The contents take the width the reader would have, until a post is opened over them.
  if (sel.kind === 'tocs' || sel.kind === 'notices') return 'cards';
  if (sel.kind === 'social') return ctx.local.social ?? 'social';
  if (sel.kind === 'feed') {
    const f = ctx.feeds.get(sel.id);
    return f ? effectiveLayout(f, ctx.categories) : 'list';
  }
  if (tab !== 'all') return tab;
  if (sel.kind === 'category') return ctx.categories.find((c) => c.id === sel.id)?.layout ?? categoryDefault(sel.id, ctx);
  const t = layoutTarget(sel, tab);
  return (t.kind === 'local' && ctx.local[t.key]) || 'list';
}

// The layout something would fall back to if its own choice were cleared.
export function inheritedLayout(sel: LayoutSelection, _tab: Tab, ctx: LayoutContext): Layout {
  if (sel.kind === 'feed') {
    const f = ctx.feeds.get(sel.id);
    return f ? effectiveLayout({ ...f, layout: null }, ctx.categories) : 'list';
  }
  if (sel.kind === 'category') return categoryDefault(sel.id, ctx);
  return sel.kind === 'social' ? 'social' : 'list';
}

// 滚过即读 follows the feed, then its category, then this browser; off by default.
export function resolveScrollRead(sel: LayoutSelection, tab: Tab, ctx: LayoutContext): boolean {
  const cat = (id: number | null): number | null | undefined => ctx.categories.find((c) => c.id === id)?.scroll_read;
  if (sel.kind === 'marks') return false;
  if (sel.kind === 'feed') {
    const f = ctx.feeds.get(sel.id);
    return !!(f?.scroll_read ?? cat(f?.category_id ?? null) ?? 0);
  }
  if (sel.kind === 'category') return !!cat(sel.id);
  return !!ctx.localScrollRead?.[scrollReadKey(sel, tab)];
}

export function scrollReadKey(sel: LayoutSelection, tab: Tab): string {
  if (sel.kind === 'tag') return `tag:${sel.name}`;
  if (sel.kind === 'starred') return 'starred';
  if (sel.kind === 'social') return 'tab:social';     // what 滚过即读 was set to when 动态 was a tab
  return `tab:${tab}`;
}

export interface DayGroup<T> { key: string; label: string; items: T[] }

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// Consecutive entries published on the same local day share a group. Lists are ordered by
// publication, so for a journal (every article dated by its issue) a group is one issue.
export function groupByDay<T extends { published: number }>(items: readonly T[], now = Date.now()): DayGroup<T>[] {
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const groups: DayGroup<T>[] = [];
  for (const it of items) {
    const d = new Date(it.published * 1000);
    const key = dayKey(d);
    const last = groups[groups.length - 1];
    if (last?.key === key) { last.items.push(it); continue; }
    const label = key === dayKey(today) ? '今天' : key === dayKey(yesterday) ? '昨天'
      : `${d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
    groups.push({ key, label, items: [it] });
  }
  return groups;
}

// The order entries appear on screen, which j/k follow. Only 每日简报 regroups the list:
// within a day it puts each feed's entries together.
export function displayOrder<T extends { published: number; feed_id: number }>(items: readonly T[], layout: Layout, oneFeed: boolean, now = Date.now()): readonly T[] {
  return layout === 'digest' ? groupDigest(items, oneFeed, now).flatMap((b) => b.items) : items;
}

export interface DigestBlock<T> { key: string; day: string; feedId: number | null; items: T[] }

// 每日简报: within each day, one block per feed in order of first appearance. Inside a single
// feed's list a day is one block.
export function groupDigest<T extends { published: number; feed_id: number }>(items: readonly T[], oneFeed: boolean, now = Date.now()): DigestBlock<T>[] {
  return groupByDay(items, now).flatMap((day) => {
    if (oneFeed) return [{ key: day.key, day: day.label, feedId: day.items[0]?.feed_id ?? null, items: day.items }];
    const byFeed = new Map<number, T[]>();
    for (const it of day.items) byFeed.set(it.feed_id, [...(byFeed.get(it.feed_id) ?? []), it]);
    return [...byFeed].map(([feedId, list]) => ({ key: `${day.key}/${feedId}`, day: day.label, feedId, items: list }));
  });
}
