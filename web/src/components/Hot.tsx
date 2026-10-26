// 热点: what friends are marking now (书 / 影视), and 豆瓣's public lists beside it.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Tr } from './Tr.tsx';
import { api, type HotItem, type HotKind, type HotPage, type Translated } from '../api.ts';
import { useDesk } from '../extras.ts';
import { wishNote } from './BookPage.tsx';
import { isWished, noteWished } from '../wishes.ts';
import { notify, addTr, snipTr, prefs } from '../store.ts';
import { Icon } from './Icon.tsx';
import { ago, cx, proxied, toneOf } from '../util.ts';

const KIND_TABS: [HotKind, string][] = [['book', '书'], ['movie', '影']];
const WISH: Record<HotKind, [string, string]> = { book: ['想读', '已想读'], movie: ['想看', '已想看'] };
const PREF_KEY = 'lumen.hotKind';

const subjectUrl = (x: HotItem): string => `https://${x.kind}.douban.com/subject/${x.subject}/`;

// "胡桑、原醉 想读 · 西山农夫 读过"
function whoLine(x: HotItem): string {
  const by = new Map<string, string[]>();
  for (const m of [...x.marks].sort((a, b) => a.published - b.published)) {
    const who = by.get(m.action) ?? [];
    if (!who.includes(m.who)) by.set(m.action, [...who, m.who]);
  }
  return [...by].map(([a, who]) => `${who.slice(0, 3).join('、')}${who.length > 3 ? ` 等 ${who.length} 人` : ''} ${a}`).join(' · ');
}

// tracked: on the author's 想读台 (web/src/extras.ts), which counts as marked.
function Wish({ x, tracked, onDone }: { x: HotItem; tracked: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = x.wished || !!x.mine || tracked || isWished(x.subject);
  const [want, had] = WISH[x.kind];
  const wish = async (): Promise<void> => {
    setBusy(true);
    try { const r = await api.doubanWish(x.kind, x.subject); noteWished(x.subject); onDone(); notify(wishNote(want, r.synced)); } catch (e) { notify((e as Error).message, true); }
    setBusy(false);
  };
  if (done) return <span class="hot-mine">{x.mine ? `我${x.mine}` : had}</span>;
  return <button class="hot-wish" disabled={busy} onClick={() => void wish()}>{busy ? <span class="spinner sm" /> : <Icon name="bookmark" size={12} />}{want}</button>;
}

function Cover({ x }: { x: HotItem }) {
  return x.cover
    ? <img src={proxied(x.cover)} alt="" loading="lazy" referrerpolicy="no-referrer" />
    : <span class="hot-nocover">{x.kind === 'book' ? '书' : '影'}</span>;
}

function FriendCard({ x, rank, tracked, tag, onWish }: { x: HotItem; rank: number; tracked: boolean; tag: ComponentChildren; onWish: () => void }) {
  return (
    <article class={cx('hot-card', rank <= 3 && 'top')}>
      <a class="hot-cover" href={subjectUrl(x)} target="_blank" rel="noopener noreferrer" tabIndex={-1}><Cover x={x} /></a>
      <div class="hot-body">
        <p class="hot-rank"><b>{rank}</b>{x.isNew && <span class="hot-new">新上榜</span>}<span class="hot-people">{x.people} 位友邻</span></p>
        <a class="hot-title" href={subjectUrl(x)} target="_blank" rel="noopener noreferrer"><Tr text={x.title} /></a>
        {x.info && <p class="hot-info">{x.rating === null ? x.info : x.info.replace(/\s*·\s*评分[:：]\s*[\d.]+/, '')}</p>}
        {x.intro && <p class="hot-intro" title={x.intro}>{prefs.value.marksTr !== 'original' ? snipTr.value[x.intro] ?? x.intro : x.intro}</p>}
        <p class="hot-who">{whoLine(x)}</p>
        <footer class="hot-foot">
          {x.rating !== null && <span class="hot-rating">{x.rating.toFixed(1)}</span>}
          {x.lists.map((l) => <span key={l} class={`hot-list-tag ${toneOf(l)}`}>{l}</span>)}
          {tag}
          <span class="grow" />
          <Wish x={x} tracked={tracked} onDone={onWish} />
        </footer>
      </div>
    </article>
  );
}

function ListRow({ x, n, tracked, onWish }: { x: HotItem; n: number; tracked: boolean; onWish: () => void }) {
  return (
    <li class="hot-row">
      <span class="hot-row-n">{n}</span>
      <a class="hot-row-cover" href={subjectUrl(x)} target="_blank" rel="noopener noreferrer" tabIndex={-1}><Cover x={x} /></a>
      <div class="hot-row-body">
        <a class="hot-title" href={subjectUrl(x)} target="_blank" rel="noopener noreferrer" title={x.intro}><Tr text={x.title} /></a>
        <p class="hot-info">{x.rating !== null && <b class="hot-rating">{x.rating.toFixed(1)}</b>}{x.info}</p>
        <p class="hot-tags">
          {x.lists.map((l) => <span key={l} class={`hot-list-tag ${toneOf(l)}`}>{l}</span>)}
          {x.people > 0 && <span class="hot-list-tag friend-tag">友邻也在看 · {x.people}</span>}
        </p>
      </div>
      <Wish x={x} tracked={tracked} onDone={onWish} />
    </li>
  );
}

export function HotView() {
  const [kind, setKind] = useState<HotKind>(() => { try { return localStorage.getItem(PREF_KEY) === 'movie' ? 'movie' : 'book'; } catch { return 'book'; } });
  const [page, setPage] = useState<HotPage | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (p: Promise<HotPage & Translated>): void => {
    setBusy(true);
    p.then((r) => { addTr(r); setPage(r); }).catch((e: Error) => notify(e.message, true)).finally(() => setBusy(false));
  };
  useEffect(() => { load(api.hot()); }, []);
  const desk = useDesk(page ? [...page.book.friends, ...page.book.lists].map((x) => x.subject) : []);
  const pick = (k: HotKind): void => { setKind(k); try { localStorage.setItem(PREF_KEY, k); } catch { /* private mode */ } };
  const wished = (subject: string): void => {
    if (!page) return;
    const mark = (xs: HotItem[]): HotItem[] => xs.map((x) => (x.subject === subject ? { ...x, wished: true } : x));
    setPage({ ...page, [kind]: { friends: mark(page[kind].friends), lists: mark(page[kind].lists) } });
  };
  const side = page?.[kind];
  const tracked = (x: HotItem): boolean => x.kind === 'book' && desk.has(x.subject);
  return (
    <section class="list hot">
      <header class="list-head">
        <div class="list-title"><h2>书影榜</h2>{page?.fetched && <span class="hot-fetched">榜单更新于 {ago(page.fetched)}</span>}</div>
        <div class="list-tools">
          <button class="icon-btn" title="重新拉取豆瓣榜单" disabled={busy} onClick={() => load(api.hotRefresh())}>
            {busy ? <span class="spinner sm" /> : <Icon name="refresh" />}
          </button>
        </div>
      </header>
      <nav class="mark-kinds hot-kinds" aria-label="类型">
        {KIND_TABS.map(([k, label]) => (
          <button key={k} class={cx(kind === k && 'on')} aria-pressed={kind === k} onClick={() => pick(k)}>
            {label}{page && page[k].friends.length > 0 && <small title="友邻榜上的条数">{page[k].friends.length}</small>}
          </button>
        ))}
      </nav>
      <div class="list-scroll">
        {!side ? <div class="sentinel"><span class="spinner" /></div> : (
          <div class="hot-page">
            <section class="hot-friends">
              <h3 class="hot-h">友邻榜<small>近 30 天，至少两位友邻标过，一周前的标记分量减半</small></h3>
              {side.friends.length
                ? <div class="hot-grid">{side.friends.map((x, i) => <FriendCard key={x.subject} x={x} rank={i + 1} tracked={tracked(x)} tag={x.kind === 'book' && <desk.Tag subject={x.subject} />} onWish={() => wished(x.subject)} />)}</div>
                : <p class="editions-note">近 30 天还没有两位以上友邻同时标过的{kind === 'book' ? '书' : '影视'}</p>}
            </section>
            <section class="hot-lists">
              <h3 class="hot-h">豆瓣榜单<small>{kind === 'book' ? '月度热门图书 · 新书速递' : '实时热门 · 一周口碑 · 华语／全球口碑剧集'}</small></h3>
              {side.lists.length
                ? <ol class="hot-rows">{side.lists.map((x, i) => <ListRow key={x.subject} x={x} n={i + 1} tracked={tracked(x)} onWish={() => wished(x.subject)} />)}</ol>
                : <p class="editions-note">榜单还没取到，点右上角刷新</p>}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
