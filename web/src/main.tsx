import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { effect, signal } from '@preact/signals';
import './styles.css';
import { TOKEN_NAMES, tokensOf, paletteOf, DEFAULT_PALETTE } from './themes.ts';
import { app, prefs, detail, isReports, isMarks, markGroups, selectedMark, subjectTrail, marksBack, marksHome, boardOpen, selectedId, items, toast, settingsOpen, viewMode, refreshState, reloadList, connectEvents, openFromHash,
  step, setRead, toggleStar, toggleReaction, markAllRead, markAboveRead, runAi, clipToObsidian, quickShare, cycleTranslation, share, notify, navOpen } from './store.ts';
import { Icon } from './components/Icon.tsx';
import { ShareDialog } from './share/ShareDialog.tsx';
import { SharePage } from './share/SharePage.tsx';
import { api } from './api.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { EntryList } from './components/EntryList.tsx';
import { Reader } from './components/Reader.tsx';
import { SettingsModal } from './components/Settings.tsx';
import { TasksPanel } from './components/Tasks.tsx';
import { cx, safeLink } from './util.ts';
import { loadWebExtras } from './extras.ts';

effect(() => {
  const t = prefs.value.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
});

// 配色: a palette other than the default (纸墨, already in styles.css) overrides the colour tokens inline, for whichever of its light
// and dark sides the 明暗 setting (or the system, under 跟随系统) asks for.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const systemIsDark = signal(systemDark.matches);
systemDark.addEventListener('change', (e) => { systemIsDark.value = e.matches; });
effect(() => {
  const { theme } = prefs.value;
  const palette = paletteOf(prefs.value.palette).key;
  const root = document.documentElement.style;
  for (const name of TOKEN_NAMES) root.removeProperty(name);
  if (palette === DEFAULT_PALETTE) return;
  const dark = theme === 'dark' || (theme === 'system' && systemIsDark.value);
  for (const [name, value] of Object.entries(tokensOf(palette, dark))) root.setProperty(name, value);
});

function current() {
  return detail.value ?? items.value.find((i) => i.id === selectedId.value) ?? null;
}

// What Space opens: in 书影音标记, the 豆瓣 page of the card that is open; elsewhere the article.
function openLink(): string | null {
  if (isMarks.value) {
    const sub = subjectTrail.value.at(-1);
    return sub ? `https://${sub.kind}.douban.com/subject/${sub.subject}/` : selectedMark.value ? safeLink(markGroups.value.find((g) => g.key === selectedMark.value)?.url) : safeLink(boardOpen.value?.url);
  }
  return safeLink(current()?.link);
}

// Shortcuts follow the FreshRSS bindings the user already has in muscle memory.
function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement;
  if (settingsOpen.value || share.value || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) {
    if (e.key === 'Escape' && t.tagName === 'INPUT') t.blur();
    return;
  }
  const it = current();
  switch (e.key) {
    case 'j': case 'ArrowDown': step(1); break;
    case 'k': case 'ArrowUp': step(-1); break;
    case 'r': case 'm': if (it) void setRead(it, !it.is_read); break;
    case 'f': case 's': if (it) void toggleStar(it); break;
    case ' ': case 'o': case 'Enter': { const link = openLink(); if (link) window.open(link, '_blank', 'noopener'); break; }
    case 'q': void api.refreshAll().then(() => refreshState()); break;
    case 'A': if (e.shiftKey) void markAllRead(); break;
    case 'K': if (e.shiftKey) void markAboveRead(); break;
    case 'v': void runAi({ fulltext: true }); break;
    case 'c': void clipToObsidian(); break;
    case 'l': void toggleReaction('like'); break;
    case 'x': void toggleReaction('less_topic'); break;
    case 'X': void toggleReaction('less_source'); break;
    case 'p': void quickShare(); break;
    case 't': cycleTranslation(); break;
    case 'h': if (!isMarks.value) return; marksHome(); break;
    case '/': document.getElementById('search')?.focus(); break;
    case 'Escape': case 'Backspace':
      if (e.key === 'Escape' && navOpen.value) { navOpen.value = false; break; }
      if (isMarks.value) { if (!marksBack()) return; break; }
      if (e.key === 'Backspace') return;
      if (viewMode.value === 'grid' || isReports.value) { detail.value = null; selectedId.value = null; }
      break;
    default: return;
  }
  e.preventDefault();
}

function App() {
  useEffect(() => {
    void refreshState().then(openFromHash);
    void reloadList();
    connectEvents();
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', openFromHash);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', openFromHash); };
  }, []);

  const grid = viewMode.value === 'grid';
  // Wide layouts use the whole width; with an article open they move left beside the reader.
  const split = grid && !!detail.value;
  return (
    <div class={cx('shell', isReports.value ? (detail.value ? 'shell-report' : 'shell-grid') : grid && (split ? 'shell-split' : 'shell-grid'), !app.value && 'booting')}>
      <Sidebar />
      <button class="nav-toggle" title="导航" aria-label="打开导航" aria-expanded={navOpen.value} onClick={() => { navOpen.value = true; }}><Icon name="menu" /></button>
      {navOpen.value && <div class="nav-back" onClick={() => { navOpen.value = false; }} />}
      <EntryList />
      <Reader />
      <SettingsModal />
      <TasksPanel />
      {share.value && <ShareDialog data={share.value.data} initial={share.value.style} notify={notify} onClose={() => { share.value = null; }} />}
      {toast.value && (
        <div class={cx('toast', toast.value.error && 'error')} role="status">
          {toast.value.text}
          {toast.value.action && <button class="toast-action" onClick={() => { const a = toast.value?.action; toast.value = null; a?.run(); }}>{toast.value.action.label}</button>}
        </div>
      )}
    </div>
  );
}

// The static demo answers the API in the page; it has to be in place before the first request.
if (import.meta.env.VITE_DEMO) (await import('./demo/mock.ts')).installDemo();
await loadWebExtras();

// /share/<id>: the card for a web page sent by the browser extension.
const shareId = location.pathname.match(/^\/share\/([\w-]+)$/)?.[1];
render(shareId ? <SharePage id={shareId} /> : <App />, document.getElementById('app')!);
// The demo's tour sits over the page, apart from the app.
if (import.meta.env.VITE_DEMO && !shareId) {
  const { TourOverlay } = await import('./demo/tour.tsx');
  const host = document.body.appendChild(document.createElement('div'));
  render(<TourOverlay />, host);
}
