export type View = 'article' | 'social' | 'picture' | 'video' | 'audio';
export type Layout = 'list' | 'social' | 'cards' | 'masonry' | 'compact' | 'digest';

export interface Category { id: number; name: string; sort: number; layout: Layout | null; scroll_read: number | null }
export interface Feed {
  id: number; title: string; url: string; site_url: string | null; category_id: number | null; view: View; layout: Layout | null; scroll_read: number | null; ttl: number;
  dedupe: 'guid' | 'title'; ai_summary: number; ai_translate_title: number; ai_classify: number; fulltext: number; paused: number; noisy: number; quiet: number;
  last_ok_at: number; last_fetch_at: number; next_fetch_at: number; error_count: number; last_error: string | null; unread: number;
}
export interface TagCount { name: string; source: string; n: number; unread: number }
export interface Settings {
  host: string; webLogin: boolean;   // webLogin: devices other than this one sign in (server/auth.ts)
  defaultTtl: number; fetchConcurrency: number; perHostConcurrency: number; fetchTimeoutMs: number;
  proxy: string; noProxy: string[]; rsshubBase: string;
  wechat2rssBase: string; zoteroDb: string; ocrPython: string; ocrEngine: string;   // '' = Zotero's default place; OCR off
  updateCheck: boolean;              // once a day, ask GitHub whether a newer Lumen is out
  retention: { days: number; keepMinPerFeed: number; maxPerFeed: number };
  ai: { enabled: boolean; baseUrl: string; model: string; concurrency: number; maxInputChars: number; summaryMinChars: number; tagPrefix: string; allowedTags: string[] };
  embedding: { enabled: boolean; baseUrl: string; model: string; batchSize: number; intervalMs: number };
  translate: { enabled: boolean; model: string; minChars: number; maxChars: number; shareCards: boolean };
  clip: { vaultPath: string; pathTemplate: string; bodyTemplate: string; aiAnalysis: boolean; analysisModel: string; thinking: boolean;
    aiMetadata: boolean; downloadImages: boolean; imageFolder: string; tagLibrary: string; nameLibrary: string; authorsFolder: string; reportFolder: string };
}
export interface ClipResult { path: string; relPath: string; existed: boolean; analysis: 'queued' | 'off' | 'no-key' | 'skipped' }
export interface Job {
  id: number; kind: 'clip' | 'ai'; entryId: number; title: string; state: 'running' | 'done' | 'failed';
  step: string; startedAt: number; finishedAt?: number; error?: string; notePath?: string;
}
export interface JobsState { jobs: Job[]; aiQueue: number; fetching: number }
export interface AppState {
  categories: Category[]; feeds: Feed[]; tags: TagCount[];
  totals: { unread: number; starred: number; total: number };
  marksUnread: number; aiQueue: number; fetching: number; settings: Settings; hasAiKey: boolean; hasEmbeddingKey: boolean; translateError: string | null; apiUser: string; hasApiPassword: boolean;
  update?: UpdateInfo | null;        // a newer version found by the daily check or 检查更新 (server/api/update.ts)
  doubanSync?: boolean;   // 想读 also written to 豆瓣 (the author's install only, server/extras.ts)
  hasZotero?: boolean;    // a Zotero database was found, so 在库 can be told
}
export interface Mark { id: number; who: string; action: string; comment: string; published: number; is_read: number; link: string | null }
// 日报/周报/论文周报 (server/report/). period is the database key; pages name the dates.
export type ReportKind = 'papers' | 'weekly' | 'daily';
export interface ReportRow { kind: ReportKind; period: string; path: string | null; created: number; from: number; to: number; total: number }
export interface ReportPaper {
  id: number; title: string; authors: string; venue: string; abstract: string; via: 'journal' | 'repost'; abstractBy?: 'ai';
  link: string | null; feed: string; also: string[]; interest: number;
}
export interface PapersReport {
  kind: 'papers'; period: string; from: number; to: number; overview: string; total: number;
  picks: ReportPaper[]; groups: { name: string; summary: string; items: ReportPaper[] }[];
  journals: { feed: string; items: ReportPaper[] }[]; zotero: Record<number, boolean | null>;
}
export interface DailyItem { id: number; title: string; feed: string; link: string | null; lead: string; interest: number; read: boolean; kept: boolean; also: string[] }
export interface DailyReport {
  kind: 'daily'; period: string; from: number; to: number; overview: string; total: number; arrived: number;
  picks: DailyItem[]; groups: { name: string; summary: string; items: DailyItem[] }[];
  explore?: DailyItem | null;   // 破茧
}
export interface WeeklyReport {
  kind: 'weekly'; period: string; from: number; to: number; overview: string; total: number; dailies: string[];
  threads: { name: string; summary: string; days: string[]; items: DailyItem[]; more: number }[];
  stats: { arrived: number; completed: number; skimmed: number; starred: number; liked: number; topFeeds: { feed: string; opened: number }[] };
  hot?: { book: HotPick[]; movie: HotPick[] };
}
export interface HotPick { subject: string; title: string; people: number; who: string; isNew: boolean }
export type AnyReport = PapersReport | DailyReport | WeeklyReport;
export type EntryState = { read: boolean; starred: boolean } | null;

export interface Comment { who: string; text: string; time: number; likes: number; rating?: number; replies: Comment[] }
export interface Comments { source: string; url: string; total: number; comments: Comment[]; fetchedAt: number; stale?: string }
export interface SubjectMarks { kind: MarkGroup['kind']; id: string; title: string; url: string; cover: string | null; info: string; marks: Mark[] }
export interface MarkGroup {
  key: string; kind: 'book' | 'movie' | 'music' | 'game' | 'other'; title: string; url: string | null;
  cover: string | null; info: string; people: number; unread: number; latest: number; marks: Mark[];
  subject: string | null; wished: boolean;
}
// 热点 (server/report/hot.ts).
export type HotKind = 'book' | 'movie';
export interface HotItem {
  kind: HotKind; subject: string; title: string; cover: string | null; info: string; rating: number | null;
  people: number; score: number; marks: { who: string; action: string; published: number }[];
  since: number | null; isNew: boolean; lists: string[]; mine: string | null; wished: boolean; intro?: string;
}
export interface HotPage { book: { friends: HotItem[]; lists: HotItem[] }; movie: { friends: HotItem[]; lists: HotItem[] }; fetched: number | null }
export interface Edition { subject: string; publisher: string; year: string; rating: number | null; readers: number }
// 书影音标记's foreign texts → their Chinese so far (server/ai/snippets.ts); trAt: the server's time then (s).
export interface Translated { tr: Record<string, string>; trAt: number }
export interface Editions { works: string | null; total: number; editions: Edition[]; wished: boolean; page: SubjectPage | null }
// A 豆瓣 subject page as read (server/content/douban.ts).
export interface ShortComment { who: string; stars: number | null; time: string; text: string; votes: number }
export interface Similar { subject: string; title: string; cover: string | null; rating: number | null }
export interface SubjectPage {
  v: number; title: string; cover: string | null; fields: [string, string][];
  rating: number | null; votes: number; doing: number; done: number; wish: number;
  intro: string[]; authorIntro: string[]; toc: string[];
  comments: ShortComment[]; commentTotal: number; reviewTotal: number; similar: Similar[];
}
// A film's or series' page (server/content/doubanmovie.ts).
export interface MoviePage {
  v: number; kind: 'movie'; title: string; original: string; aka: string[]; year: string; cover: string | null;
  pubdate: string[]; durations: string[]; countries: string[]; languages: string[]; genres: string[];
  directors: string[]; actors: string[]; isTv: boolean; episodes: number; rating: number | null; votes: number;
  intro: string[]; comments: ShortComment[]; commentTotal: number; reviewTotal: number; similar: Similar[];
}
export interface Enclosure { url: string; type: string; length?: number }
export interface ListItem {
  id: number; feed_id: number; title: string; title_zh: string | null; author: string | null; link: string | null;
  published: number; is_read: number; is_starred: number; thumbnail: string | null; enclosures: string | null;
  snippet: string; has_summary: number; is_mark: number; images?: string[];
  rec?: RecInfo;                     // only in the 推荐 order
  pages?: PageOf[];                  // the pages built out of it (server/content/destinations.ts)
  hit?: boolean;                     // a search result: the snippet is the text around a term
}
export type PageOf = 'notices' | 'tocs' | 'books';
export interface RecInfo { reasons: string[]; explore?: boolean }
export interface RecMeta { coldStart: boolean; signals: number; needed: number }
export interface RecCluster {
  anchor: number; name: string | null; hidden: boolean; polarity: 'pos' | 'neg';
  size: number; feeds: number; weight: number; maturity: number; samples: { id: number; title: string }[];
}
export interface RecProfile {
  coldStart: boolean; signals: number; needed: number; threshold: number; hasRecent: boolean;
  clusters: RecCluster[]; keywords?: string[]; compare: { mode: string; opened: number; completed: number }[];
}
export type Reaction = 'like' | 'less_topic' | 'less_source';
export interface EntryDetail extends ListItem {
  reaction?: Reaction | null;
  content: string | null; content_full: string | null; ai_summary: string | null; ai_state: number;
  feed_title: string; feed_site: string | null; view: View; tags: { name: string; source: string }[];
  // server/ai/translate.ts: content_tr pairs each foreign block of the tr_of body with its translation.
  tr_state?: number | null; content_tr?: string | null; tr_of?: 'full' | 'feed' | null; tr_note?: string | null;
  comment_source?: string | null;   // which site's 评论区 this entry can show
  loading?: boolean;        // client-side placeholder while the full entry is on its way
}

export interface ProfileStats {
  days: number; signals: number; bulkRead: number;
  byType: { type: string; n: number }[];
  feeds: { id: number; title: string; score: number; views: number; bounces: number }[];
  recent: { entryId: number; title: string; feed: string; type: string; at: number }[];
}

export interface EmbedStatus {
  enabled: boolean; model: string; done: number; pending: number; lastError: string | null; pausedUntil: number;
  background?: { n: number; p50: number; p95: number; p99: number };
}
export interface RelatedItem extends ListItem { feed_title: string; sim: number; sameStory: boolean }
// A book a 书单 post lists. isbn '' when the post prints none; subject: its 豆瓣 id when known;
// inZotero null when Zotero's database could not be read; wished: 想读 marked from Lumen.
export interface ListedBook { title: string; cover: string | null; authors: string; translators: string; publisher: string; date: string;
  isbn: string; subject: string | null; price: string; blurb: string; inZotero: boolean | null; wished: boolean }
// The post a book in 新书 was listed by.
export interface BookFrom { id: number; title: string; feed: string; feedId: number; published?: number }
// posts: how many 书单 listed it; month: its section when 新书 is ordered by date.
// 人大复印 on a book: an article naming it in 《》, or one by its author (server reprints.ts).
export interface BookReprint { review?: { title: string; label: string }; author?: { name: string; title: string; label: string } }
export interface NewBook { book: ListedBook; from: BookFrom; posts: number; month?: string; shelf?: string; topic: string | null; kind: string | null; reprint?: BookReprint }
// A month's shelf in 新书 (server bookshelves.ts): its name, its count, the 主题 on it.
export interface Shelf { label: string; n: number; topics: string[] }
export interface MonthCount extends Count { shelves?: Shelf[] }
export interface Count { label: string; n: number; group?: string }
// 期刊目录 and 学术动态: what the AI read out of a post (server/content/tocs.ts, notices.ts).
export interface PostRef { id: number; title: string; feedId: number; feed: string; published: number; link: string | null; image?: string | null }
export interface TocArticle { title: string; subtitle: string; authors: string[]; translators: string[]; page: string; abstract: string; keywords: string[]; link?: string; lead?: boolean; abstractFrom?: 'cnki'; reprint?: string; reprintOf?: string }
export interface TocIssue {
  key: string; source: 'post' | 'cnki' | 'reprint'; journal: string; issue: string; sections: { name: string; articles: TocArticle[] }[];
  at: number; post: PostRef | null; feed: { id: number; title: string } | null; link: string; inferred: boolean; partial: boolean; articles: number;
}
export type TocSource = '' | 'post' | 'cnki' | 'reprint';
export type NoticeKind = '会议' | '征稿' | '讲座' | '招聘' | '申报' | '征集' | '活动';
export interface Replay { bvid: string; title: string; author: string; at: number; minutes: number }
export interface Notice {
  kind: NoticeKind; name: string; date: string; end: string; deadline: string; place: string; organizer: string; speakers: string[];
  contact: string; summary: string; online: '' | '线上' | '线上线下'; live: string; replays: Replay[];
  status: 'upcoming' | 'open' | 'recorded' | 'past'; next: { what: '截止' | '举办' | '进行中'; date: string } | null; post: PostRef; posts: number;
  own?: { id: number; image: string | null } | null;   // the post about it alone, for its pictures; null: only roundups
  access?: { meeting: string; links: { label: string; url: string }[] };   // how to get in, for what is online and still to come
}
export interface UpdateInfo { current: string; latest: string | null; newer: boolean; url: string; error?: string }
export interface NoticesPage { items: Notice[]; kinds: Count[]; past: number; online: number; reading: number; stalled: boolean }
// sorting: books whose 类型 and 主题 the AI is still working out; dating: books whose date is being looked up on 豆瓣.

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-lumen': '1', ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // The login ran out (or the password changed) on a device that has to sign in: back to the login page.
  if (res.status === 401 && path !== '/api/logout') location.href = '/login';
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `请求失败 (${res.status})`);
  return data as T;
}

export interface Scope { view?: View; layout?: Layout; feed?: number; category?: number; tag?: string; filter: 'all' | 'unread' | 'starred'; q?: string;
  snippet?: 'long'; since?: number; kept?: 'starred' | 'archived' }

const qs = (o: Record<string, unknown>): string =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, String(v)])).toString();

export interface DiscoverCandidate { url: string; title: string; items: number | null; view: View; kind?: string; error?: string; subscribed?: boolean }

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  entries: (s: Scope, before?: string, limit = 40) => call<{ items: ListItem[] }>('GET', `/api/entries?${qs({ ...s, before, limit })}`),
  recommended: (s: Scope, offset: number, limit = 40) =>
    call<{ items: ListItem[]; meta: RecMeta; total: number }>('GET', `/api/entries?${qs({ ...s, sort: 'rec', offset, limit })}`),
  searched: (s: Scope, offset: number, limit = 40) =>
    call<{ items: ListItem[] }>('GET', `/api/entries?${qs({ ...s, sort: 'relevance', offset, limit })}`),
  semantic: (s: Scope, offset: number, limit = 40) =>
    call<{ items: ListItem[] }>('GET', `/api/entries?${qs({ ...s, sort: 'semantic', offset, limit })}`),
  recProfile: () => call<RecProfile>('GET', '/api/rec/profile'),
  updateCluster: (anchor: number, patch: { name?: string | null; hidden?: boolean }) => call<{ ok: true }>('PUT', `/api/rec/clusters/${anchor}`, patch),
  entry: (id: number) => call<EntryDetail>('GET', `/api/entries/${id}`),
  mark: (ids: number[], patch: { read?: boolean; starred?: boolean }) => call('POST', '/api/entries/mark', { ids, ...patch }),
  markAll: (s: Scope, upTo?: number) => call<{ count: number }>('POST', '/api/entries/mark-all', { ...s, upTo }),
  translate: (id: number, source: 'full' | 'feed') => call<EntryDetail>('POST', `/api/entries/${id}/translate`, { source }),
  ai: (id: number, tasks: { summary?: boolean; title?: boolean; classify?: boolean; fulltext?: boolean }) => call<EntryDetail>('POST', `/api/entries/${id}/ai`, tasks),
  clip: (id: number, selectedText: string) => call<ClipResult>('POST', `/api/entries/${id}/clip`, { selectedText }),
  discover: (url: string) => call<{ candidates: DiscoverCandidate[] }>('POST', '/api/feeds/discover', { url }),
  addFeed: (f: { url: string; title?: string; category_id?: number | null; view?: View }) => call<{ id: number; fetch: { ok: boolean; added: number; error?: string } }>('POST', '/api/feeds', f),
  updateFeed: (id: number, patch: Partial<Feed>) => call('PATCH', `/api/feeds/${id}`, patch),
  deleteFeed: (id: number) => call('DELETE', `/api/feeds/${id}`),
  refreshFeed: (id: number) => call<{ ok: boolean; added: number; error?: string }>('POST', `/api/feeds/${id}/refresh`),
  refreshAll: () => call('POST', '/api/refresh'),
  addCategory: (name: string) => call<{ id: number }>('POST', '/api/categories', { name }),
  updateCategory: (id: number, patch: { name?: string; sort?: number; layout?: Layout | null; scroll_read?: number | null }) => call('PATCH', `/api/categories/${id}`, patch),
  deleteCategory: (id: number) => call('DELETE', `/api/categories/${id}`),
  importOpml: (xml: string) => call<{ added: number; skipped: number }>('POST', '/api/opml', xml, true),
  reports: () => call<{ reports: ReportRow[] }>('GET', '/api/reports'),
  report: (kind: ReportKind, period: string) => call<{ report: AnyReport; path: string | null; state: Record<number, EntryState>; reprints?: Record<number, string> }>('GET', `/api/reports/${kind}/${encodeURIComponent(period)}`),
  runReports: (kind: ReportKind) => call<{ busy: boolean; results: { kind: ReportKind; period: string; path: string; built: boolean; note?: string }[] }>('POST', '/api/reports/run', { ifDue: false, kinds: [kind] }),
  comments: (id: number, refresh = false) => call<Comments>('GET', `/api/entries/${id}/comments${refresh ? '?refresh=1' : ''}`),
  friends: (id: number) => call<{ subjects: SubjectMarks[] }>('GET', `/api/entries/${id}/friends`),
  movie: (subject: string) => call<{ page: MoviePage; wished: boolean; error?: string } & Translated>('GET', `/api/douban/movie/${subject}`),
  editions: (subject: string) => call<Editions & { error?: string } & Translated>('GET', `/api/douban/editions/${subject}`),
  snippets: (since: number) => call<Translated>('GET', `/api/snippets?since=${since}`),
  hot: () => call<HotPage & Translated>('GET', '/api/hot'),
  hotRefresh: () => call<HotPage & Translated>('POST', '/api/hot/refresh'),
  doubanWish: (kind: 'book' | 'movie', subject: string) => call<{ ok: true; synced: boolean }>('POST', '/api/douban/wish', { kind, subject }),
  marks: (filter: 'unread' | 'all') => call<{ groups: MarkGroup[] } & Translated>('GET', `/api/marks?filter=${filter}`),
  marksRead: (upTo?: number) => call<{ count: number }>('POST', '/api/marks/read', { upTo }),
  reaction: (id: number, reaction: Reaction | null) => call('POST', `/api/entries/${id}/reaction`, { reaction }),
  profileStats: (days = 30) => call<ProfileStats>('GET', `/api/profile/stats?days=${days}`),
  digest: (ids: number[]) => call<{ summary: string; cached: boolean }>('POST', '/api/digest', { ids }),
  jobs: () => call<JobsState>('GET', '/api/jobs'),
  clearJobs: () => call('DELETE', '/api/jobs'),
  models: () => call<{ models: string[] }>('GET', '/api/ai/models'),
  embeddingStatus: (calibrate = false) => call<EmbedStatus>('GET', `/api/embedding/status${calibrate ? '?calibrate=1' : ''}`),
  embeddingTest: () => call<{ ok: boolean; dim: number }>('POST', '/api/embedding/test'),
  share: (id: string) => call<import('./share/data.ts').ShareData>('GET', `/api/share/${encodeURIComponent(id)}`),
  related: (id: number) => call<{ ready: boolean; items: RelatedItem[] }>('GET', `/api/entries/${id}/related`),
  books: (id: number) => call<{ books: ListedBook[]; pending: boolean; error?: string }>('GET', `/api/entries/${id}/books`),
  update: () => call<UpdateInfo>('GET', '/api/update'),
  pictures: (id: number, limit: number) => call<{ urls: string[]; reading?: boolean }>('GET', `/api/entries/${id}/pictures?limit=${limit}`),
  newBooks: (q: { offset: number; limit?: number; byDate: boolean; recentMonths: number; notOwned: boolean; topic: string; kind: string; shelves: boolean; reprintsAll?: boolean }) =>
    call<{ books: NewBook[]; total: number; posts: number; months?: MonthCount[]; topics: Count[]; kinds: Count[]; sorting: number; dating: number }>('GET',
      `/api/books?offset=${q.offset}${q.limit ? `&limit=${q.limit}` : ''}&sort=${q.byDate ? 'date' : 'post'}&recent=${q.recentMonths}&notOwned=${q.notOwned ? 1 : 0}&topic=${encodeURIComponent(q.topic)}&kind=${encodeURIComponent(q.kind)}${q.reprintsAll ? '&reprints=all' : ''}${q.shelves ? '&shelves=1' : ''}`),
  tocs: (q: { offset: number; journal: string; group?: string; source?: TocSource; reprintsAll?: boolean }) =>
    call<{ issues: TocIssue[]; total: number; journals: Count[]; sources: Count[]; reading: number; stalled: boolean }>('GET', `/api/tocs?offset=${q.offset}&journal=${encodeURIComponent(q.journal)}&group=${encodeURIComponent(q.group ?? '')}&source=${q.source ?? ''}${q.reprintsAll ? '&reprints=all' : ''}`),
  notices: (q: { kind: string; past: boolean; online: boolean }) =>
    call<NoticesPage>('GET', `/api/notices?kind=${encodeURIComponent(q.kind)}&past=${q.past ? 1 : 0}&online=${q.online ? 1 : 0}`),
  bookDetails: (b: Pick<ListedBook, 'title' | 'isbn'>) =>
    call<Partial<Pick<ListedBook, 'cover' | 'date' | 'authors' | 'publisher' | 'subject'>> & { fetched?: boolean; error?: string }>('GET', `/api/books/details?title=${encodeURIComponent(b.title)}&isbn=${encodeURIComponent(b.isbn)}`),
  wish: (b: Pick<ListedBook, 'title' | 'isbn' | 'subject'>) => call<{ ok: boolean; subject: string; synced: boolean }>('POST', '/api/books/wish', { title: b.title, isbn: b.isbn, subject: b.subject }),
  logout: () => call<{ ok: boolean }>('POST', '/api/logout'),
  saveSettings: (b: { settings?: Partial<Settings>; aiApiKey?: string; embeddingApiKey?: string; apiPassword?: string; apiUser?: string }) => call('PUT', '/api/settings', b),
};
