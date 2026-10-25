// 期刊目录 and 学术动态: what the AI read out of the academic accounts' posts — each issue's table of
// contents, and the conferences, calls and talks still to come (server/content/tocs.ts, notices.ts).
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Count, type Notice, type NoticesPage, type PostRef, type TocArticle, type TocIssue, type TocSource } from '../api.ts';
import { open, notify, detail, prefs } from '../store.ts';
import { FeedIcon } from './Icon.tsx';
import { NeedsAi } from './NeedsAi.tsx';
import { daysUntil } from '../due.ts';
import { cx, safeLink, toneOf } from '../util.ts';

const READING_POLL_MS = 20_000;
const ARTICLES_FOLDED = 8;
const SOON_DAYS = 7;

async function openPost(p: PostRef, scope: string): Promise<void> {
  try {
    await open(await api.entry(p.id), { listScope: scope, sortMode: 'latest', position: 0 });
  } catch (e) {
    notify((e as Error).message, true);
  }
}

const postDate = (sec: number): string => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function FromPost({ post, scope, extra }: { post: PostRef; scope: string; extra?: string }) {
  return (
    <button class={cx('journal-from', detail.value?.id === post.id && 'on')} onClick={() => void openPost(post, scope)} title={`${post.feed} · ${post.title}`}>
      <FeedIcon id={post.feedId} title={post.feed} size={12} /><span>{post.feed}</span><time>{postDate(post.published)}</time>
      {extra && <em>{extra}</em>}
    </button>
  );
}

function Chips({ list, value, onPick, label, note }: { list: Count[]; value: string; onPick: (v: string) => void; label: string; note?: string }) {
  if (!list.length && !note) return null;
  return (
    <nav class="book-topics" aria-label={label}>
      <button class={cx('chip', !value && 'active')} aria-pressed={!value} onClick={() => onPick('')}>全部</button>
      {list.map((t) => (
        <button key={t.label} class={cx('chip', value === t.label && 'active')} aria-pressed={value === t.label}
          onClick={() => onPick(value === t.label ? '' : t.label)}>{t.label}<small>{t.n}</small></button>
      ))}
      {note && <span class="muted book-topics-note">{note}</span>}
    </nav>
  );
}

const GROUP_ORDER = ['综合·学报', '文学', '外国文学', '外语', '哲学', '社会·青年', '其他'];

// 期刊目录's journals, a row for each kind (server tocs.ts journalGroup): the kind's name picks the
// whole row, a journal itself. Rows go in GROUP_ORDER, and the journals in a row by issues.
function JournalRows({ list, journal, group, onPick }: { list: Count[]; journal: string; group: string; onPick: (v: { journal: string; group: string }) => void }) {
  const rows = GROUP_ORDER.map((g) => ({ g, items: list.filter((x) => (x.group ?? '其他') === g) })).filter((r) => r.items.length);
  const all = !journal && !group;
  return (
    <nav class="toc-groups" aria-label="按刊名">
      <div class="toc-group">
        <button class={cx('toc-group-name', all && 'on')} aria-pressed={all} onClick={() => onPick({ journal: '', group: '' })}>全部</button>
        <span class="muted small">{list.length} 种刊 · 点类别看这一类，点刊名看一种</span>
      </div>
      {rows.map(({ g, items }) => (
        <div key={g} class={cx('toc-group', group === g && 'picked')}>
          <button class={cx('toc-group-name', group === g && !journal && 'on')} aria-pressed={group === g && !journal}
            onClick={() => onPick({ journal: '', group: group === g && !journal ? '' : g })}>{g}<small>{items.reduce((n, x) => n + x.n, 0)}</small></button>
          <div class="toc-group-chips">
            {items.map((t) => (
              <button key={t.label} class={cx('chip', journal === t.label && 'active')} aria-pressed={journal === t.label}
                onClick={() => onPick({ journal: journal === t.label ? '' : t.label, group: '' })}>{t.label}<small>{t.n}</small></button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

// While posts are still being read (or the reading waits out an outage), the page asks again now and
// then, with what it shows now: a count that stays the same between asks must not stop the asking.
export function usePoll(active: boolean, again: () => void): void {
  const latest = useRef(again);
  latest.current = again;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => latest.current(), READING_POLL_MS);
    return () => clearInterval(t);
  }, [active]);
}

const readingNote = (p: { reading: number; stalled: boolean } | null): string | undefined =>
  p?.stalled ? 'AI 服务出错，读推文暂停，10 分钟后再试' : p?.reading ? `还有 ${p.reading} 篇推文在读` : undefined;

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
const onCnki = (link?: string): boolean => !!link && /kcms2?\//.test(link);

function Article({ a }: { a: TocArticle }) {
  const [shown, setShown] = useState(false);
  const link = safeLink(a.link);
  const people = [a.authors.join('　'), a.translators.length ? `${a.translators.join('　')} 译` : ''].filter(Boolean).join(' · ');
  const title = <>{a.title}{a.subtitle && <span class="toc-subtitle">——{a.subtitle}</span>}</>;
  return (
    <li class="toc-article">
      <div class="toc-line">
        {link
          ? <a class="toc-title" href={link} {...external} title={onCnki(link) ? '在知网打开' : '在知网按篇名检索'}>{title}</a>
          : <span class="toc-title">{title}</span>}
        {a.reprint && <span class="toc-reprint" title={`${a.reprint}全文转载`}>人大复印</span>}
        {a.page && <span class="toc-page">{a.page}</span>}
      </div>
      <div class="toc-meta">
        {people && <span class="toc-authors">{people}</span>}
        {a.reprintOf && <span class="toc-reprint-of">原载{a.reprintOf}</span>}
        {a.abstract && <button class={cx('linkish toc-abstract-toggle', shown && 'on')} aria-expanded={shown} onClick={() => setShown(!shown)}>{a.lead ? '开头' : '摘要'}</button>}
        {link && <a class="toc-cnki" href={link} {...external}>{onCnki(link) ? '知网' : '知网检索'}</a>}
      </div>
      {shown && (
        <div class="toc-abstract">
          <p>{a.abstract}</p>
          {a.abstractFrom === 'cnki' && <p class="toc-abstract-from">摘要取自知网 RSS，推文里没印</p>}
          {a.keywords.length > 0 && <p class="toc-keywords">{a.keywords.map((k) => <span key={k}>{k}</span>)}</p>}
        </div>
      )}
    </li>
  );
}

function Issue({ t }: { t: TocIssue }) {
  const [all, setAll] = useState(false);
  let left = all ? Infinity : ARTICLES_FOLDED;
  const sections = t.sections.map((s) => {
    const articles = s.articles.slice(0, Math.max(0, left));
    left -= articles.length;
    return { ...s, articles };
  }).filter((s) => s.articles.length);
  const link = safeLink(t.link);
  const onJournalPage = !!link?.includes('/knavi/journals/');
  return (
    <article class={cx('toc-issue', t.source !== 'post' && `from-${t.source}`)}>
      <header class="toc-head">
        <h3>
          <span class="toc-journal">{t.journal}</span>
          <span class="toc-number" title={t.inferred ? '知网 RSS 不写期号，按出刊间隔推算' : undefined}>{t.issue}{t.inferred && <small>推算</small>}</span>
        </h3>
        {link && <a class="btn small toc-issue-cnki" href={link} {...external} title={onJournalPage ? '知网刊物页，刊期浏览里选这一期' : '在知网按刊名检索'}>
          {onJournalPage ? '知网刊物页' : '知网检索本刊'}
        </a>}
      </header>
      <div class="toc-source">
        {t.post ? <FromPost post={t.post} scope="tocs" extra={`${t.articles} 篇`} />
          : <span class="journal-from static"><FeedIcon id={t.feed!.id} title={t.feed!.title} size={12} /><span>知网 RSS</span><time>{postDate(t.at)} 刊出</time><em>{t.articles} 篇{t.partial ? '（可能不全）' : ''}</em></span>}
      </div>
      {sections.map((s, i) => (
        <section key={i} class="toc-section">
          {s.name && <h4>{s.name}</h4>}
          <ol>{s.articles.map((a, j) => <Article key={j} a={a} />)}</ol>
        </section>
      ))}
      {t.articles > ARTICLES_FOLDED && <button class="linkish toc-more" onClick={() => setAll(!all)}>{all ? '收起' : `展开全部 ${t.articles} 篇`}</button>}
    </article>
  );
}

const SOURCES: { key: TocSource; label: string }[] = [{ key: '', label: '全部' }, { key: 'post', label: '公众号' }, { key: 'cnki', label: '知网' }, { key: 'reprint', label: '人大复印' }];

// 期刊目录: every issue once, from the accounts' posts and the CNKI feeds, newest first; perhaps of
// one source or one journal. It has the width to itself: the contents are what the page is for.
export function TocsView() {
  const [journal, setJournal] = useState('');
  const [group, setGroup] = useState('');
  const [source, setSource] = useState<TocSource>('');
  const [issues, setIssues] = useState<TocIssue[]>([]);
  const [page, setPage] = useState<{ total: number; journals: Count[]; sources: Count[]; reading: number; stalled: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(0);
  const load = async (offset: number, quiet = false): Promise<void> => {
    const n = ++asked.current;
    if (!quiet) setLoading(true);
    try {
      const r = await api.tocs({ offset, journal, group, source, reprintsAll: prefs.value.reprintsAll });
      if (n !== asked.current) return;
      // A quiet ask refreshes the first page and leaves the pages loaded after it alone.
      setIssues((old) => (quiet ? [...r.issues, ...old.slice(r.issues.length)] : [...old.slice(0, offset), ...r.issues]));
      setPage({ total: r.total, journals: r.journals, sources: r.sources, reading: r.reading, stalled: r.stalled });
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      if (n === asked.current) setLoading(false);
    }
  };
  useEffect(() => { setIssues([]); setPage(null); void load(0); }, [journal, group, source]);
  usePoll(!!(page?.reading || page?.stalled), () => void load(0, true));
  const reading = readingNote(page);
  const count = (k: TocSource): number | undefined => (k ? page?.sources.find((x) => x.label === SOURCES.find((s) => s.key === k)!.label)?.n : undefined);
  const pickSource = (k: TocSource): void => { setJournal(''); setGroup(''); setSource(k); };
  return (
    <section class="list journals-page tocs-page">
      <div class="list-scroll journals-scroll">
        <div class="tocs-column">
          <header class="tocs-head">
            <h2>期刊目录</h2>
            {page && <span class="muted">{page.total} 期 · {page.journals.length} 种刊</span>}
            <span class="grow" />
            <div class="seg" role="group" aria-label="来源">
              {SOURCES.map((x) => (
                <button key={x.key} class={cx(source === x.key && 'on')} aria-pressed={source === x.key} onClick={() => pickSource(x.key)}>
                  {x.label}{count(x.key) !== undefined && <small>{count(x.key)}</small>}
                </button>
              ))}
            </div>
          </header>
          <JournalRows list={page?.journals ?? []} journal={journal} group={group} onPick={(v) => { setJournal(v.journal); setGroup(v.group); }} />
          {reading && <p class="muted small toc-reading">{reading}</p>}
          {page?.total === 0 && <p class="muted empty">{page.reading ? '正在从推文里读目录…' : '还没有期刊目录。'}</p>}
          {page?.total === 0 && <NeedsAi what="知网 RSS 的目录不用 AI；从公众号推文里读目录，" />}
          {issues.map((t) => <Issue key={t.key} t={t} />)}
          {page && issues.length < page.total && (
            <button class="btn small journals-more" disabled={loading} onClick={() => void load(issues.length)}>{loading ? '加载中…' : '更多'}</button>
          )}
          {loading && !issues.length && <span class="spinner sm" />}
        </div>
      </div>
    </section>
  );
}

const today = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const md = (ymd: string): string => `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;

// An email, a link, or the words around them, each as what it is.
const CONTACT_PART = /(https?:\/\/[^\s；;，,）)。、]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
const isLink = (p: string): boolean => /^https?:\/\//.test(p);
export function Contact({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(CONTACT_PART);
  return (
    <p class="notice-contact">
      {parts.map((p, i) => (i % 2 === 0 ? p
        : !isLink(p) ? <a key={i} href={`mailto:${p}`}>{p}</a>
          : <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p.length > 48 ? `${p.slice(0, 46)}…` : p}</a>))}
    </p>
  );
}

function When({ n }: { n: Notice }) {
  if (!n.next) {
    const d = n.deadline || n.date;
    return <div class="notice-when quiet">{d ? <><b>{md(d)}</b><small>已过</small></> : <><b>常设</b><small>不限期</small></>}</div>;
  }
  if (n.next.what === '进行中') return <div class="notice-when on"><small>进行中</small><b>{md(n.next.date)}</b><small>结束</small></div>;
  const left = daysUntil(n.next.date);
  return (
    <div class={cx('notice-when', left <= SOON_DAYS && 'soon')}>
      <small>{n.next.what}</small>
      <b>{md(n.next.date)}</b>
      <small>{left <= 0 ? '今天' : `还有 ${left} 天`}</small>
    </div>
  );
}

// 「（二号通知）」 says which notice the post was, not what the event is.
export const shownName = (name: string): string => name.replace(/\s*[（(][^）)]*(?:通知|邀请)[^）)]*[）)]\s*$/, '');

// How to get in, before the day: the meeting number where the post prints one, the links it gives,
// the B站 account that streams it; else what the AI read (「腾讯会议」 alone, when that is all it says).
export function Live({ n }: { n: Notice }) {
  if (!n.online || n.status !== 'upcoming') return null;
  const a = n.access;
  const said = !a?.meeting && n.live;
  return (
    <div class="notice-live">
      <b>{n.online === '线上' ? '线上' : '可线上看'}</b>
      {a?.meeting && <span class="notice-meeting">{a.meeting}</span>}
      {said && <span title="推文里没写会议号，多是报名后才发">{n.live}</span>}
      {a?.links.map((l) => <a key={l.url} class="notice-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>{l.label} ↗</a>)}
    </div>
  );
}

export function Replays({ n }: { n: Notice }) {
  if (!n.replays.length) return null;
  return (
    <p class="notice-replays"><b>B站录像</b>
      {n.replays.slice(0, 3).map((v) => (
        <a key={v.bvid} href={`https://www.bilibili.com/video/${v.bvid}`} target="_blank" rel="noopener noreferrer"
          title={`${v.author} · ${v.minutes} 分钟`}>{v.title}<small>{v.minutes} 分钟</small></a>
      ))}
    </p>
  );
}

// One line each: when, what kind, the name, and where and by whom in a line under it. A click opens
// the rest in place (what it is about, how to get in, the speakers, contact, the post it came from);
// with onPick (首页 with room for a preview beside the list) it picks the row instead.
export function NoticeRow({ n, picked, onPick }: { n: Notice; picked?: boolean; onPick?: (n: Notice) => void }) {
  const [opened, setOpen] = useState(false);
  const open = opened && !onPick;
  const dates = [n.date && `${md(n.date)}${n.end ? `–${md(n.end)}` : ''}举办`, n.deadline && `${md(n.deadline)}截止`].filter(Boolean).join('，');
  const brief = [dates, n.place, n.organizer].filter(Boolean);
  const remote = !!n.online && n.status === 'upcoming';
  return (
    <li class={cx('notice', open && 'open', picked && 'picked', n.status === 'past' && 'past', remote && 'remote', n.status === 'recorded' && 'recorded')}>
      <button class="notice-sum" aria-expanded={onPick ? undefined : open} aria-pressed={onPick ? !!picked : undefined}
        onClick={() => (onPick ? onPick(n) : setOpen(!open))}>
        <When n={n} />
        <span class="notice-body">
          <span class="notice-head">
            <span class={`notice-kind ${toneOf(n.kind)}`}>{n.kind}</span>
            {remote && <span class="notice-onair">{n.online === '线上' ? '线上' : '直播'}</span>}
            {n.replays.length > 0 && <span class="notice-kind tone-teal">有录像</span>}
            <span class="notice-name">{shownName(n.name)}</span>
          </span>
          {brief.length > 0 && <span class="notice-facts">{brief.map((f) => <span key={f}>{f}</span>)}</span>}
        </span>
        {!onPick && <span class="notice-chev" aria-hidden="true">{open ? '收起' : '展开'}</span>}
      </button>
      {open && (
        <div class="notice-more">
          {n.summary && <p class="notice-summary">{n.summary}</p>}
          {n.speakers.length > 0 && <p class="notice-line"><b>主讲</b>{n.speakers.join('、')}</p>}
          <Live n={n} />
          <Replays n={n} />
          {n.contact && <div class="notice-line"><b>联系</b><Contact text={n.contact} /></div>}
          <div class="notice-line"><b>来源</b><FromPost post={n.post} scope="notices" extra={n.posts > 1 ? `${n.posts} 篇推文` : undefined} /></div>
        </div>
      )}
    </li>
  );
}

// One section a month: what is to come by the month of its next date, nearest first; then the
// standing calls; then what is over, by the month it was held (or closed), latest first.
const monthOf = (ymd: string): string => `${ymd.slice(0, 4)}年${Number(ymd.slice(5, 7))}月`;
// What is on now goes under this month, not the month it began in.
const todayYmd = (): string => { const d = today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nextOn = (n: Notice): string => (n.next!.what === '进行中' ? todayYmd() : n.next!.date);
const heldOn = (n: Notice): string => n.end || n.date || n.deadline || new Date(n.post.published * 1000).toISOString().slice(0, 10);
export function noticeSections(items: readonly Notice[]): { key: string; label: string; items: Notice[] }[] {
  const out: { key: string; label: string; items: Notice[] }[] = [];
  const add = (key: string, label: string, n: Notice): void => {
    const sec = out.find((x) => x.key === key);
    if (sec) sec.items.push(n); else out.push({ key, label, items: [n] });
  };
  for (const n of items.filter((x) => x.status === 'upcoming')) add(`u:${monthOf(nextOn(n))}`, monthOf(nextOn(n)), n);
  for (const n of items.filter((x) => x.status === 'open')) add('open', '常设征稿与不限期', n);
  const over = items.filter((x) => x.status === 'recorded' || x.status === 'past').sort((a, b) => heldOn(b).localeCompare(heldOn(a)));
  for (const n of over) add(`p:${monthOf(heldOn(n))}`, `${monthOf(heldOn(n))} · 已结束`, n);
  return out;
}

// 学术动态: what is still to come, nearest deadline or date first; what is over only when asked.
export function NoticesView() {
  const [kind, setKind] = useState('');
  const [past, setPast] = useState(false);
  const [online, setOnline] = useState(false);
  const [page, setPage] = useState<NoticesPage | null>(null);
  const asked = useRef(0);
  const load = async (): Promise<void> => {
    const n = ++asked.current;
    try {
      const r = await api.notices({ kind, past, online });
      if (n === asked.current) setPage(r);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  useEffect(() => { void load(); }, [kind, past, online]);
  usePoll(!!(page?.reading || page?.stalled), () => void load());
  const reading = readingNote(page);
  return (
    <section class="list journals-page tocs-page notices-page">
      <div class="list-scroll journals-scroll">
        <div class="tocs-column">
          <header class="tocs-head">
            <h2>学术动态</h2>
            {page && <span class="muted">{page.items.length} 项</span>}
            <span class="grow" />
            <button class={cx('btn small', online && 'primary')} aria-pressed={online} onClick={() => setOnline(!online)}
              title="线上举办或另有直播的，还没开始的">可线上看{page && !online && page.online > 0 ? ` ${page.online}` : ''}</button>
            <button class={cx('btn small', past && 'primary')} aria-pressed={past} onClick={() => setPast(!past)}
              title="截止日和举办日都已过的">含已过{page && !past && page.past > 0 ? ` ${page.past}` : ''}</button>
          </header>
          <Chips list={page?.kinds ?? []} value={kind} onPick={setKind} label="按类别" note={reading} />
          {page?.items.length === 0 && <p class="muted empty">{page.reading ? '正在从推文里找会议、征稿和讲座…' : online ? '没有还没开始、能线上看的。' : '没有尚未到期的学术动态。'}</p>}
          {page?.items.length === 0 && !page.reading && <NeedsAi what="会议、征稿和讲座是 AI 从推文里读出来的，" />}
          {noticeSections(page?.items ?? []).map((sec) => (
            <section key={sec.key} class="notice-group">
              <h3 class="book-month">{sec.label}<small>{sec.items.length} 项</small></h3>
              <ol class="notices">{sec.items.map((n) => <NoticeRow key={`${n.post.id}:${n.name}`} n={n} />)}</ol>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
