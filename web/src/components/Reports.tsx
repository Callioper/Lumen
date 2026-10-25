import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isReports } from '../store.ts';
import type { ReportPaper, ReportKind, PapersReport, DailyReport, WeeklyReport, DailyItem, AnyReport } from '../api.ts';
import { JOURNAL_PREVIEW, reportKind, reportPeriod, rowsOfKind, current, reportLoading, regenerating, selectedKey,
  openJournals, toggleJournal, pickKey, groupKey, journalKey, threadKey, loadReports, showReport, openPaper, regenerate } from '../reports.ts';
import { Icon } from './Icon.tsx';
import { cx, rangeLabel } from '../util.ts';
import { cnkiTitleUrl, cnkiSourceUrl } from '../cnki.ts';

const KIND_LABEL: Record<ReportKind, string> = { papers: '论文周报', weekly: '周报', daily: '日报' };
const NUMERALS = '一二三四五六七八九十';

function Meta({ p }: { p: ReportPaper }) {
  const c = current.value!;
  const z = c.report.kind === 'papers' ? c.report.zotero[p.id] : undefined;
  const st = c.state[p.id];
  return (
    <p class="paper-meta">
      {p.authors && <span class="paper-authors">{p.authors}</span>}
      {p.via === 'repost' && (p.venue ? <span class="paper-venue">{p.venue}</span>
        : <span class="paper-venue none" title="推送里没写原刊（多是公众号首发的译文或文章）">未注明出处</span>)}
      {p.via === 'repost' && <span class="paper-via">{p.feed}{p.also.length > 0 && `，另见 ${p.also.join('、')}`}</span>}
      {z === true && <span class="paper-tag zotero">Zotero 已在库</span>}
      {c.reprints?.[p.id] && <span class="paper-tag reprint" title={`${c.reprints[p.id]}全文转载`}>人大复印</span>}
      <a class="paper-cnki" href={cnkiTitleUrl(p.title)} target="_blank" rel="noopener noreferrer" title="在知网按篇名检索"
        onClick={(e) => e.stopPropagation()}>知网</a>
      {st?.starred && <span class="paper-tag starred"><Icon name="star" size={11} />收藏</span>}
    </p>
  );
}

function Paper({ p, k, star }: { p: ReportPaper; k: string; star?: boolean }) {
  const st = current.value!.state[p.id];
  return (
    <article class={cx('paper', k === selectedKey.value && 'selected', st?.read ? 'read' : 'unread', st === null && 'gone')}
      data-key={k} onClick={() => void openPaper(p.id, k)}>
      <h3 class="paper-title">{star && <span class="paper-star" title="本周值得精读">精读</span>}{p.title}</h3>
      <Meta p={p} />
      {p.abstract && <p class="paper-abstract">{p.abstractBy === 'ai' && <span class="ai-abstract" title="原文没有摘要，这是 AI 摘要的开头">AI</span>}{p.abstract}</p>}
    </article>
  );
}

function Pick({ p, n }: { p: ReportPaper; n: number }) {
  const k = pickKey(p.id);
  const st = current.value!.state[p.id];
  return (
    <article class={cx('pick', k === selectedKey.value && 'selected', st?.read ? 'read' : 'unread')} data-key={k} onClick={() => void openPaper(p.id, k)}>
      <span class="pick-n">{n}</span>
      <div class="pick-body">
        <h3 class="paper-title">{p.title}</h3>
        <Meta p={p} />
        {p.abstract && <p class="paper-abstract">{p.abstractBy === 'ai' && <span class="ai-abstract" title="原文没有摘要，这是 AI 摘要的开头">AI</span>}{p.abstract}</p>}
      </div>
    </article>
  );
}

// Like a 简报 block: the journal's name, a few titles, the rest behind 展开.
function JournalCard({ feed, items }: { feed: string; items: ReportPaper[] }) {
  const c = current.value!;
  const open = openJournals.value.has(feed);
  const unread = items.filter((p) => !c.state[p.id]?.read).length;
  const shown = open ? items : items.slice(0, JOURNAL_PREVIEW);
  return (
    <section class={cx('journal', unread ? 'unread' : 'read')}>
      <header class="journal-head">
        <button class="journal-name" onClick={() => toggleJournal(feed)} title={open ? '收起' : '展开全部'}>{feed}</button>
        <span class="journal-count">{items.length} 篇{unread ? ` · ${unread} 未读` : ''}</span>
        <a class="paper-cnki" href={cnkiSourceUrl(feed)} target="_blank" rel="noopener noreferrer" title="在知网看这本刊最新的几期">知网本期</a>
      </header>
      <div class="journal-lines">
        {shown.map((p) => {
          const k = journalKey(feed, p.id);
          return (
            <div key={p.id} class={cx('line', k === selectedKey.value && 'selected', c.state[p.id]?.read ? 'read' : 'unread')} data-key={k}
              onClick={() => void openPaper(p.id, k)} title={p.abstract || p.title}>
              <span class="line-title">{p.title}</span>
              <span class="line-feed">{p.authors}</span>
            </div>
          );
        })}
      </div>
      {items.length > JOURNAL_PREVIEW && (
        <footer class="journal-foot">
          <button class="link" onClick={() => toggleJournal(feed)}>{open ? '收起' : `展开其余 ${items.length - JOURNAL_PREVIEW} 篇`}</button>
        </footer>
      )}
    </section>
  );
}

// A 日报/周报 entry: the title, where it came from, and its one-sentence lead.
function Item({ it, k, n }: { it: DailyItem; k: string; n?: number }) {
  const st = current.value!.state[it.id];
  const body = (
    <>
      <h3 class="paper-title">{it.title}</h3>
      <p class="paper-meta">
        <span class="paper-authors">{it.feed}</span>
        {it.also.length > 0 && <span class="paper-via">另见 {it.also.join('、')}</span>}
        {st?.starred && <span class="paper-tag starred"><Icon name="star" size={11} />收藏</span>}
      </p>
      {it.lead && <p class="paper-abstract">{it.lead}</p>}
    </>
  );
  return n
    ? <article class={cx('pick', k === selectedKey.value && 'selected', st?.read ? 'read' : 'unread')} data-key={k} onClick={() => void openPaper(it.id, k)}>
        <span class="pick-n">{n}</span><div class="pick-body">{body}</div>
      </article>
    : <article class={cx('paper', k === selectedKey.value && 'selected', st?.read ? 'read' : 'unread', st === null && 'gone')} data-key={k}
        onClick={() => void openPaper(it.id, k)}>{body}</article>;
}

const shortDay = (period: string): string => { const [, m, d] = period.split('-'); return `${Number(m)}月${Number(d)}日`; };

function Hero({ kind, from, to, children }: { kind: ReportKind; from: number; to: number; children: ComponentChildren }) {
  return (
    <header class="report-hero">
      <p class="report-kicker">{KIND_LABEL[kind]}</p>
      <h1 class="report-date">{rangeLabel(from, to)}</h1>
      <p class="report-stats">{children}</p>
    </header>
  );
}

function DailyBody({ r }: { r: DailyReport }) {
  return (
    <div class="report">
      <Hero kind="daily" from={r.from} to={r.to}>
        <span>进来 <b>{r.arrived}</b> 条</span><span>挑出 <b>{r.total}</b></span><span><b>{r.groups.length}</b> 个议题</span>
      </Hero>
      {r.overview && <section class="report-overview" id="rs-overview"><h2>今日</h2><p>{r.overview}</p></section>}
      {r.picks.length > 0 && (
        <section class="report-block" id="rs-picks">
          <h2 class="block-title">你可能错过</h2>
          <div class="picks">{r.picks.map((it, i) => <Item key={it.id} it={it} k={pickKey(it.id)} n={i + 1} />)}</div>
        </section>
      )}
      {r.explore && (
        <section class="report-block explore" id="rs-explore">
          <h2 class="block-title">破茧<small>和你平常读的方向不同，换换口味</small></h2>
          <Item it={r.explore} k={pickKey(r.explore.id)} />
        </section>
      )}
      {r.groups.map((g, gi) => (
        <section class="report-block topic" key={g.name} id={`rs-g${gi}`}>
          <h2 class="block-title"><span class="topic-n">{NUMERALS[gi] ?? gi + 1}</span>{g.name}<small>{g.items.length} 条</small></h2>
          {g.summary && <p class="topic-summary">{g.summary}</p>}
          {g.items.map((it) => <Item key={it.id} it={it} k={groupKey(gi, it.id)} />)}
        </section>
      ))}
    </div>
  );
}

const hasHot = (r: WeeklyReport): boolean => !!r.hot && r.hot.book.length + r.hot.movie.length > 0;

function WeeklyBody({ r }: { r: WeeklyReport }) {
  const s = r.stats;
  return (
    <div class="report">
      <Hero kind="weekly" from={r.from} to={r.to}>
        <span><b>{r.threads.length}</b> 条主线</span><span>由 <b>{r.dailies.length}</b> 份日报汇成</span><span>进来 <b>{s.arrived}</b> 条</span>
      </Hero>
      {r.overview && <section class="report-overview" id="rs-overview"><h2>本周</h2><p>{r.overview}</p></section>}
      {r.threads.map((t, ti) => (
        <section class="report-block topic" key={t.name} id={`rs-g${ti}`}>
          <h2 class="block-title"><span class="topic-n">{NUMERALS[ti] ?? ti + 1}</span>{t.name}<small>{t.days.map(shortDay).join('、')}</small></h2>
          {t.summary && <p class="topic-summary">{t.summary}</p>}
          {t.items.map((it) => <Item key={it.id} it={it} k={threadKey(ti, it.id)} />)}
          {t.more > 0 && <p class="topic-more">另有 {t.more} 条，在当天的日报里</p>}
        </section>
      ))}
      {hasHot(r) && (
        <section class="report-block" id="rs-hot">
          <h2 class="block-title">本周书影榜<small>两位以上友邻标过</small></h2>
          <div class="week-hot">
            {([['书', 'book'], ['影', 'movie']] as const).map(([label, kind]) => r.hot![kind].length > 0 && (
              <div key={kind}>
                <h3>{label}</h3>
                <ol>
                  {r.hot![kind].map((h) => (
                    <li key={h.subject}>
                      <a href={`https://${kind}.douban.com/subject/${h.subject}/`} target="_blank" rel="noopener noreferrer">{h.title}</a>
                      {h.isNew && <span class="hot-new">新上榜</span>}
                      <small>{h.people} 位友邻 · {h.who}{h.people > 3 ? ' 等' : ''}</small>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      )}
      <section class="report-block" id="rs-stats">
        <h2 class="block-title">本周阅读</h2>
        <div class="week-stats">
          <div><b>{s.completed}</b><span>读完</span></div>
          <div><b>{s.skimmed}</b><span>略读</span></div>
          <div><b>{s.starred}</b><span>收藏</span></div>
          <div><b>{s.liked}</b><span>喜欢</span></div>
        </div>
        {s.topFeeds.length > 0 && <p class="topic-summary">最常打开：{s.topFeeds.map((f) => `${f.feed}（${f.opened}）`).join('、')}</p>}
      </section>
    </div>
  );
}

function Body() {
  const r = current.value!.report;
  if (r.kind === 'daily') return <DailyBody r={r} />;
  if (r.kind === 'weekly') return <WeeklyBody r={r} />;
  return <PapersBody r={r} />;
}

function PapersBody({ r }: { r: PapersReport }) {
  const picked = new Set(r.picks.map((p) => p.id));
  const grouped = r.groups.flatMap((g) => g.items);
  const reposts = grouped.filter((p) => p.via === 'repost').length;
  const journalTotal = r.journals.reduce((n, j) => n + j.items.length, 0);
  return (
    <div class="report">
      <header class="report-hero">
        <p class="report-kicker">{KIND_LABEL[r.kind]}</p>
        <h1 class="report-date">{rangeLabel(r.from, r.to)}</h1>
        <p class="report-stats">
          <span><b>{r.total}</b> 篇</span>
          <span><b>{r.groups.length}</b> 个议题</span>
          <span>公众号转发 <b>{reposts}</b></span>
          <span>期刊新刊 <b>{journalTotal + grouped.length - reposts}</b></span>
        </p>
      </header>
      {r.overview && <section class="report-overview" id="rs-overview"><h2>本周</h2><p>{r.overview}</p></section>}
      {r.picks.length > 0 && (
        <section class="report-block" id="rs-picks">
          <h2 class="block-title">值得精读</h2>
          <div class="picks">{r.picks.map((p, i) => <Pick key={p.id} p={p} n={i + 1} />)}</div>
        </section>
      )}
      {r.groups.map((g, gi) => (
        <section class="report-block topic" key={g.name} id={`rs-g${gi}`}>
          <h2 class="block-title"><span class="topic-n">{NUMERALS[gi] ?? gi + 1}</span>{g.name}<small>{g.items.length} 篇</small></h2>
          {g.summary && <p class="topic-summary">{g.summary}</p>}
          {g.items.map((p) => <Paper key={p.id} p={p} k={groupKey(gi, p.id)} star={picked.has(p.id)} />)}
        </section>
      ))}
      {r.journals.length > 0 && (
        <section class="report-block" id="rs-journals">
          <h2 class="block-title">期刊新刊<small>其余 {journalTotal} 篇，按刊</small></h2>
          <div class="journals">{r.journals.map((j) => <JournalCard key={j.feed} feed={j.feed} items={j.items} />)}</div>
        </section>
      )}
    </div>
  );
}

// The report's sections, for the rail beside it: the same order the body draws them in.
function tocOf(r: AnyReport): { id: string; label: string; n?: number }[] {
  const out: { id: string; label: string; n?: number }[] = [];
  const overview = r.kind === 'daily' ? '今日' : '本周';
  if (r.overview) out.push({ id: 'rs-overview', label: overview });
  if (r.kind === 'weekly') {
    r.threads.forEach((t, i) => out.push({ id: `rs-g${i}`, label: t.name, n: t.items.length }));
    if (hasHot(r)) out.push({ id: 'rs-hot', label: '书影榜' });
    out.push({ id: 'rs-stats', label: '本周阅读' });
    return out;
  }
  if (r.picks.length) out.push({ id: 'rs-picks', label: r.kind === 'papers' ? '值得精读' : '你可能错过', n: r.picks.length });
  if (r.kind === 'daily' && r.explore) out.push({ id: 'rs-explore', label: '破茧' });
  r.groups.forEach((g, i) => out.push({ id: `rs-g${i}`, label: g.name, n: g.items.length }));
  if (r.kind === 'papers' && r.journals.length) out.push({ id: 'rs-journals', label: '期刊新刊', n: r.journals.reduce((n, j) => n + j.items.length, 0) });
  return out;
}

function Toc({ scroller }: { scroller: HTMLElement | null }) {
  const r = current.value?.report;
  const items = r ? tocOf(r) : [];
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (!scroller || !items.length) return;
    // The section whose top has passed the upper third of the pane is the one being read.
    const io = new IntersectionObserver((es) => {
      const seen = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (seen[0]) setAt(seen[0].target.id);
    }, { root: scroller, rootMargin: '0px 0px -66% 0px' });
    for (const t of items) { const el = scroller.querySelector(`#${t.id}`); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [scroller, r]);
  if (!items.length) return null;
  return (
    <nav class="report-toc" aria-label="本期目录">
      {items.map((t) => (
        <button key={t.id} class={cx(at === t.id && 'on')}
          onClick={() => scroller?.querySelector(`#${t.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <span>{t.label}</span>{t.n !== undefined && <small>{t.n}</small>}
        </button>
      ))}
    </nav>
  );
}

export function ReportsView() {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (isReports.value) void loadReports(); }, []);
  // j/k may land on a paper below the fold or inside a card that just opened.
  useEffect(() => {
    const k = selectedKey.value;
    if (k) requestAnimationFrame(() => document.querySelector(`.reports [data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [selectedKey.value]);
  const rows = rowsOfKind.value;
  const latest = rows[0]?.period === reportPeriod.value;
  const at = rows.findIndex((r) => r.period === reportPeriod.value);
  const path = current.value?.path;
  const vault = path ? `obsidian://open?path=${encodeURIComponent(path)}` : null;
  return (
    <section class="list reports">
      <header class="list-head">
        <div class="list-title"><h2>{KIND_LABEL[reportKind.value]}</h2></div>
        <div class="list-tools">
          {rows.length > 0 && (
            <button class="icon-btn" title="上一期（更早）" aria-label="上一期" disabled={at < 0 || at >= rows.length - 1}
              onClick={() => { setConfirm(false); void showReport(reportKind.value, rows[at + 1].period); }}><Icon name="chevron" class="flip" /></button>
          )}
          {rows.length > 0 && (
            <select class="report-period" value={reportPeriod.value ?? ''} aria-label="哪一期"
              onChange={(e) => { setConfirm(false); void showReport(reportKind.value, (e.currentTarget as HTMLSelectElement).value); }}>
              {rows.map((r) => <option key={r.period} value={r.period}>{rangeLabel(r.from, r.to)}</option>)}
            </select>
          )}
          {rows.length > 0 && (
            <button class="icon-btn" title="下一期（更新）" aria-label="下一期" disabled={at <= 0}
              onClick={() => { setConfirm(false); void showReport(reportKind.value, rows[at - 1].period); }}><Icon name="chevron" /></button>
          )}
          <span class="grow" />
          {vault && <a class="icon-btn" href={vault} title="在 Obsidian 里打开这一期"><Icon name="doc" /></a>}
          {latest && (
            <button class={cx('btn small', confirm && 'danger')} disabled={regenerating.value}
              title="重新挑选、分组并写导语（调用一次 AI，分组可能和现在不同）"
              onClick={() => { if (!confirm) { setConfirm(true); return; } setConfirm(false); void regenerate(); }}>
              {regenerating.value ? <span class="spinner sm" /> : confirm ? '确定重新生成？' : '重新生成'}
            </button>
          )}
        </div>
      </header>
      <div class="list-scroll" ref={setScroller}>
        {current.value && current.value.report.kind === reportKind.value
          ? <div class="report-frame"><Toc scroller={scroller} /><Body /></div>
          : !reportLoading.value && (
          <div class="empty"><Icon name="doc" size={28} />
            <p>{reportKind.value === 'daily' ? '还没有日报，每天 06:00 生成前一天的' : `还没有${KIND_LABEL[reportKind.value]}，每周一 06:00 生成上一周的`}</p>
          </div>
        )}
        {reportLoading.value && <div class="sentinel"><span class="spinner" /></div>}
      </div>
    </section>
  );
}
