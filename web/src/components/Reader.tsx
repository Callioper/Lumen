import { useState, useEffect, useRef } from 'preact/hooks';
import { detail, selectedId, markAboveRead, setRead, toggleStar, toggleReaction, runAi, open, openShare, prefs, setPrefs, app, feedsById, select, viewMode, clipToObsidian, clipping, isMarks, isReports,
  showFull, translating, hasTranslation, cycleTranslation, translateEntry, translateOnOpen, items as listItems, sortMode, selection, tab, recAvailable, scope, type TrView } from '../store.ts';
import { effectiveLayout } from '../layout.ts';
import { MarkDetail, actionLine } from './Marks.tsx';
import { reportKind } from '../reports.ts';
import { cnkiTitleUrl } from '../cnki.ts';
import { api, type ListItem, type EntryDetail, type Reaction, type RelatedItem, type SubjectMarks, type Comment, type Comments } from '../api.ts';
import { BookList } from './Books.tsx';
import { noteProgress } from '../reading.ts';
import { Icon, FeedIcon } from './Icon.tsx';
import { ago, fullDate, proxied, proxifyHtml, readingMinutes, parseEnclosures, hostOf, cx, safeLink, isForeignText } from '../util.ts';
import { DEMO, DemoWelcome } from '../demo/tour.tsx';

function bilibiliEmbed(link: string | null): string | null {
  const bv = link?.match(/bilibili\.com\/video\/(BV[\w]+)/)?.[1];
  return bv ? `https://player.bilibili.com/player.html?bvid=${bv}&autoplay=0&high_quality=1` : null;
}

function AiCard({ d }: { d: EntryDetail }) {
  const [busy, setBusy] = useState<string | null>(null);
  const hasKey = app.value?.hasAiKey;
  const run = async (what: string, tasks: Parameters<typeof runAi>[0]): Promise<void> => {
    setBusy(what);
    try { await runAi(tasks); } finally { setBusy(null); }
  };
  const aiTags = d.tags.filter((t) => t.source === 'ai' || t.source === 'knn');
  if (!d.ai_summary) {
    return (
      <div class="ai-card empty">
        <Icon name="sparkles" size={15} />
        <span>{hasKey ? '这篇还没有 AI 摘要' : '未配置 AI 密钥，去「设置 → AI」填写'}</span>
        {hasKey && (
          <button class="btn small" disabled={!!busy} onClick={() => void run('summary', { summary: true, classify: true, title: !/[㐀-鿿]/.test(d.title) })}>
            {busy === 'summary' ? <><span class="spinner sm" />生成中</> : '生成摘要'}
          </button>
        )}
      </div>
    );
  }
  return (
    <aside class="ai-card">
      <header>
        <span class="ai-label"><Icon name="sparkles" size={14} />AI 摘要</span>
        {aiTags.map((t) => <span key={t.name} class={cx('chip mini', t.source === 'knn' && 'guessed')} title={t.source === 'knn' ? '按内容相近的文章推测' : undefined}>{t.name.replace(/^AI:/, '')}</span>)}
        <span class="grow" />
        {hasKey && (
          <button class="icon-btn sm" title="重新生成" disabled={!!busy} onClick={() => void run('re', { summary: true, classify: true })}>
            {busy === 're' ? <span class="spinner sm" /> : <Icon name="refresh" size={13} />}
          </button>
        )}
      </header>
      <div class="ai-body" dangerouslySetInnerHTML={{ __html: d.ai_summary }} />
    </aside>
  );
}

const LESS: { key: Reaction; label: string; hint: string; kbd: string }[] = [
  { key: 'less_topic', label: '少推这类', hint: '这个话题不想多看', kbd: 'x' },
  { key: 'less_source', label: '少推这个源', hint: '这个订阅源整体降一档', kbd: 'X' },
];

// 喜欢 (l) and 不感兴趣 (x / X): explicit signals for the recommendation profile.
function Reactions({ d }: { d: EntryDetail }) {
  const [isOpen, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);
  const r = d.reaction ?? null;
  const less = r === 'less_topic' || r === 'less_source';
  return (
    <>
      <button class={cx('icon-btn', r === 'like' && 'on-like')} title="喜欢 (l)" disabled={d.loading} onClick={() => void toggleReaction('like')}>
        <Icon name="heart" fill={r === 'like'} />
      </button>
      <div class="layout-pick" ref={ref}>
        <button class={cx('icon-btn', less && 'on')} title="不感兴趣 (x 少推这类 · X 少推这个源)" aria-haspopup="menu" aria-expanded={isOpen}
          disabled={d.loading} onClick={() => setOpen(!isOpen)}>
          <Icon name="thumbs-down" fill={less} />
        </button>
        {isOpen && (
          <div class="menu" role="menu">
            {LESS.map((o) => (
              <button key={o.key} role="menuitemradio" aria-checked={r === o.key} class={cx('menu-item', r === o.key && 'on')}
                onClick={() => { setOpen(false); void toggleReaction(o.key); }}>
                <span class="menu-text"><b>{o.label}</b><small>{o.hint}</small></span>
                {r === o.key ? <Icon name="check" size={14} /> : <kbd>{o.kbd}</kbd>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// Under the article: other feeds' reports of the same story, then related reading.
// Why the 推荐 order put this article where it did, from the list it was opened from.
const stars = (r: number): string => '★'.repeat(Math.round(r)) + '☆'.repeat(Math.max(0, 5 - Math.round(r)));

function CommentItem({ c }: { c: Comment }) {
  return (
    <li>
      <p class="comment-who">
        <strong>{c.who || '匿名'}</strong>
        {c.rating ? <span class="comment-rating" title={`${c.rating} 星`}>{stars(c.rating)}</span> : null}
        {c.time ? <time title={fullDate(c.time)}>{ago(c.time)}</time> : null}
        {c.likes ? <span class="comment-likes">{c.likes} 赞</span> : null}
      </p>
      <p class="comment-text">{c.text}</p>
      {c.replies.length > 0 && <ul class="comment-replies">{c.replies.map((r, i) => <CommentItem key={i} c={r} />)}</ul>}
    </li>
  );
}

// An article's images come without a size (WeChat's never have one), so before they load each is 0
// high, every one counts as in view, and lazy loading fetches them all at once: 37 images, 24 MB,
// holding the browser's six connections to Lumen while the next article waited behind them.
// .content img keeps a placeholder height until its image has come (or failed).
function settleImage(e: Event): void {
  if (e.target instanceof HTMLImageElement) e.target.classList.add('settled');
}

// 评论区: the comments on the original page, fetched only when opened (the site is asked at
// most once a day per entry; 刷新 asks again).
function CommentSection({ id, source }: { id: number; source: string }) {
  const [state, setState] = useState<{ busy: boolean; data?: Comments; error?: string } | null>(null);
  const load = async (refresh: boolean): Promise<void> => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try { setState({ busy: false, data: await api.comments(id, refresh) }); } catch (e) { setState((s) => ({ ...s, busy: false, error: (e as Error).message })); }
  };
  const data = state?.data;
  return (
    <section class="comments">
      <h3>评论区 <span>· {source}</span></h3>
      {!state && <button class="btn small" onClick={() => void load(false)}>展开评论</button>}
      {state?.busy && !data && <p class="muted">正在取评论…</p>}
      {state?.error && <p class="tr-note bad">{state.error}</p>}
      {data && (
        <>
          {data.comments.length
            ? <ul class="comment-list">{data.comments.map((c, i) => <CommentItem key={i} c={c} />)}</ul>
            : <p class="muted">还没有评论。</p>}
          <p class="comment-foot">
            {data.total > data.comments.length && <span>共 {data.total} 条，这里是最热的 {data.comments.length} 条 · </span>}
            {safeLink(data.url) && <a href={safeLink(data.url)!} target="_blank" rel="noopener noreferrer">去原站看全部</a>}
            <span> · {ago(data.fetchedAt)}取的{data.stale && `（这次没取到：${data.stale}）`} · </span>
            <button class="linkish" disabled={state?.busy} onClick={() => void load(true)}>{state?.busy ? '刷新中…' : '刷新'}</button>
          </p>
        </>
      )}
    </section>
  );
}

const FRIEND_COMMENTS_SHOWN = 4;

// 友邻标记: the books, films and records this article links to on Douban, with who among the
// followed people marked them and what they said; read from the library, nothing is fetched.
function FriendsMarks({ id }: { id: number }) {
  const [subjects, setSubjects] = useState<{ id: number; list: SubjectMarks[] } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    api.friends(id).then((r) => { if (live) setSubjects({ id, list: r.subjects }); }).catch(() => { if (live) setSubjects({ id, list: [] }); });
    return () => { live = false; };
  }, [id]);
  const list = subjects?.id === id ? subjects.list : [];
  if (!list.length) return null;
  return (
    <section class="friends">
      <h3>友邻标记</h3>
      {list.map((s) => {
        const said = s.marks.filter((m) => m.comment);
        const all = open.has(s.id);
        return (
          <div class="friends-subject" key={s.id}>
            {s.cover && <img class="friends-cover" src={proxied(s.cover)} alt="" loading="lazy" />}
            <div class="friends-body">
              <p class="friends-title"><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>{s.info && <span class="friends-info">{s.info}</span>}</p>
              <p class="friends-who">{actionLine(s)}</p>
              {said.slice(0, all ? said.length : FRIEND_COMMENTS_SHOWN).map((m) => (
                <p class="friends-comment" key={m.id}><strong>{m.who}</strong>{m.comment}</p>
              ))}
              {said.length > FRIEND_COMMENTS_SHOWN && !all && (
                <button class="linkish" onClick={() => setOpen(new Set([...open, s.id]))}>还有 {said.length - FRIEND_COMMENTS_SHOWN} 条短评</button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function RecReasons({ id }: { id: number }) {
  const rec = sortMode.value === 'rec' ? listItems.value.find((i) => i.id === id)?.rec : undefined;
  if (!rec?.reasons.length) return null;
  return <p class={rec.explore ? 'rec-why explore' : 'rec-why'}><span>为什么推荐</span>{rec.reasons.join('；')}</p>;
}

function Related({ id }: { id: number }) {
  const [items, setItems] = useState<RelatedItem[]>([]);
  useEffect(() => {
    let live = true;
    setItems([]);
    api.related(id).then((r) => { if (live) setItems(r.items); }, () => { /* the block simply stays hidden */ });
    return () => { live = false; };
  }, [id]);
  if (!items.length) return null;
  const same = items.filter((i) => i.sameStory), rest = items.filter((i) => !i.sameStory);
  const row = (it: RelatedItem, i: number) => (
    <li key={it.id}>
      <button class={cx('related-item', !!it.is_read && 'read')} onClick={() => void open(it, { listScope: `related:${id}`, sortMode: 'latest', position: i })}>
        <FeedIcon id={it.feed_id} title={it.feed_title} size={16} />
        <span class="related-title">{it.title_zh || it.title}</span>
        <span class="related-meta">{it.feed_title} · {ago(it.published)}</span>
      </button>
    </li>
  );
  return (
    <section class="related" aria-label="相关文章">
      {same.length > 0 && <><h3>其他源也报道了</h3><ul>{same.map(row)}</ul></>}
      {rest.length > 0 && <><h3>相关文章</h3><ul>{rest.map((it, i) => row(it, same.length + i))}</ul></>}
    </section>
  );
}

// Before an article is opened: what is waiting in the list on the left — which sources have the
// most unread, the AI tags among them, and the top of 推荐 — instead of an empty pane.
function ScopeOverview() {
  const a = app.value;
  const sel = selection.value;
  const t = tab.value;
  const [recs, setRecs] = useState<ListItem[]>([]);
  useEffect(() => {
    let live = true;
    setRecs([]);
    if (recAvailable.value) api.recommended(scope(), 0, 3).then((r) => { if (live) setRecs(r.items); }).catch(() => {});
    return () => { live = false; };
  }, [sel, t, recAvailable.value]);
  if (!a) return null;
  const inScope = a.feeds.filter((f) => (sel.kind !== 'category' || f.category_id === sel.id) && (sel.kind !== 'feed' || f.id === sel.id)
    && (t === 'all' || sel.kind === 'feed' || effectiveLayout(f, a.categories) === t));
  const top = inScope.filter((f) => f.unread > 0).sort((x, y) => y.unread - x.unread).slice(0, 6);
  const unread = inScope.reduce((n, f) => n + f.unread, 0);
  const tags = a.tags.filter((g) => (g.source === 'ai' || g.source === 'knn') && g.unread > 0).sort((x, y) => y.unread - x.unread).slice(0, 12);
  return (
    <div class="scope-ov">
      {DEMO && sel.kind === 'all' && <DemoWelcome />}
      <header class="scope-ov-head">
        <p class="scope-ov-kicker">左边还有</p>
        <h1><b>{unread}</b> 篇未读<small>来自 {inScope.filter((f) => f.unread > 0).length} 个源</small></h1>
      </header>
      {top.length > 0 && (
        <section>
          <h2 class="dossier-h">未读最多</h2>
          <ul class="scope-ov-feeds">
            {top.map((f) => (
              <li key={f.id}><button onClick={() => select({ kind: 'feed', id: f.id })}>
                <FeedIcon id={f.id} title={f.title} size={16} /><span class="ov-name">{f.title}</span>
                <span class="ov-bar" style={{ width: `${Math.max(6, (f.unread / top[0].unread) * 100)}%` }} /><small>{f.unread}</small>
              </button></li>
            ))}
          </ul>
        </section>
      )}
      {tags.length > 0 && (
        <section>
          <h2 class="dossier-h">AI 标签</h2>
          <div class="tag-cloud">{tags.map((g) => (
            <button key={g.name} class="chip" onClick={() => select({ kind: 'tag', name: g.name })}>{g.name.replace(/^AI:/, '')}<small>{g.unread}</small></button>
          ))}</div>
        </section>
      )}
      {recs.length > 0 && (
        <section>
          <h2 class="dossier-h">推荐先读</h2>
          <ol class="scope-ov-recs">{recs.map((it) => (
            <li key={it.id}><button onClick={() => void open(it)}><span>{it.title}</span><small>{feedsById.value.get(it.feed_id)?.title}</small></button></li>
          ))}</ol>
        </section>
      )}
    </div>
  );
}

export function Reader() {
  return isMarks.value ? <MarkDetail /> : <EntryReader />;
}

const TR_LABEL: Record<TrView, string> = { translation: '译', bilingual: '双', original: '原' };
const TR_NEXT: Record<TrView, string> = { translation: '原文', bilingual: '译文', original: '双语' };

// Shown for foreign entries: translates on first use, then cycles 双语 → 译文 → 原文 (t).
function TranslateButton({ d, view }: { d: EntryDetail; view: TrView }) {
  if (translating.value) return <button class="icon-btn" disabled title="翻译中…"><span class="spinner sm" /></button>;
  if (!hasTranslation(d)) {
    const other = d.content_tr ? (d.tr_of === 'full' ? '（已有全文的译文，这里是摘录）' : '（已有摘录的译文，这里是全文）') : '';
    return <button class="icon-btn" title={`翻译成中文 (t)${other}`} onClick={cycleTranslation}><Icon name="languages" /></button>;
  }
  return <button class="icon-btn tr-btn on" title={`当前：${{ translation: '译文', bilingual: '双语', original: '原文' }[view]}，点一下切到${TR_NEXT[view]} (t)`} onClick={cycleTranslation}>{TR_LABEL[view]}</button>;
}

function TranslationNote({ d }: { d: EntryDetail }) {
  const model = app.value?.settings.translate.model;
  return <p class="tr-note">机器翻译{model ? `（${model}）` : ''}{d.tr_note ? ` · ${d.tr_note}` : ''} · 按 <kbd>t</kbd> 在双语、译文、原文之间切换</p>;
}

function EntryReader() {
  const d = detail.value;
  const setShowFull = (v: boolean): void => { showFull.value = v; };
  const [fetchingFull, setFetchingFull] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [d?.id]);
  // Decided once the real entry has arrived: the placeholder shown while switching has no body.
  useEffect(() => {
    setShowFull(!!d?.content_full);
  }, [d?.id, d?.loading]);
  useEffect(() => { translateOnOpen(); }, [d?.id, d?.loading]);
  // A body that fits on screen is read to its end without any scrolling.
  useEffect(() => {
    if (!d || d.loading || !scroller.current) return;
    const el = scroller.current, id = d.id;
    const raf = requestAnimationFrame(() => noteProgress(id, el));
    return () => cancelAnimationFrame(raf);
  }, [d?.id, d?.loading, showFull.value, prefs.value.trView]);

  if (!d) {
    // A report has the width to itself until a paper is opened beside it.
    if (viewMode.value === 'grid' || isReports.value) return null;
    return (
      <main class="reader blank">
        <ScopeOverview />
        <p class="hint"><kbd>j</kbd> <kbd>k</kbd> 上下篇（到底接下一个分类）· <kbd>Shift</kbd>+<kbd>K</kbd> 以上标为已读 · <kbd>f</kbd> 收藏 · <kbd>r</kbd> 已读/未读 · <kbd>空格</kbd> 打开原文 · <kbd>/</kbd> 搜索 · <kbd>c</kbd> 存档到 Obsidian · <kbd>l</kbd> 喜欢 · <kbd>x</kbd> 少推这类 · <kbd>X</kbd> 少推这个源 · <kbd>p</kbd> 复制分享图 · <kbd>t</kbd> 翻译 / 切换译文</p>
      </main>
    );
  }

  const link = safeLink(d.link);
  const feed = feedsById.value.get(d.feed_id);
  const html = (showFull.value && d.content_full) || d.content || '';
  const trView = prefs.value.trView;
  const translated = hasTranslation(d) && trView !== 'original';
  const foreign = !d.loading && (!!d.content_tr || d.tr_state === 3 || isForeignText(html.replace(/<[^>]+>/g, ' ')));
  const enclosures = parseEnclosures(d.enclosures);
  const audio = enclosures.find((e) => e.type.startsWith('audio') || /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(e.url));
  const video = enclosures.find((e) => e.type.startsWith('video'));
  const embed = d.view === 'video' ? bilibiliEmbed(link) : null;
  const title = d.title_zh || d.title;
  const feedTags = d.tags.filter((t) => t.source === 'feed').slice(0, 6);

  const toggleFull = async (): Promise<void> => {
    if (d.content_full) { setShowFull(!showFull.value); return; }
    setFetchingFull(true);
    try { await runAi({ fulltext: true }); setShowFull(true); } finally { setFetchingFull(false); }
  };

  return (
    <main class={cx('reader', viewMode.value === 'grid' && 'overlay')}>
      <header class="reader-bar">
        {(viewMode.value === 'grid' || isReports.value) && (
          <button class="icon-btn" title="关闭 (Esc)" onClick={() => { detail.value = null; selectedId.value = null; }}><Icon name="x" /></button>
        )}
        <button class="crumb" onClick={() => feed && select({ kind: 'feed', id: feed.id })}>
          {feed && <FeedIcon id={feed.id} title={feed.title} size={18} />}
          <span>{d.feed_title}</span>
        </button>
        <span class="grow" />
        {isReports.value && reportKind.value === 'papers' && (
          <a class="icon-btn text-btn" href={cnkiTitleUrl(d.title)} target="_blank" rel="noopener noreferrer" title="在知网按篇名检索">知网</a>
        )}
        <Reactions d={d} />
        <button class={cx('icon-btn', d.is_starred && 'on-star')} title="收藏 (f)" onClick={() => void toggleStar(d)}>
          <Icon name="star" fill={!!d.is_starred} />
        </button>
        <button class="icon-btn" title={d.is_read ? '标为未读 (r)' : '标为已读 (r)'} onClick={() => void setRead(d, !d.is_read)}>
          <Icon name={d.is_read ? 'circle' : 'check'} />
        </button>
        <button class="icon-btn" title="把列表里这篇上面的都标为已读 (Shift+K)，5 秒内可撤销" onClick={() => void markAboveRead()}>
          <Icon name="readAbove" />
        </button>
        <button class={cx('icon-btn', showFull.value && 'on')} title={d.content_full ? '切换全文 / 摘录' : '抓取全文'} onClick={() => void toggleFull()} disabled={fetchingFull || !link}>
          {fetchingFull ? <span class="spinner sm" /> : <Icon name="doc" />}
        </button>
        <button class={cx('icon-btn', d.tags.some((t) => t.source === 'clip') && 'on')} title="存档到 Obsidian (c)" onClick={() => void clipToObsidian()} disabled={clipping.value}>
          {clipping.value ? <span class="spinner sm" /> : <Icon name="archive" />}
        </button>
        {foreign && <TranslateButton d={d} view={trView} />}
        <button class="icon-btn" title="分享图（p 直接复制）" disabled={d.loading} onClick={openShare}><Icon name="share" /></button>
        <button class={cx('icon-btn', prefs.value.serif && 'on')} title="衬线字体" onClick={() => setPrefs({ serif: !prefs.value.serif })}>
          <Icon name="type" />
        </button>
        {link && <a class="icon-btn" href={link} target="_blank" rel="noopener noreferrer" title="打开原文 (空格)"><Icon name="external" /></a>}
      </header>

      <div class="reader-scroll" ref={scroller} onScroll={(e) => noteProgress(d.id, e.currentTarget)}>
        <article class={cx('prose', prefs.value.serif && 'serif')} style={{ '--prose-size': `${prefs.value.fontSize}px` }}>
          <h1 class="title">{link ? <a href={link} target="_blank" rel="noopener noreferrer">{title}</a> : title}</h1>
          {d.title_zh && d.title_zh !== d.title && <p class="title-orig">{d.title}</p>}
          <p class="byline">
            {d.author && <span>{d.author}</span>}
            <time title={fullDate(d.published)}>{fullDate(d.published).slice(0, 16)}</time>
            {!d.loading && <span>{readingMinutes(html)} 分钟</span>}
            {link && <span class="host">{hostOf(link)}</span>}
          </p>
          {feedTags.length > 0 && <p class="feed-tags">{feedTags.map((t) => <span key={t.name}>#{t.name}</span>)}</p>}

          {!d.loading && <AiCard d={d} />}

          {embed && <div class="embed"><iframe src={embed} allowFullScreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" /></div>}
          {audio && <audio class="player" controls preload="none" src={audio.url} />}
          {video && !embed && <video class="player" controls preload="none" src={video.url} />}

          {d.loading
            ? <div class="content-loading" aria-label="正文加载中"><span /><span /><span /><span /></div>
            : <>
              {translated && <TranslationNote d={d} />}
              <BookList id={d.id} />
              {!translated && d.tr_state === 3 &&<p class="tr-note bad">自动翻译没成功：{d.tr_note}。<button class="linkish" onClick={() => void translateEntry()}>重试</button></p>}
              <div class={cx('content', translated && `tr-${trView}`)} onLoadCapture={settleImage} onErrorCapture={settleImage}
                dangerouslySetInnerHTML={{ __html: proxifyHtml(translated ? d.content_tr! : html) }} />
            </>}
          {!d.loading && !html.trim() && <p class="muted">这篇没有正文。{link && <a href={link} target="_blank" rel="noopener noreferrer">去原文看看</a>}</p>}
          {!d.loading && <FriendsMarks id={d.id} />}
          {!d.loading && d.comment_source && <CommentSection key={d.id} id={d.id} source={d.comment_source} />}
          {!d.loading && <RecReasons id={d.id} />}
          {!d.loading && <Related id={d.id} />}
        </article>
      </div>
    </main>
  );
}
