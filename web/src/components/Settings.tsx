import { useState, useEffect } from 'preact/hooks';
import { app, settingsOpen, editFeedId, refreshState, notify, reloadList, prefs, setPrefs, catOpen, toggleCat, type TrView } from '../store.ts';
import { api, type Feed, type View, type Layout, type EmbedStatus, type DiscoverCandidate } from '../api.ts';
import { LAYOUTS } from '../layout.ts';
import { Icon, FeedIcon } from './Icon.tsx';
import { ProfileTab } from './Profile.tsx';
import { ago, cx } from '../util.ts';
import { PALETTES, paletteOf, type Palette } from '../themes.ts';

const VIEW_LABEL: Record<View, string> = { article: '文章', social: '动态', picture: '图片', video: '视频', audio: '音频' };
const TTL_OPTIONS = [[0, '默认'], [1800, '30 分钟'], [3600, '1 小时'], [10800, '3 小时'], [43200, '12 小时'], [86400, '1 天']] as const;
type Tab = 'feeds' | 'add' | 'ai' | 'clip' | 'fetch' | 'data' | 'look' | 'profile';

async function act(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  try { await fn(); if (ok) notify(ok); await refreshState(); return true; } catch (e) { notify((e as Error).message, true); return false; }
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span class="track" /><span>{label}</span>
    </label>
  );
}

function FeedEditor({ f, onClose }: { f: Feed; onClose: () => void }) {
  const cats = app.value?.categories ?? [];
  const [title, setTitle] = useState(f.title);
  const [url, setUrl] = useState(f.url);
  const patch = (p: Partial<Feed>): void => void act(() => api.updateFeed(f.id, p));
  return (
    <div class="feed-editor">
      <header>
        <FeedIcon id={f.id} title={f.title} size={28} />
        <div class="grow">
          <input class="input title-input" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
            onBlur={() => title !== f.title && patch({ title })} />
          <input class="input mono" value={url} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)}
            onBlur={() => url !== f.url && patch({ url })} />
        </div>
        <button class="icon-btn" onClick={onClose} title="收起"><Icon name="x" /></button>
      </header>
      <div class="editor-grid">
        <label>分类<select value={f.category_id ?? ''} onChange={(e) => patch({ category_id: Number((e.currentTarget as HTMLSelectElement).value) || null })}>
          <option value="">未分类</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label>类型<select value={f.view} onChange={(e) => patch({ view: (e.currentTarget as HTMLSelectElement).value as View })}>
          {Object.entries(VIEW_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>显示方式<select value={f.layout ?? ''} onChange={(e) => patch({ layout: ((e.currentTarget as HTMLSelectElement).value || null) as Layout | null })}>
          <option value="">跟随分类或类型</option>{LAYOUTS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select></label>
        <label>滚过即读<select value={f.scroll_read === null ? '' : String(f.scroll_read)}
          onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; patch({ scroll_read: v === '' ? null : Number(v) }); }}>
          <option value="">跟随分类</option><option value="1">开</option><option value="0">关</option>
        </select></label>
        <label>抓取间隔<select value={f.ttl} onChange={(e) => patch({ ttl: Number((e.currentTarget as HTMLSelectElement).value) })}>
          {TTL_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
        <label>去重<select value={f.dedupe} onChange={(e) => patch({ dedupe: (e.currentTarget as HTMLSelectElement).value as Feed['dedupe'] })}>
          <option value="guid">按条目 ID</option><option value="title">按标题（CNKI 用）</option>
        </select></label>
      </div>
      <div class="toggles">
        <Toggle on={!!f.ai_summary} label="AI 摘要" onChange={(v) => patch({ ai_summary: +v })} />
        <Toggle on={!!f.ai_translate_title} label="翻译标题" onChange={(v) => patch({ ai_translate_title: +v })} />
        <Toggle on={!!f.ai_classify} label="AI 分类" onChange={(v) => patch({ ai_classify: +v })} />
        <Toggle on={!!f.fulltext} label="抓全文" onChange={(v) => patch({ fulltext: +v })} />
        <Toggle on={!!f.paused} label="暂停" onChange={(v) => patch({ paused: +v })} />
        <Toggle on={!!f.noisy} label="噪声源（只留 90 天）" onChange={(v) => patch({ noisy: +v })} />
        <Toggle on={!!f.quiet} label="到达即已读（照常抓取，不计未读）" onChange={(v) => patch({ quiet: +v })} />
      </div>
      <p class="feed-status">
        {f.error_count > 0 ? <span class="bad">连续失败 {f.error_count} 次：{f.last_error}</span> : <span class="good">正常</span>}
        {f.last_ok_at > 0 && <> · 上次成功 {ago(f.last_ok_at)}</>}
        {f.next_fetch_at > 0 && !f.paused && <> · 下次 {new Date(f.next_fetch_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</>}
      </p>
      <div class="row-actions">
        <button class="btn" onClick={() => void act(async () => {
          const r = await api.refreshFeed(f.id);
          if (!r.ok) throw new Error(r.error ?? '抓取失败');
          notify(`抓取成功，新增 ${r.added} 篇`); void reloadList();
        })}><Icon name="refresh" size={14} />立即抓取</button>
        <span class="grow" />
        <button class="btn danger" onClick={() => {
          if (window.prompt(`删除「${f.title}」及其文章？学术动态、期刊目录、新书用到的推文和收藏、存档的会留下。输入 删除 确认`) !== '删除') return;
          void act(async () => {
            const r = await api.deleteFeed(f.id) as { kept?: number };
            notify(r.kept ? `已删除，留下 ${r.kept} 篇（学术动态、新书、收藏等用到的）` : '已删除');
          }).then(onClose);
        }}><Icon name="trash" size={14} />删除</button>
      </div>
    </div>
  );
}

function FeedsTab() {
  const a = app.value!;
  const [filter, setFilter] = useState<'all' | 'error' | 'paused'>('all');
  const [q, setQ] = useState('');
  const editing = editFeedId.value;
  const list = a.feeds.filter((f) =>
    (filter === 'all' || (filter === 'error' ? f.error_count > 0 : !!f.paused)) &&
    (!q || f.title.toLowerCase().includes(q.toLowerCase()) || f.url.includes(q)));
  const errors = a.feeds.filter((f) => f.error_count > 0).length;
  const cat = (id: number | null): string => a.categories.find((c) => c.id === id)?.name ?? '未分类';
  return (
    <div class="tab-body">
      <div class="toolbar">
        <input class="input" placeholder="搜索源名或地址" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        <div class="seg">
          <button class={cx(filter === 'all' && 'on')} onClick={() => setFilter('all')}>全部 {a.feeds.length}</button>
          <button class={cx(filter === 'error' && 'on')} onClick={() => setFilter('error')}>出错 {errors}</button>
          <button class={cx(filter === 'paused' && 'on')} onClick={() => setFilter('paused')}>已暂停</button>
        </div>
        {filter === 'error' && errors > 0 && (
          <button class="btn" onClick={() => void act(async () => {
            for (const f of list) await api.refreshFeed(f.id);
          }, '已重试出错的源')}>全部重试</button>
        )}
      </div>
      <ul class="feed-table">
        {list.map((f) => (
          <li key={f.id} class={cx(editing === f.id && 'open')}>
            {editing === f.id ? <FeedEditor f={f} onClose={() => { editFeedId.value = null; }} /> : (
              <button class="feed-line" onClick={() => { editFeedId.value = f.id; }}>
                <FeedIcon id={f.id} title={f.title} size={18} />
                <span class="ft-title">{f.title}</span>
                <span class="ft-cat">{cat(f.category_id)}</span>
                <span class="ft-view">{VIEW_LABEL[f.view]}</span>
                <span class="ft-flags">{f.ai_summary ? '摘' : ''}{f.ai_translate_title ? '译' : ''}{f.fulltext ? '全' : ''}</span>
                <span class={cx('ft-state', f.error_count ? 'bad' : f.paused ? 'muted' : 'good')} title={f.last_error ?? ''}>
                  {f.paused ? '暂停' : f.error_count ? `✕ ${f.last_error?.slice(0, 24) ?? ''}` : f.last_ok_at ? ago(f.last_ok_at) : '待抓取'}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddTab() {
  const cats = app.value?.categories ?? [];
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [cands, setCands] = useState<DiscoverCandidate[]>([]);
  const [cat, setCat] = useState<number | null>(null);
  const [newCat, setNewCat] = useState('');
  const discover = async (): Promise<void> => {
    setBusy(true); setCands([]);
    try { setCands((await api.discover(url.trim())).candidates); } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };
  const add = async (c: (typeof cands)[number]): Promise<void> => {
    setBusy(true);
    try {
      let category = cat;
      if (newCat.trim()) category = (await api.addCategory(newCat.trim())).id;
      const r = await api.addFeed({ url: c.url, title: c.title, category_id: category, view: c.view });
      notify(r.fetch.ok ? `已订阅，抓到 ${r.fetch.added} 篇` : `已订阅，但首次抓取失败：${r.fetch.error}`, !r.fetch.ok);
      setUrl(''); setCands([]); setNewCat('');
      await refreshState(); void reloadList();
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div class="tab-body narrow">
      <p class="lead">粘贴 RSS 地址、网站首页，或平台页面链接（公众号文章、豆瓣主页、微博、B站空间、小宇宙播客、知网期刊页），会认出是哪类源并换成订阅地址。RSSHub 路由可以写成 <code>rsshub://douban/people/ID/status</code>，实际地址按「抓取」页的 RSSHub 地址拼。</p>
      <form class="add-form" onSubmit={(e) => { e.preventDefault(); void discover(); }}>
        <input class="input big" autoFocus placeholder="https://… 或 rsshub://…" value={url} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} />
        <button class="btn primary" disabled={busy || !url.trim()}>{busy ? <span class="spinner sm" /> : '查找'}</button>
      </form>
      {cands.length > 0 && (
        <>
          <div class="editor-grid">
            <label>放进分类<select value={cat ?? ''} onChange={(e) => setCat(Number((e.currentTarget as HTMLSelectElement).value) || null)}>
              <option value="">未分类</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
            <label>或新建分类<input class="input" value={newCat} placeholder="分类名" onInput={(e) => setNewCat((e.currentTarget as HTMLInputElement).value)} /></label>
          </div>
          <ul class="cands">
            {cands.map((c) => (
              <li key={c.url}>
                <div class="grow"><strong>{c.title}</strong><span class="mono small">{c.url}</span>
                  <span class="small muted">{c.kind ? `${c.kind} · ` : ''}{c.items !== null ? `${c.items} 篇 · ` : ''}{VIEW_LABEL[c.view]}{c.error ? ` · 抓不到（${c.error}）` : ''}</span></div>
                <button class="btn primary" disabled={busy || c.subscribed || !!c.error} onClick={() => void add(c)}>{c.subscribed ? '已订阅' : '订阅'}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Free-text model field with suggestions fetched from the saved interface's /models.
function ModelPicker({ value, onChange, id, placeholder }: { value: string; onChange: (v: string) => void; id: string; placeholder?: string }) {
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pull = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.models();
      setModels(r.models);
      notify(r.models.length ? `拉取到 ${r.models.length} 个模型` : '接口没有返回模型');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="model-picker">
      <input class="input mono" list={id} value={value} placeholder={placeholder} onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)} />
      <datalist id={id}>{models.map((m) => <option key={m} value={m} />)}</datalist>
      <button type="button" class="btn" disabled={busy} title="按已保存的接口地址和密钥拉取" onClick={() => void pull()}>{busy ? '拉取中…' : '拉取模型列表'}</button>
      {models.length > 0 && <span class="small muted">{models.join(' · ')}</span>}
    </span>
  );
}

function AiTab() {
  const a = app.value!;
  const ai = a.settings.ai;
  const [key, setKey] = useState('');
  const [form, setForm] = useState({ ...ai, allowedTags: ai.allowedTags.join('\n') });
  const save = (): void => void act(() => api.saveSettings({
    settings: { ai: { ...form, allowedTags: form.allowedTags.split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean) } },
    ...(key ? { aiApiKey: key } : {}),
  }), '已保存').then(() => setKey(''));
  return (
    <div class="tab-body narrow">
      <Toggle on={form.enabled} label="启用 AI（新文章入库后按源的设置生成摘要、翻译标题、打标签）" onChange={(v) => setForm({ ...form, enabled: v })} />
      <div class="form-grid">
        <label>接口地址（OpenAI 兼容）<input class="input mono" value={form.baseUrl} onInput={(e) => setForm({ ...form, baseUrl: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>模型<ModelPicker id="ai-models" value={form.model} onChange={(model) => setForm({ ...form, model })} /></label>
        <label>API 密钥 {a.hasAiKey ? <span class="good small">已配置</span> : <span class="bad small">未配置</span>}
          <input class="input mono" type="password" autoComplete="off" placeholder={a.hasAiKey ? '留空则不修改' : 'sk-…'} value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} /></label>
        <label>并发数<input class="input" type="number" min={1} max={8} value={form.concurrency} onInput={(e) => setForm({ ...form, concurrency: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
        <label>正文少于多少字不做摘要<input class="input" type="number" value={form.summaryMinChars} onInput={(e) => setForm({ ...form, summaryMinChars: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
        <label>送给模型的最大字数<input class="input" type="number" value={form.maxInputChars} onInput={(e) => setForm({ ...form, maxInputChars: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
      </div>
      <label class="block">分类标签候选（每行一个，AI 只会从中挑 0–2 个）
        <textarea class="input" rows={6} value={form.allowedTags} onInput={(e) => setForm({ ...form, allowedTags: (e.currentTarget as HTMLTextAreaElement).value })} /></label>
      <p class="small muted">队列中待处理 {a.aiQueue} 篇。CNKI 期刊和视频源不做摘要；哪些源做什么在「订阅源」里逐个开关。</p>
      <div class="row-actions"><span class="grow" /><button class="btn primary" onClick={save}>保存</button></div>
      <TranslateSection />
      <EmbeddingSection />
    </div>
  );
}

// Background translation of foreign entries (server/ai/translate.ts); same address and key as above.
function TranslateSection() {
  const a = app.value!;
  const [form, setForm] = useState({ ...a.settings.translate });
  const save = (): void => void act(() => api.saveSettings({ settings: { translate: form } }), '已保存');
  return (
    <>
      <h4>全文翻译</h4>
      <Toggle on={form.enabled} label="自动翻译外文文章：最近三天入库的和所有未读的外文文章在后台逐篇译好；其余的（含太短没排进后台的）一打开就现译" onChange={(v) => setForm({ ...form, enabled: v })} />
      <Toggle on={form.shareCards} label="插件分享卡：网页简介太短或没有时，用 AI 写一两句摘要；外文网页把标题和摘要译成中文（正文会发给上面的模型）" onChange={(v) => setForm({ ...form, shareCards: v })} />
      <div class="form-grid">
        <label>翻译模型<ModelPicker id="tr-models" value={form.model} onChange={(model) => setForm({ ...form, model })} /></label>
        <label>后台跳过少于多少字的外文<input class="input" type="number" min={0} value={form.minChars} onInput={(e) => setForm({ ...form, minChars: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
        <label>外文文章打开时显示<select value={prefs.value.trView} onChange={(e) => setPrefs({ trView: (e.currentTarget as HTMLSelectElement).value as TrView })}>
          <option value="bilingual">双语</option><option value="translation">译文</option><option value="original">原文（不自动现译）</option></select></label>
        <label>每篇最多译多少字<input class="input" type="number" min={1000} value={form.maxChars} onInput={(e) => setForm({ ...form, maxChars: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
      </div>
      <p class={cx('small', a.translateError ? 'bad' : 'muted')}>
        用上面的接口地址和密钥。阅读页的「译」按钮在双语、译文、原文之间切换。
        {a.translateError && ` 最近一次失败：${a.translateError}`}
      </p>
      <div class="row-actions"><span class="grow" /><button class="btn primary" onClick={save}>保存</button></div>
    </>
  );
}

const STATUS_POLL_MS = 5000;

// Vectors for related reading and, later, the recommendation profile (server/rec/embed.ts).
function EmbeddingSection() {
  const a = app.value!;
  const [form, setForm] = useState({ ...a.settings.embedding });
  const [key, setKey] = useState('');
  const [st, setSt] = useState<EmbedStatus | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    let live = true;
    const load = (): void => { api.embeddingStatus().then((r) => { if (live) setSt(r); }, () => { /* keeps the last state */ }); };
    load();
    const t = setInterval(load, STATUS_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  const save = (): Promise<boolean> => act(() => api.saveSettings({ settings: { embedding: form }, ...(key ? { embeddingApiKey: key } : {}) }), '已保存')
    .then((ok) => { if (ok) setKey(''); return ok; });
  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      if (key && !(await save())) return;
      const r = await api.embeddingTest();
      notify(`向量服务可用，维度 ${r.dim}`);
    } catch (e) { notify((e as Error).message, true); } finally { setTesting(false); }
  };
  const total = st ? st.done + st.pending : 0;
  return (
    <>
      <h4>向量（相关文章与推荐）</h4>
      <Toggle on={form.enabled} label="给文章生成向量：在阅读页列出相关文章、标出其他源对同一件事的报道，第三期起用于推荐排序" onChange={(v) => setForm({ ...form, enabled: v })} />
      <div class="form-grid">
        <label>接口地址（OpenAI 兼容）<input class="input mono" value={form.baseUrl} onInput={(e) => setForm({ ...form, baseUrl: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>模型<input class="input mono" value={form.model} onInput={(e) => setForm({ ...form, model: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>API 密钥 {a.hasEmbeddingKey ? <span class="good small">已配置</span> : <span class="bad small">未配置</span>}
          <input class="input mono" type="password" autoComplete="off" placeholder={a.hasEmbeddingKey ? '留空则不修改' : 'sk-…（硅基流动 → API 密钥）'} value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} /></label>
        <label>每次请求的篇数<input class="input" type="number" min={1} max={64} value={form.batchSize} onInput={(e) => setForm({ ...form, batchSize: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
      </div>
      {st && (
        <p class={cx('small', st.lastError ? 'bad' : 'muted')}>
          已生成 {st.done} / {total} 篇{st.pending ? `，还剩 ${st.pending} 篇在后台补` : '，全部完成'}。
          {st.lastError && ` 最近一次失败：${st.lastError}${st.pausedUntil > Date.now() ? '，稍后自动重试' : '，改好设置或密钥后保存即可继续'}`}
        </p>
      )}
      <div class="row-actions"><span class="grow" />
        <button class="btn" disabled={testing} onClick={() => void test()}>{testing ? <><span class="spinner sm" />测试中</> : '测试'}</button>
        <button class="btn primary" onClick={() => void save()}>保存</button>
      </div>
    </>
  );
}

function ClipTab() {
  const clip = app.value!.settings.clip;
  const [form, setForm] = useState({ ...clip });
  const text = (k: 'vaultPath' | 'pathTemplate' | 'bodyTemplate' | 'imageFolder' | 'tagLibrary' | 'nameLibrary' | 'authorsFolder' | 'reportFolder') => (e: Event): void =>
    setForm({ ...form, [k]: (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value });
  const save = (): void => void act(() => api.saveSettings({ settings: { clip: form } }), '已保存');
  return (
    <div class="tab-body narrow">
      <p class="lead">在阅读页按 <kbd>c</kbd>（或点工具栏的存档按钮）把当前文章存进 Obsidian。模板语法与 Recall for Obsidian 相同；在正文里选中一段再存，会写进「摘录」一节。</p>
      <label class="block">Obsidian 库的位置（留空就不存档，日报、周报也只留在 Lumen 里）<input class="input mono" placeholder="例如 E:\Notes\Obsidian" value={form.vaultPath} onInput={text('vaultPath')} /></label>
      <label class="block">文件路径模板（相对于库，可写 /vault/ 开头）
        <input class="input mono" value={form.pathTemplate} onInput={text('pathTemplate')} /></label>
      <label class="block">笔记模板
        <textarea class="input mono" rows={18} value={form.bodyTemplate} onInput={text('bodyTemplate')} /></label>
      <Toggle on={form.aiMetadata} label="用 AI 填写著录信息：去掉栏目前缀的题目、作者与译者（统一成人名库里的中文名）、转载出处、类型、关键词、标签（从标签库里挑）。AI 给出的人名和原文题目必须在正文里出现过才会采用" onChange={(v) => setForm({ ...form, aiMetadata: v })} />
      <Toggle on={form.downloadImages} label="把文章图片存进库里（分隔线、图标、关注二维码等装饰图不保存；下载失败的保留网络链接）" onChange={(v) => setForm({ ...form, downloadImages: v })} />
      <div class="form-grid">
        <label>图片文件夹（下面再按年月分）<input class="input mono" value={form.imageFolder} onInput={text('imageFolder')} /></label>
        <label>作者页文件夹（有页面的人链接为 [[页面|中文名]]）<input class="input mono" value={form.authorsFolder} onInput={text('authorsFolder')} /></label>
        <label>标签库笔记<input class="input mono" value={form.tagLibrary} onInput={text('tagLibrary')} /></label>
        <label>人名库笔记<input class="input mono" value={form.nameLibrary} onInput={text('nameLibrary')} /></label>
        <label>日报、周报、论文周报存到<input class="input mono" value={form.reportFolder} onInput={text('reportFolder')} /></label>
      </div>
      <p class="small muted">标签库和人名库第一次存档时从库里现有的标签、作者页和剪藏自动生成，之后可在 Obsidian 里直接改；新遇到的标签和人名会追加到文末「待整理」「待确认」一节。</p>
      <Toggle on={form.aiAnalysis} label="存档后用 AI 生成深度分析，写进笔记的「# AI」一节（在后台进行）" onChange={(v) => setForm({ ...form, aiAnalysis: v })} />
      <label class="block">分析用的模型（留空则与「AI」页的模型相同）
        <ModelPicker id="clip-models" value={form.analysisModel} placeholder={app.value!.settings.ai.model} onChange={(analysisModel) => setForm({ ...form, analysisModel })} /></label>
      <Toggle on={form.thinking} label="分析时开启思考模式（先推理再写：评述更细、引文更规范，但一篇约 2–5 分钟，消耗的输出 token 约为关闭时的 6 倍）" onChange={(v) => setForm({ ...form, thinking: v })} />
      <p class="small muted">可用变量：page.displayTitle（作者｜题目（20261021））、page.title（推送标题）、page.headline（推送标题与正式题目不同时才有）、page.alias（译文的原文，同样格式）、page.authorLinks、page.translatorLinks、page.origin（转载出处）、page.type、page.keywords、page.tagLine、page.words、page.citation、page.url、page.content、page.selectedText、page.author、page.feed、page.published、page.summary、page.summaryLead、page.titleZh。
        辅助函数：{'{{date "yyyy-LL-dd"}}'}（可加第二个参数，如 page.published）、{'{{filename …}}'}、{'{{quote …}}'}、{'{{yaml …}}'}、{'{{uuid}}'}。同名笔记已存在时不会覆盖。</p>
      <div class="row-actions"><span class="grow" /><button class="btn primary" onClick={save}>保存</button></div>
    </div>
  );
}

function FetchTab() {
  const s = app.value!.settings;
  const [form, setForm] = useState({ ...s, noProxy: s.noProxy.join(', ') });
  const num = (k: keyof typeof form) => (e: Event): void => setForm({ ...form, [k]: Number((e.currentTarget as HTMLInputElement).value) });
  const save = (): void => void act(() => api.saveSettings({ settings: { ...form, noProxy: form.noProxy.split(/[,\s]+/).filter(Boolean) } }), '已保存');
  return (
    <div class="tab-body narrow">
      <div class="form-grid">
        <label>默认抓取间隔（秒）<input class="input" type="number" value={form.defaultTtl} onInput={num('defaultTtl')} /></label>
        <label>同时抓取的源数<input class="input" type="number" value={form.fetchConcurrency} onInput={num('fetchConcurrency')} /></label>
        <label>同一站点最多并发<input class="input" type="number" value={form.perHostConcurrency} onInput={num('perHostConcurrency')} /></label>
        <label>超时（毫秒）<input class="input" type="number" value={form.fetchTimeoutMs} onInput={num('fetchTimeoutMs')} /></label>
        <label>HTTP 代理（留空直连；代理连不上会自动退回直连）<input class="input mono" value={form.proxy} onInput={(e) => setForm({ ...form, proxy: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>RSSHub 地址<input class="input mono" value={form.rsshubBase} onInput={(e) => setForm({ ...form, rsshubBase: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>wechat2rss 地址（粘贴公众号文章链接时据此找到订阅；留空则不识别）<input class="input mono" value={form.wechat2rssBase} onInput={(e) => setForm({ ...form, wechat2rssBase: (e.currentTarget as HTMLInputElement).value })} /></label>
      </div>
      <label class="block">这些域名不走代理<input class="input mono" value={form.noProxy} onInput={(e) => setForm({ ...form, noProxy: (e.currentTarget as HTMLInputElement).value })} /></label>
      <h4>本机的 Zotero 与 OCR</h4>
      <label class="block">Zotero 数据库（留空用 Zotero 的默认位置：用户目录下的 Zotero\zotero.sqlite；「新书」凭它标出库里已有的书）
        <input class="input mono" value={form.zoteroDb} onInput={(e) => setForm({ ...form, zoteroDb: (e.currentTarget as HTMLInputElement).value })} /></label>
      <div class="form-grid">
        <label>OCR 用的 Python（留空不做 OCR）<input class="input mono" value={form.ocrPython} onInput={(e) => setForm({ ...form, ocrPython: (e.currentTarget as HTMLInputElement).value })} /></label>
        <label>OCR 引擎所在文件夹<input class="input mono" value={form.ocrEngine} onInput={(e) => setForm({ ...form, ocrEngine: (e.currentTarget as HTMLInputElement).value })} /></label>
      </div>
      <p class="small muted">只有海报、没有文字的推文（讲座海报、人大复印的目录图）要靠 OCR 才读得出来；不设也能用，这些推文只按文字读。引擎的接口见 scripts/ocr_images.py。</p>
      <h4>保留策略</h4>
      <div class="form-grid three">
        <label>保留天数<input class="input" type="number" value={form.retention.days} onInput={(e) => setForm({ ...form, retention: { ...form.retention, days: Number((e.currentTarget as HTMLInputElement).value) } })} /></label>
        <label>每源至少留<input class="input" type="number" value={form.retention.keepMinPerFeed} onInput={(e) => setForm({ ...form, retention: { ...form.retention, keepMinPerFeed: Number((e.currentTarget as HTMLInputElement).value) } })} /></label>
        <label>每源最多留<input class="input" type="number" value={form.retention.maxPerFeed} onInput={(e) => setForm({ ...form, retention: { ...form.retention, maxPerFeed: Number((e.currentTarget as HTMLInputElement).value) } })} /></label>
      </div>
      <p class="small muted">收藏的文章永远不会被清理。</p>
      <div class="row-actions">
        <button class="btn" onClick={() => void act(() => api.refreshAll(), '已安排全部源立即抓取')}><Icon name="refresh" size={14} />全部立即抓取</button>
        <span class="grow" /><button class="btn primary" onClick={save}>保存</button>
      </div>
    </div>
  );
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function DataTab() {
  const a = app.value!;
  const [user, setUser] = useState(a.apiUser);
  const [pw, setPw] = useState('');
  const importFile = async (e: Event): Promise<void> => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    await act(async () => { const r = await api.importOpml(await file.text()); notify(`导入 ${r.added} 个，跳过 ${r.skipped} 个已有的`); });
  };
  return (
    <div class="tab-body narrow">
      <h4>OPML</h4>
      <div class="row-actions">
        <a class="btn" href="/api/opml" download>导出 OPML</a>
        <label class="btn">导入 OPML<input type="file" accept=".opml,.xml" hidden onChange={(e) => void importFile(e)} /></label>
      </div>
      <h4>登录与手机客户端</h4>
      <p class="small muted">一组用户名和密码，两处用：支持 Google Reader 接口的 RSS 客户端（手机上的 Read You、FocusReader、Reeder 等）拿它同步，地址 <code>http://{location.hostname}:{location.port || 80}/api/greader.php</code>，跟 FreshRSS 的路径一样；打开下面的「别的设备要登录」后，网页版也用它登录。没设密码时手机接口关着。</p>
      <div class="form-grid">
        <label>用户名<input class="input" value={user} onInput={(e) => setUser((e.currentTarget as HTMLInputElement).value)} /></label>
        <label>密码 {a.hasApiPassword ? <span class="good small">已设置</span> : <span class="bad small">未设置</span>}
          <input class="input" type="password" autoComplete="new-password" placeholder="留空则不修改" value={pw} onInput={(e) => setPw((e.currentTarget as HTMLInputElement).value)} /></label>
      </div>
      <p class="small muted">改了用户名或密码，已登录的浏览器都会退出，手机客户端也要重新填。</p>
      <div class="row-actions"><span class="grow" />
        <button class="btn primary" onClick={() => void act(() => api.saveSettings({ apiUser: user, ...(pw ? { apiPassword: pw } : {}) }), '已保存').then(() => setPw(''))}>保存</button>
      </div>
      <Toggle on={a.settings.webLogin} label="别的设备要登录"
        onChange={(v) => void act(() => api.saveSettings({ settings: { webLogin: v } }), v ? '已打开：别的设备打开网页版要先登录' : '已关闭')} />
      <p class="small muted">
        只管从别的设备（手机、局域网里的其他电脑）打开网页版；在这台电脑上用永远不用登录。
        {a.settings.host === '127.0.0.1'
          ? ' 现在 Lumen 只听本机，别的设备本来就连不上；要给手机用，先把 data/settings.json 的 host 改成 0.0.0.0（见 README 常见问题）。'
          : a.settings.webLogin ? '' : <b class="bad"> 现在 Lumen 对局域网开着，又没开登录：同一网络里谁都能打开、改设置。</b>}
      </p>
      {a.settings.webLogin && !LOOPBACK.has(location.hostname) && (
        <div class="row-actions"><button class="btn" onClick={() => void api.logout().then(() => { location.href = '/login'; })}>退出登录</button></div>
      )}
      <h4>人大复印</h4>
      <div class="form-grid">
        <label>收哪些复印刊<select value={prefs.value.reprintsAll ? 'all' : 'humanities'} onChange={(e) => setPrefs({ reprintsAll: (e.currentTarget as HTMLSelectElement).value === 'all' })}>
          <option value="humanities">只收人文类</option><option value="all">全部</option></select></label>
      </div>
      <p class="small muted">人文类：文学、哲学、史学、艺术、语言、宗教、文化研究，和新闻传播、出版、档案。只管期刊目录里的「人大复印」分组和新书上的标记；期刊目录、论文周报里文章被转载的标记照旧全标。</p>
      <h4>分类</h4>
      <div class="form-grid">
        <label>侧栏里的分类<select value={prefs.value.catsOpen ? 'open' : 'closed'} onChange={(e) => setPrefs({ catsOpen: (e.currentTarget as HTMLSelectElement).value === 'open', catFlip: [] })}>
          <option value="closed">默认收起</option><option value="open">默认展开</option></select></label>
      </div>
      <p class="small muted">改默认会清掉各分类单独的展开／收起；单个分类在下面勾选，或在侧栏点分类前的箭头。</p>
      <ul class="cat-list">
        {a.categories.map((c) => (
          <li key={c.id}>
            <label class="cat-open" title="在侧栏里展开"><input type="checkbox" checked={catOpen(c.id)} onChange={() => toggleCat(c.id)} />展开</label>
            <input class="input" defaultValue={c.name} onBlur={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value.trim();
              if (v && v !== c.name) void act(() => api.updateCategory(c.id, { name: v }));
            }} />
            <span class="small muted">{a.feeds.filter((f) => f.category_id === c.id).length} 个源</span>
            <button class="icon-btn" title="删除分类（源会变成未分类）" onClick={() => void act(() => api.deleteCategory(c.id))}><Icon name="trash" size={14} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A palette in miniature: a sidebar, a title and two lines of text, the accent and an unread dot,
// drawn in the palette's own colours whichever palette is on.
function Swatch({ t }: { t: Palette['light'] }) {
  return (
    <span class="swatch" style={{ background: t.paper }} aria-hidden="true">
      <span class="swatch-side" style={{ background: t.paper2, borderColor: t.line }}>
        <i style={{ background: t.accent }} /><i style={{ background: t.ink3 }} /><i style={{ background: t.ink3 }} />
      </span>
      <span class="swatch-body">
        <b style={{ background: t.ink }} /><i style={{ background: t.ink2 }} /><i style={{ background: t.ink3 }} />
        <span class="swatch-dots"><em style={{ background: t.accent }} /><em style={{ background: t.seal }} /><em style={{ background: t.good }} /></span>
      </span>
    </span>
  );
}

const MODES = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const;

function LookTab() {
  const { theme } = prefs.value;
  const palette = paletteOf(prefs.value.palette).key;
  return (
    <div class="tab-body">
      <h4>明暗</h4>
      <div class="seg look-modes" role="radiogroup" aria-label="明暗">
        {MODES.map(([k, label]) => (
          <button key={k} role="radio" aria-checked={theme === k} class={cx(theme === k && 'on')} onClick={() => setPrefs({ theme: k })}>{label}</button>
        ))}
      </div>
      <h4>配色</h4>
      <p class="small muted">都是公开发布的配色方案，各有浅色和深色两面，跟着上面的明暗切换。只存在这台电脑的浏览器里。</p>
      <ul class="palettes" role="radiogroup" aria-label="配色">
        {PALETTES.map((p) => (
          <li key={p.key}>
            <button role="radio" aria-checked={palette === p.key} class={cx('palette', palette === p.key && 'on')} onClick={() => setPrefs({ palette: p.key })}>
              <span class="palette-swatches"><Swatch t={p.light} /><Swatch t={p.dark} /></span>
              <span class="palette-name"><strong>{p.name}</strong><small>{p.from}</small></span>
              <span class="palette-line">{p.line}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'feeds', label: '订阅源' }, { key: 'add', label: '添加订阅' }, { key: 'ai', label: 'AI' }, { key: 'clip', label: '存档' }, { key: 'fetch', label: '抓取' }, { key: 'data', label: '数据与接口' },
  { key: 'look', label: '外观' }, { key: 'profile', label: '阅读画像' },
];

export function SettingsModal() {
  const tab = settingsOpen.value;
  useEffect(() => {
    if (!tab) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') settingsOpen.value = null; };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);
  if (!tab || !app.value) return null;
  return (
    <div class="modal-back" onClick={(e) => { if (e.target === e.currentTarget) settingsOpen.value = null; }}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="设置">
        <nav class="modal-tabs">
          {TABS.map((t) => <button key={t.key} class={cx(tab === t.key && 'on')} onClick={() => { settingsOpen.value = t.key; }}>{t.label}</button>)}
          <span class="grow" />
          <button class="icon-btn" onClick={() => { settingsOpen.value = null; }} title="关闭 (Esc)"><Icon name="x" /></button>
        </nav>
        {tab === 'feeds' && <FeedsTab />}
        {tab === 'add' && <AddTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'clip' && <ClipTab />}
        {tab === 'fetch' && <FetchTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'look' && <LookTab />}
        {tab === 'profile' && <ProfileTab />}
      </div>
    </div>
  );
}
