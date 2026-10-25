import { app, tab, selection, select, isReports, catOpen, toggleCat, setTab, prefs, setPrefs, settingsOpen, editFeedId, navOpen, type Selection } from '../store.ts';
import type { Feed, ReportKind } from '../api.ts';
import { LAYOUTS, effectiveLayout, layoutLabel, type Tab } from '../layout.ts';
import { Icon, FeedIcon } from './Icon.tsx';
import { cx } from '../util.ts';
import { TasksButton } from './Tasks.tsx';
import { reportKind, loadReports } from '../reports.ts';
import { DEMO, FeatureMark } from '../demo/tour.tsx';

// The tabs are the display modes; a feed shows up under the mode it is displayed in. 时间线 is not
// among them: its sources are read under 动态, an entry below that takes them by type, not layout.
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'all', label: '全部', icon: 'inbox' },
  ...LAYOUTS.filter((l) => l.key !== 'social').map((l) => ({ key: l.key, label: l.label, icon: l.icon })),
];

const same = (a: Selection, b: Selection): boolean =>
  a.kind === b.kind && (a as { id?: number }).id === (b as { id?: number }).id && (a as { name?: string }).name === (b as { name?: string }).name;
// A report entry is lit on the reports page showing its kind; it opens that page on its kind.
const onReport = (k: ReportKind): boolean => selection.value.kind === 'reports' && reportKind.value === k;
function openReport(k: ReportKind): void {
  if (isReports.value) { void loadReports(k); return; }
  reportKind.value = k;
  void select({ kind: 'reports' });
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span class="count">{n > 999 ? '999+' : n}</span> : null;
}

function FeedRow({ f }: { f: Feed }) {
  const sel: Selection = { kind: 'feed', id: f.id };
  const broken = f.error_count >= 3;
  return (
    <li>
      <button class={cx('nav-item feed', same(selection.value, sel) && 'active', f.paused && 'muted')} onClick={() => select(sel)}
        title={broken ? `连续失败 ${f.error_count} 次：${f.last_error ?? ''}` : f.title}>
        <FeedIcon id={f.id} title={f.title} />
        <span class="label">{f.title}</span>
        {broken && <Icon name="alert" size={13} class="warn" />}
        <Count n={f.unread} />
        <span class="row-more" role="button" title="编辑源" onClick={(e) => { e.stopPropagation(); editFeedId.value = f.id; settingsOpen.value = 'feeds'; }}>
          <Icon name="more" size={14} />
        </span>
      </button>
    </li>
  );
}

export function Sidebar() {
  const a = app.value;
  if (!a) return <aside class="sidebar" />;
  const v = tab.value;
  const inTab = (f: Feed, k: Tab): boolean => k === 'all' || effectiveLayout(f, a.categories) === k;
  const feeds = a.feeds.filter((f) => inTab(f, v));
  const hideRead = prefs.value.unreadOnly;
  const byCat = new Map<number | null, Feed[]>();
  for (const f of feeds) {
    if (hideRead && f.unread === 0 && !same(selection.value, { kind: 'feed', id: f.id })) continue;
    byCat.set(f.category_id, [...(byCat.get(f.category_id) ?? []), f]);
  }
  const viewUnread = (k: Tab): number => a.feeds.filter((f) => inTab(f, k)).reduce((s, f) => s + f.unread, 0);
  const uncategorized = byCat.get(null) ?? [];
  const aiTags = a.tags.filter((t) => t.source === 'ai' || t.source === 'knn').slice(0, 20);

  return (
    <aside class={cx('sidebar', navOpen.value && 'open')}>
      <header class="brand">
        <button class="brand-home" title="首页" onClick={() => void select({ kind: 'home' })}>
          <img class="logo" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
          <span class="brand-name">Lumen</span>
        </button>
        <span class="brand-spacer" />
        <button class={cx('icon-btn', selection.value.kind === 'home' && 'on')} title="首页" aria-pressed={selection.value.kind === 'home'} onClick={() => void select({ kind: 'home' })}><Icon name="home" /></button>
        <button class="icon-btn" title="添加订阅" onClick={() => { settingsOpen.value = 'add'; }}><Icon name="plus" /></button>
        <button class="icon-btn" title="阅读画像" onClick={() => { settingsOpen.value = 'profile'; }}><Icon name="chart" /></button>
        <button class="icon-btn" title="设置" onClick={() => { settingsOpen.value = 'feeds'; }}><Icon name="settings" /></button>
      </header>

      <nav class="views" aria-label="显示方式">
        {TABS.map((t) => (
          <button key={t.key} class={cx('view-tab', v === t.key && 'active')} data-view={t.key} onClick={() => setTab(t.key)}
            title={`${t.label}（${a.feeds.filter((f) => inTab(f, t.key)).length} 个源）`}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
            {viewUnread(t.key) > 0 && <i class="dot" />}
          </button>
        ))}
      </nav>

      <div class="nav-scroll">
        <ul class="nav-group">
          <li>
            <button class={cx('nav-item', same(selection.value, { kind: 'all' }) && 'active')} onClick={() => select({ kind: 'all' })} title="订阅的全部文章，按所选的显示方式">
              <Icon name="inbox" /><span class="label">{v === 'all' ? '所有文章' : `所有${layoutLabel(v)}`}</span><Count n={viewUnread(v)} />
            </button>
          </li>
          <li>
            <button class={cx('nav-item', same(selection.value, { kind: 'starred' }) && 'active')} onClick={() => select({ kind: 'starred' })} title="加了星标的文章">
              <Icon name="star" /><span class="label">收藏</span><span class="count subtle">{a.totals.starred}</span>
            </button>
          </li>
        </ul>

        {/* Three groups, and in a group shortest name first (a short word is found fastest), ties by how
            often it is opened. 总结 is what is put together over a day or a week (the reports, the 书单's
            books), 学术 the feeds' research side, 友邻 what friends post and mark. The three reports are
            one page; each entry opens it on its kind. */}
        {v === 'all' && (
          <ul class="nav-group">
            <li class="nav-label" title="一天、一周整理出来的：日报、周报，书单里的新书">总结</li>
            <li>
              <button class={cx('nav-item', onReport('daily') && 'active')} onClick={() => openReport('daily')} title="AI 每天挑出值得看的文章，分组写导语">
                <Icon name="doc" /><span class="label">日报</span>{DEMO && <FeatureMark />}
              </button>
            </li>
            <li>
              <button class={cx('nav-item', onReport('weekly') && 'active')} onClick={() => openReport('weekly')} title="AI 每周挑出值得看的文章，分组写导语">
                <Icon name="doc" /><span class="label">周报</span>
              </button>
            </li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'books' }) && 'active')} onClick={() => select({ kind: 'books' })}
                title="书单推送里拆出的书，按出版月份排成封面墙">
                <Icon name="masonry" /><span class="label">新书</span>{DEMO && <FeatureMark />}
              </button>
            </li>
            <li class="nav-label" title="期刊目录、会议讲座征稿，和每周的论文周报">学术</li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'tocs' }) && 'active')} onClick={() => select({ kind: 'tocs' })}
                title="期刊公众号推送的每期目录，拆成栏目与篇目，带摘要的挂上摘要">
                <Icon name="contents" /><span class="label">期刊目录</span>{DEMO && <FeatureMark />}
              </button>
            </li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'notices' }) && 'active')} onClick={() => select({ kind: 'notices' })}
                title="推文里的会议、征稿、讲座、招聘、申报，按截止或举办日期排">
                <Icon name="calendar" /><span class="label">学术动态</span>{DEMO && <FeatureMark />}
              </button>
            </li>
            <li>
              <button class={cx('nav-item', onReport('papers') && 'active')} onClick={() => openReport('papers')} title="AI 每周把新论文按期刊、主题整理成一期">
                <Icon name="doc" /><span class="label">论文周报</span>
              </button>
            </li>
            <li class="nav-label" title="友邻的广播、书影音标记，和他们标得最多的书影">友邻</li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'social' }) && 'active')} onClick={() => select({ kind: 'social' })} title="豆瓣、微博等以人为主的源">
                <Icon name="social" /><span class="label">动态</span><Count n={a.feeds.filter((f) => f.view === 'social').reduce((s, f) => s + f.unread, 0)} />
              </button>
            </li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'marks' }) && 'active')} onClick={() => { if (!prefs.value.marksUnreadOnly) setPrefs({ marksUnreadOnly: true }); select({ kind: 'marks' }); }}
                title="豆瓣友邻的每一条想读、看过、在听，按书、影、音分开，带未读数">
                <Icon name="bookmark" /><span class="label">标记</span><Count n={a.marksUnread} />
              </button>
            </li>
            <li>
              <button class={cx('nav-item', same(selection.value, { kind: 'hot' }) && 'active')} onClick={() => select({ kind: 'hot' })}
                title="友邻近 30 天标得最多的书和影排成榜，旁边是豆瓣的公共榜单">
                <Icon name="chart" /><span class="label">书影榜</span>{DEMO && <FeatureMark />}
              </button>
            </li>
          </ul>
        )}

        {a.categories.map((c) => {
          const list = byCat.get(c.id);
          if (!list?.length) return null;
          const unread = list.reduce((s, f) => s + f.unread, 0);
          const sel: Selection = { kind: 'category', id: c.id };
          const open = catOpen(c.id);
          return (
            <section class="cat" key={c.id}>
              <div class={cx('nav-item cat-head', same(selection.value, sel) && 'active')}>
                <button class="chev" onClick={() => toggleCat(c.id)} aria-expanded={open} aria-label={open ? '折叠' : '展开'}>
                  <Icon name="chevron" size={13} class={cx('chev-icon', open && 'open')} />
                </button>
                <button class="cat-name" onClick={() => select(sel)}>{c.name}</button>
                <Count n={unread} />
              </div>
              {open && <ul>{list.map((f) => <FeedRow key={f.id} f={f} />)}</ul>}
            </section>
          );
        })}
        {uncategorized.length > 0 && (
          <section class="cat">
            <div class="nav-item cat-head static"><span class="cat-name">未分类</span></div>
            <ul>{uncategorized.map((f) => <FeedRow key={f.id} f={f} />)}</ul>
          </section>
        )}

        {aiTags.length > 0 && (
          <section class="cat tags">
            <div class="nav-item cat-head static"><span class="cat-name">AI 标签</span></div>
            <div class="tag-cloud">
              {aiTags.map((t) => (
                <button key={t.name} class={cx('chip', same(selection.value, { kind: 'tag', name: t.name }) && 'active')}
                  onClick={() => select({ kind: 'tag', name: t.name })}>
                  {t.name.replace(/^AI:/, '')}<small>{t.unread || ''}</small>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer class="side-foot">
        <span class="status">
          {a.fetching > 0 ? <><span class="pulse" />抓取中 · {a.fetching}</> : `${a.feeds.length} 个源`}
          {a.aiQueue > 0 && <> · AI 队列 {a.aiQueue}</>}
        </span>
        <TasksButton />
        <button class="icon-btn" title="切换主题" onClick={() => setPrefs({ theme: prefs.value.theme === 'dark' ? 'light' : prefs.value.theme === 'light' ? 'system' : 'dark' })}>
          <Icon name={prefs.value.theme === 'dark' ? 'moon' : 'sun'} />
        </button>
      </footer>
    </aside>
  );
}
