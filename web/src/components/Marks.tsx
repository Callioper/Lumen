import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { select, marksHome, markGroups, visibleMarks, markKindOf, selectedMark, subjectTrail, boardOpen, marksBack, openMark, loading, prefs, setPrefs, reloadList, markAllRead, markAboveRead, type MarkKind } from '../store.ts';
import { api, type Mark, type MarkGroup } from '../api.ts';
import { useDesk, LoginNotice } from '../extras.ts';
import { useSubject } from './Editions.tsx';
import { BookPage, WishButton, bookLines, statLine } from './BookPage.tsx';
import { MoviePage, useMovie, movieLines, movieStat } from './MoviePage.tsx';
import { Tr, TrSwitch } from './Tr.tsx';
import { Icon } from './Icon.tsx';
import { ago, proxied, cx, safeLink, fullDate } from '../util.ts';

const KIND: Record<MarkGroup['kind'], string> = { book: '书', movie: '影', music: '音', game: '游戏', other: '其他' };
const MARK_KINDS: [MarkKind, string][] = [['book', '书'], ['movie', '影'], ['music', '音'], ['other', '其他'], ['all', '全部']];

// "胡桑、藤原琉璃君 想读 · 原醉 读过"
export function actionLine(g: Pick<MarkGroup, 'marks'>): string {
  const byAction = new Map<string, string[]>();
  for (const m of g.marks) {
    const who = byAction.get(m.action) ?? [];
    if (!who.includes(m.who)) byAction.set(m.action, [...who, m.who]);
  }
  return [...byAction].map(([a, who]) => `${who.slice(0, 3).join('、')}${who.length > 3 ? ` 等 ${who.length} 人` : ''} ${a}`).join(' · ');
}

function Card({ g }: { g: MarkGroup }) {
  return (
    <article class={cx('row mark-row', g.key === selectedMark.value && 'selected', g.unread ? 'unread' : 'read')}
      onClick={() => void openMark(g.key)} data-key={g.key}>
      <div class="row-meta">
        <span class="mark-kind">{KIND[g.kind]}</span>
        <span class="row-feed">{g.people} 人标记</span>
        <span class="row-time">{ago(g.latest)}</span>
      </div>
      <div class="row-body">
        <div class="row-text">
          <h3 class="row-title"><Tr text={g.title} /></h3>
          <p class="row-snippet">{actionLine(g)}</p>
        </div>
        {g.cover && <img class="row-thumb mark-cover" src={proxied(g.cover)} alt="" loading="lazy" width={52} height={72}
          onError={(e) => { (e.currentTarget as HTMLImageElement).remove(); }} />}
      </div>
    </article>
  );
}

export function MarksList() {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.querySelector(`[data-key="${CSS.escape(selectedMark.value ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedMark.value]);
  const list = visibleMarks.value;
  const unreadOnly = prefs.value.marksUnreadOnly;
  const kind = prefs.value.markKind;
  const unreadOf = (k: MarkKind): number => markGroups.value.reduce((s, g) => s + (k === 'all' || markKindOf(g) === k ? g.unread : 0), 0);
  return (
    <section class="list">
      <header class="list-head">
        <div class="list-title"><h2><button class="title-home" title="回标记主页 (h)" onClick={marksHome}>标记</button></h2></div>
        <div class="list-tools">
          <div class="seg" role="group" aria-label="筛选">
            <button class={cx(unreadOnly && 'on')} onClick={() => { setPrefs({ marksUnreadOnly: true }); void reloadList(); }}>未读</button>
            <button class={cx(!unreadOnly && 'on')} onClick={() => { setPrefs({ marksUnreadOnly: false }); void reloadList(); }}>近 30 天</button>
          </div>
          <TrSwitch />
          <button class="icon-btn" title="标记全部标为已读 (Shift+A)" onClick={() => void markAllRead()} disabled={!list.some((g) => g.unread)}>
            <Icon name="checks" />
          </button>
        </div>
      </header>
      <nav class="mark-kinds" aria-label="类型">
        {MARK_KINDS.map(([k, label]) => (
          <button key={k} class={cx(kind === k && 'on')} onClick={() => setPrefs({ markKind: k })}>
            {label}{unreadOf(k) > 0 && <small>{unreadOf(k)}</small>}
          </button>
        ))}
      </nav>
      <div class="list-scroll" ref={scroller}>
        {list.map((g) => <Card key={g.key} g={g} />)}
        {!loading.value && list.length === 0 && (
          <div class="empty"><Icon name="checks" size={28} /><p>{unreadOnly ? '没有未读的标记' : '近 30 天没有标记'}</p></div>
        )}
        <div class="sentinel">{loading.value ? <span class="spinner" /> : list.length > 0 ? <span class="end">— 到底了 —</span> : null}</div>
      </div>
    </section>
  );
}

// "想读 4 · 读过 1": how the people split, most first.
const actionCounts = (g: MarkGroup): [string, number][] => {
  const n = new Map<string, Set<string>>();
  for (const m of g.marks) n.set(m.action, (n.get(m.action) ?? new Set()).add(m.who));
  return [...n].map(([a, who]): [string, number] => [a, who.size]).sort((a, b) => b[1] - a[1]);
};

// The 书影音 board, what the right pane shows before a card is opened: the last 30 days of the
// segment chosen on the left — what friends are in the middle of, and what many want. A click
// unfolds a card under its row; a double click or Enter opens it, and Esc comes back here.
const NOW_ACTIONS = new Set(['在读', '在看', '在听', '在玩']);
const WANT_ACTIONS = new Set(['想读', '想看', '想听', '想玩']);
const whoDid = (g: MarkGroup, acts: Set<string>): string[] => [...new Set(g.marks.filter((m) => acts.has(m.action)).map((m) => m.who))];
const latestSaid = (g: MarkGroup): Mark | undefined => g.marks.filter((m) => m.comment).sort((a, b) => b.published - a.published)[0];

// Kept while a card is open, so that coming back lands where the board was left: its groups, how
// far down it was and the card last opened (the unfolded one is boardOpen in the store).
const board: { all: MarkGroup[] | null; scroll: number; last: string | null } = { all: null, scroll: 0, last: null };

function markWished(key: string): void {
  markGroups.value = markGroups.value.map((x) => (x.key === key ? { ...x, wished: true } : x));
  board.all = board.all?.map((x) => (x.key === key ? { ...x, wished: true } : x)) ?? null;
}

async function openFull(g: MarkGroup): Promise<void> {
  board.last = g.key;
  if (prefs.value.marksUnreadOnly) { setPrefs({ marksUnreadOnly: false }); await reloadList(); }
  void openMark(g.key);
}

interface BoardRow { g: MarkGroup; who: string[]; note: string }

function OverviewCard({ row, open, onToggle }: { row: BoardRow; open: boolean; onToggle: () => void }) {
  const { g, who, note } = row;
  const said = latestSaid(g);
  return (
    <button class={cx('ov-card', open && 'open', board.last === g.key && 'last')} data-key={g.key} aria-expanded={open}
      onClick={onToggle} onDblClick={() => void openFull(g)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void openFull(g); } }}>
      {g.cover ? <img src={proxied(g.cover)} alt="" loading="lazy" /> : <span class="ov-nocover">{KIND[g.kind]}</span>}
      <span class="ov-text">
        <span class="ov-title"><Tr text={g.title} /></span>
        {g.info && <span class="ov-info">{g.info}</span>}
        <span class="ov-who">{who.slice(0, 2).join('、')}{who.length > 2 ? ` 等 ${who.length} 人` : ''} {note}</span>
        {said && <span class="ov-said">{said.who}：<Tr text={said.comment} /></span>}
      </span>
    </button>
  );
}

const PANEL_SAID = 3;
const PANEL_INTRO = 3;

// The unfolded card: a few lines of the book and what friends said, with the way into the full page.
function BoardPanel({ g }: { g: MarkGroup }) {
  const isBook = g.kind === 'book' && !!g.subject;
  const isMovie = g.kind === 'movie' && !!g.subject;
  const { state } = useSubject(isBook ? g.subject : null);
  const film = useMovie(isMovie ? g.subject : null).state;
  const p = state?.data?.page ?? null;
  const m = film?.page ?? null;
  const lines = p ? bookLines(p) : null;
  const filmLines = m ? movieLines(m) : null;
  const intro = p?.intro ?? m?.intro ?? [];
  const asking = (isBook && !p) || (isMovie && !m);
  const askError = state?.error ?? film?.error;
  const said = g.marks.filter((m) => m.comment).slice(0, PANEL_SAID);
  const url = safeLink(g.url);
  const wishKind = g.kind === 'book' || g.kind === 'movie' ? g.kind : null;
  const desk = useDesk(isBook && g.subject ? [g.subject] : []);
  const onDesk = isBook && !!g.subject && desk.has(g.subject);
  return (
    <div class="ov-panel" role="region" aria-label={g.title}>
      {g.cover ? <img class="ov-panel-cover" src={proxied(g.cover)} alt="" /> : <div class="ov-panel-cover blank" aria-hidden="true">{KIND[g.kind]}</div>}
      <div class="ov-panel-body">
        <h3>{url ? <a href={url} target="_blank" rel="noopener noreferrer"><Tr text={g.title} /></a> : <Tr text={g.title} />}</h3>
        <p class="bp-line">{lines ? [lines.by, lines.pub].filter(Boolean).join(' · ') : filmLines ? [filmLines.by, filmLines.facts].filter(Boolean).join(' · ') : g.info}</p>
        {p && <p class="bp-stat">{statLine(p)}</p>}
        {m && <p class="bp-stat">{movieStat(m)}</p>}
        <p class="ov-acts">{actionLine(g)}</p>
        {asking ? <p class="editions-note">{askError ?? <><span class="spinner sm" /> 正在查豆瓣…</>}</p>
          : intro.length > 0 && <div class="ov-intro">{intro.slice(0, PANEL_INTRO).map((l, i) => <p key={i}>{l}</p>)}</div>}
        {said.length > 0 && (
          <ul class="ov-panel-said">
            {said.map((m) => <li key={m.id}><strong>{m.who}</strong><span class="mark-act">{m.action}</span><Tr text={m.comment} block /></li>)}
          </ul>
        )}
        <div class="bp-actions">
          {wishKind && g.subject && <WishButton kind={wishKind} subject={g.subject} done={g.wished || onDesk || !!state?.data?.wished || !!film?.wished} onDone={() => markWished(g.key)} />}
          {url && <a class="btn" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />打开豆瓣<kbd>空格</kbd></a>}
          <button class="btn" onClick={() => void openFull(g)}>查看全部<kbd>↵</kbd></button>
          <span class="grow" />
          <button class="icon-btn" title="收起 (Esc)" onClick={() => { boardOpen.value = null; }}><Icon name="x" /></button>
        </div>
      </div>
    </div>
  );
}

// The panel goes in after the last card of the unfolded card's row, across the whole grid.
function BoardGrid({ sec, rows }: { sec: string; rows: BoardRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setCols(getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length || 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const open = boardOpen.value?.sec === sec ? boardOpen.value.key : null;
  const at = rows.findIndex((r) => r.g.key === open);
  const after = at < 0 ? -1 : Math.min(rows.length - 1, Math.floor(at / cols) * cols + cols - 1);
  return (
    <div class="ov-grid" ref={ref}>
      {rows.map((r, i) => (
        <Fragment key={r.g.key}>
          <OverviewCard row={r} open={r.g.key === open}
            onToggle={() => { boardOpen.value = r.g.key === open ? null : { key: r.g.key, sec, url: r.g.url }; }} />
          {i === after && <BoardPanel key={`panel-${open}`} g={rows[at].g} />}
        </Fragment>
      ))}
    </div>
  );
}

function MarksOverview() {
  const [all, setAll] = useState<MarkGroup[] | null>(board.all);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { api.marks('all').then((r) => { board.all = r.groups; setAll(r.groups); }).catch(() => setAll((a) => a ?? [])); }, []);
  // Back from a card: as far down as the board was, with the card that was opened in focus.
  const restored = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!all || restored.current || !el) return;
    restored.current = true;
    el.scrollTop = board.scroll;
    if (board.last) el.querySelector<HTMLElement>(`.ov-card[data-key="${CSS.escape(board.last)}"]`)?.focus({ preventScroll: true });
  }, [all]);
  const kind = prefs.value.markKind;
  const groups = (all ?? []).filter((x) => kind === 'all' || markKindOf(x) === kind);
  const row = (acts: Set<string>) => (x: MarkGroup): BoardRow => ({ g: x, who: whoDid(x, acts), note: x.marks.find((m) => acts.has(m.action))?.action ?? '' });
  const now = groups.map(row(NOW_ACTIONS)).filter((x) => x.who.length).sort((a, b) => b.who.length - a.who.length || b.g.latest - a.g.latest).slice(0, 6);
  const want = groups.map(row(WANT_ACTIONS)).filter((x) => x.who.length >= 2).sort((a, b) => b.who.length - a.who.length).slice(0, 6);
  const people = new Set(groups.flatMap((x) => x.marks.map((m) => m.who))).size;
  const label = MARK_KINDS.find(([k]) => k === kind)?.[1] ?? '';
  return (
    <main class="reader">
      <div class="reader-scroll" ref={scroller} onScroll={(e) => { board.scroll = e.currentTarget.scrollTop; }}>
        <div class="overview">
          <header class="ov-head">
            <h1>近 30 天 · {label === '全部' ? '书影音' : label}</h1>
            <dl class="dossier-stats">
              <div><dt>条目</dt><dd>{all ? groups.length : '…'}</dd></div>
              <div><dt>标记</dt><dd>{all ? groups.reduce((n, x) => n + x.marks.length, 0) : '…'}</dd></div>
              <div><dt>友邻</dt><dd>{all ? people : '…'}<small>人</small></dd></div>
            </dl>
          </header>
          <LoginNotice />
          {now.length > 0 && <section><h2 class="dossier-h">正在{kind === 'movie' ? '看' : kind === 'music' ? '听' : kind === 'book' ? '读' : '读 · 看'}</h2>
            <BoardGrid sec="now" rows={now} /></section>}
          {want.length > 0 && <section><h2 class="dossier-h">好几个人想{kind === 'movie' ? '看' : kind === 'music' ? '听' : '要'}
              {(kind === 'book' || kind === 'movie') && <button class="link to-hot" onClick={() => void select({ kind: 'hot' })} title="按热度排好的完整榜单，带豆瓣公共榜">看书影榜 →</button>}</h2>
            <BoardGrid sec="want" rows={want} /></section>}
          {all && !now.length && !want.length && <p class="editions-note">这一类近 30 天没什么动静</p>}
          <p class="hint ov-hint">单击卡片展开 · 双击或 <kbd>↵</kbd> 进详情 · <kbd>Esc</kbd> 收起 / 返回上一层 · <kbd>h</kbd> 回主页 · <kbd>空格</kbd> 打开豆瓣条目 · <kbd>j</kbd> <kbd>k</kbd> 上下张 · <kbd>Shift</kbd>+<kbd>K</kbd> 以上标为已读 · <kbd>Shift</kbd>+<kbd>A</kbd> 全部标记已读</p>
        </div>
      </div>
    </main>
  );
}

function FriendMarks({ g }: { g: MarkGroup }) {
  return (
    <section class="bp-sec">
      <h2 class="dossier-h">友邻怎么说<span>{g.marks.length} 条</span></h2>
      <ul class="mark-list">
        {g.marks.map((m) => {
          const link = safeLink(m.link);
          return (
            <li key={m.id} class={cx(!m.comment && 'bare')}>
              <p class="mark-who">
                <strong>{m.who}</strong><span class="mark-act">{m.action}</span>
                {link ? <a class="mark-time" href={link} target="_blank" rel="noopener noreferrer" title={fullDate(m.published)}>{ago(m.published)}</a>
                  : <span class="mark-time">{ago(m.published)}</span>}
              </p>
              {m.comment && <p class="mark-comment"><Tr text={m.comment} block /></p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MarkDetail() {
  const g = markGroups.value.find((x) => x.key === selectedMark.value);
  const bookSubject = g?.kind === 'book' ? g.subject : null;
  const desk = useDesk(bookSubject ? [bookSubject] : []);
  if (!g) return <MarksOverview />;
  const url = safeLink(g.url);
  const sub = subjectTrail.value.at(-1);
  const deskHas = !!bookSubject && desk.has(bookSubject);
  return (
    <main class="reader">
      <header class="reader-bar">
        <button class="btn back-btn" title="Esc / Backspace" onClick={() => marksBack()}>
          <Icon name="chevron" size={14} class="flip" />{sub ? (subjectTrail.value.length > 1 ? (sub.kind === 'movie' ? '返回上一部' : '返回上一本') : `返回《${g.title}》`) : '返回主页'}
        </button>
        {sub && <button class="btn back-btn" title="回标记主页 (h)" onClick={marksHome}><Icon name="cards" size={14} />主页</button>}
        <button class="crumb crumb-home" title="回标记主页 (h)" onClick={marksHome}><Icon name="bookmark" size={16} /><span>标记 · {KIND[g.kind]}</span></button>
        <span class="grow" />
        <button class="icon-btn" title="把这张卡上面的都标为已读 (Shift+K)，5 秒内可撤销" onClick={() => void markAboveRead()}><Icon name="readAbove" /></button>
        {url && !sub && <a class="icon-btn" href={url} target="_blank" rel="noopener noreferrer" title="打开豆瓣条目 (空格)"><Icon name="external" /></a>}
      </header>
      <div class="reader-scroll" key={sub ? `${sub.kind}:${sub.subject}` : g.key}>
        {sub ? (sub.kind === 'book' ? <BookPage key={sub.subject} subject={sub.subject} /> : <MoviePage key={sub.subject} subject={sub.subject} />)
          : g.kind === 'book' && g.subject ? (
            <BookPage key={g.subject} subject={g.subject} cover={g.cover} title={g.title} info={g.info}
              wished={g.wished || deskHas} onWished={() => markWished(g.key)}
              aside={<desk.Line subject={g.subject} />} friends={<FriendMarks g={g} />} />
          ) : g.kind === 'movie' && g.subject ? (
            <MoviePage key={g.subject} subject={g.subject} cover={g.cover} title={g.title} info={g.info}
              wished={g.wished} onWished={() => markWished(g.key)} friends={<FriendMarks g={g} />} />
          ) : (
            <div class="dossier">
              <aside class="dossier-side">
                {g.cover
                  ? <img class="dossier-cover" src={proxied(g.cover)} alt="" />
                  : <div class="dossier-cover blank" aria-hidden="true">{KIND[g.kind]}</div>}
                <h1 class="dossier-title">{url ? <a href={url} target="_blank" rel="noopener noreferrer"><Tr text={g.title} block /></a> : <Tr text={g.title} block />}</h1>
                {g.info && <p class="dossier-info">{g.info}</p>}
                <dl class="dossier-stats">
                  <div><dt>标记</dt><dd>{g.people}<small>人</small></dd></div>
                  {actionCounts(g).slice(0, 3).map(([a, n]) => <div key={a}><dt>{a}</dt><dd>{n}</dd></div>)}
                </dl>
                <div class="dossier-actions">
                  {(g.kind === 'book' || g.kind === 'movie') && g.subject && <WishButton kind={g.kind} subject={g.subject} done={g.wished} onDone={() => markWished(g.key)} />}
                  {url && <a class="btn" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />豆瓣</a>}
                </div>
              </aside>
              <div class="dossier-main"><FriendMarks g={g} /></div>
            </div>
          )}
      </div>
    </main>
  );
}