import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { DEFAULT_CLIP, LEGACY_BODY_TEMPLATE, type ClipSettings } from './clip/obsidian.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.LUMEN_DATA ?? join(ROOT, 'data');

export interface Settings {
  host: string;
  port: number;
  webLogin: boolean;             // devices other than this one sign in with the API password (server/auth.ts)
  defaultTtl: number;            // seconds
  fetchConcurrency: number;
  perHostConcurrency: number;
  fetchTimeoutMs: number;
  proxy: string;                 // '' = direct
  noProxy: string[];             // host suffixes that bypass the proxy
  rsshubBase: string;
  wechat2rssBase: string;        // the reader's wechat2rss server, for WeChat links; '' = none
  zoteroDb: string;              // '' = where Zotero keeps it by default (~/Zotero/zotero.sqlite)
  ocrPython: string;             // the Python the OCR engine runs on; '' = no OCR
  ocrEngine: string;             // the folder holding that engine's `ocr` module (scripts/ocr_images.py)
  updateCheck: boolean;          // ask GitHub once a day whether a newer Lumen is out (server/api/update.ts)
  retention: { days: number; keepMinPerFeed: number; maxPerFeed: number };
  ai: {
    enabled: boolean;
    baseUrl: string;             // OpenAI-compatible
    model: string;
    concurrency: number;
    maxInputChars: number;
    summaryMinChars: number;     // skip AI for shorter texts
    tagPrefix: string;
    allowedTags: string[];
  };
  embedding: {
    enabled: boolean;
    baseUrl: string;             // OpenAI-compatible /embeddings
    model: string;
    batchSize: number;           // texts per request
    intervalMs: number;          // pause between requests; free tiers limit the rate
  };
  translate: {
    enabled: boolean;            // translate foreign bodies in the background (recent and new entries)
    model: string;               // served by ai.baseUrl with the AI key
    minChars: number;            // foreign letters below this are not worth it (Douban's 「想读《…》」)
    maxChars: number;            // per entry; longer bodies are translated up to here
    shareCards: boolean;         // extension share cards: AI summary when the page's is thin, Chinese for foreign pages
  };
  clip: ClipSettings & {
    aiAnalysis: boolean;
    analysisModel: string;       // '' = same model as ai.model
    thinking: boolean;           // let the model reason first: deeper, but 2–5 min and ~6x output tokens
    aiMetadata: boolean;         // title, authors, translators, origin, type, keywords, tags
    downloadImages: boolean;     // save images into the vault and drop decorative ones
    imageFolder: string;         // vault-relative; a yyyy-MM folder is added below it
    tagLibrary: string;          // vault-relative note listing the tags to choose from
    nameLibrary: string;         // vault-relative note mapping names to their Chinese form
    authorsFolder: string;       // author pages, linked as [[page|中文名]]
    reportFolder: string;        // 日报、周报、论文周报 are written under it
  };
}

// Zero here would stall fetching, the AI queue, or delete everything at the next prune.
const MUST_BE_POSITIVE = new Set(['defaultTtl', 'fetchConcurrency', 'perHostConcurrency', 'fetchTimeoutMs',
  'ai.concurrency', 'ai.maxInputChars', 'retention.days', 'retention.maxPerFeed', 'embedding.batchSize', 'embedding.intervalMs',
  'translate.maxChars']);

const isHttpUrl = (s: string): boolean => {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
};

// Each patched value must keep the type of the current one; a bad value persisted here
// would break every fetch and survive restarts. Unknown keys are dropped.
function mergeSection<T extends object>(cur: T, patch: unknown, path: string): T | string {
  if (patch === undefined) return cur;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return `${path} 应为对象`;
  const out = { ...cur } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in cur)) continue;
    const old = (cur as Record<string, unknown>)[k];
    const name = path ? `${path}.${k}` : k;
    if (Array.isArray(old)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return `${name} 应为字符串数组`;
    } else if (typeof old === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${name} 应为非负数`;
      if (v === 0 && MUST_BE_POSITIVE.has(name)) return `${name} 不能为 0`;
    } else if (typeof v !== typeof old) {
      return `${name} 类型不对`;
    }
    out[k] = v;
  }
  return out as T;
}

export function mergeSettings(cur: Settings, patch: unknown): Settings | string {
  const top = mergeSection(cur, patch, '');
  if (typeof top === 'string') return top;
  const p = patch as Partial<Record<'ai' | 'retention' | 'clip' | 'embedding' | 'translate', unknown>>;
  const ai = mergeSection(cur.ai, p.ai, 'ai');
  if (typeof ai === 'string') return ai;
  const retention = mergeSection(cur.retention, p.retention, 'retention');
  if (typeof retention === 'string') return retention;
  const clip = mergeSection(cur.clip, p.clip, 'clip');
  if (typeof clip === 'string') return clip;
  const embedding = mergeSection(cur.embedding, p.embedding, 'embedding');
  if (typeof embedding === 'string') return embedding;
  const translate = mergeSection(cur.translate, p.translate, 'translate');
  if (typeof translate === 'string') return translate;
  const next: Settings = { ...top, ai, retention, clip, embedding, translate, host: cur.host, port: cur.port };
  if (next.proxy && !isHttpUrl(next.proxy)) return 'proxy 应为 http(s) 地址或留空';
  if (!isHttpUrl(next.rsshubBase)) return 'rsshubBase 应为 http(s) 地址';
  if (next.wechat2rssBase && !isHttpUrl(next.wechat2rssBase)) return 'wechat2rssBase 应为 http(s) 地址或留空';
  if (!isHttpUrl(next.ai.baseUrl)) return 'ai.baseUrl 应为 http(s) 地址';
  if (!isHttpUrl(next.embedding.baseUrl)) return 'embedding.baseUrl 应为 http(s) 地址';
  if (!next.embedding.model.trim()) return 'embedding.model 不能为空';
  if (!next.translate.model.trim()) return 'translate.model 不能为空';
  if (next.clip.vaultPath && !isAbsolute(next.clip.vaultPath)) return 'clip.vaultPath 应为绝对路径或留空';
  for (const k of ['zoteroDb', 'ocrPython', 'ocrEngine'] as const) {
    if (next[k] && !isAbsolute(next[k])) return `${k} 应为绝对路径或留空`;
  }
  if (!next.clip.pathTemplate.trim() || !next.clip.bodyTemplate.trim()) return '存档模板不能为空';
  for (const k of ['imageFolder', 'tagLibrary', 'nameLibrary', 'authorsFolder', 'reportFolder'] as const) {
    const v = next.clip[k].trim();
    if (!v || isAbsolute(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v)) return `clip.${k} 应为库内的相对路径`;
  }
  return next;
}

// Secrets live in a separate file that is never served or logged.
export interface Secrets {
  aiApiKey: string;
  embeddingApiKey: string;
  apiUser: string;               // GReader ClientLogin, and the web login (server/auth.ts)
  apiPassword: string;           // a scrypt hash (server/auth.ts); plain text in files from before, hashed at start
}

const DEFAULTS: Settings = {
  host: '127.0.0.1',
  port: 8780,
  webLogin: false,
  defaultTtl: 3600,
  fetchConcurrency: 6,
  perHostConcurrency: 2,
  fetchTimeoutMs: 20000,
  proxy: '',
  noProxy: ['localhost', '127.0.0.1', 'cnki.net', 'minimaxi.com', 'hdslb.com', 'qpic.cn', 'qlogo.cn', 'doubanio.com'],   // WeChat's and Douban's image CDNs: 0.3 s direct, up to 12 s through the proxy (10-23)
  rsshubBase: 'http://127.0.0.1:1200',
  wechat2rssBase: '',
  zoteroDb: '',
  ocrPython: '',
  ocrEngine: '',
  updateCheck: true,
  retention: { days: 90, keepMinPerFeed: 50, maxPerFeed: 400 },
  ai: {
    enabled: true,
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    concurrency: 2,
    maxInputChars: 12000,
    summaryMinChars: 300,
    tagPrefix: 'AI:',
    allowedTags: ['文学理论', '比较文学', '文化研究', '哲学', '社会学', '科幻研究', '媒介研究', '书评',
      '艺术', '科技', '历史', '政治', '经济', '心理学', '教育'],
  },
  embedding: { enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', batchSize: 16, intervalMs: 2000 },
  translate: { enabled: true, model: 'MiniMax-M3.1-Flash', minChars: 300, maxChars: 30000, shareCards: true },
  clip: { ...DEFAULT_CLIP, aiAnalysis: true, analysisModel: '', thinking: false, aiMetadata: true, downloadImages: true,
    imageFolder: 'WebClips/图片', tagLibrary: 'Lumen/标签库.md', nameLibrary: 'Lumen/人名库.md', authorsFolder: 'Authors',
    reportFolder: 'Lumen/报告' },
};

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const SECRETS_FILE = join(DATA_DIR, 'secrets.json');

function readJson<T>(file: string): Partial<T> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<T>;
  } catch (err) {
    throw new Error(`配置文件解析失败 ${file}: ${(err as Error).message}`);
  }
}

// A body template saved untouched from an older default follows the default forward; an edited one stays.
function upgradeClip(saved: Partial<Settings['clip']> = {}): Partial<Settings['clip']> {
  const out = { ...saved };
  if (out.bodyTemplate?.replace(/\r\n/g, '\n').trim() === LEGACY_BODY_TEMPLATE.trim()) delete out.bodyTemplate;
  return out;
}

export function loadSettings(): Settings {
  const user = readJson<Settings>(SETTINGS_FILE);
  return { ...DEFAULTS, ...user, retention: { ...DEFAULTS.retention, ...user.retention }, ai: { ...DEFAULTS.ai, ...user.ai },
    embedding: { ...DEFAULTS.embedding, ...user.embedding }, translate: { ...DEFAULTS.translate, ...user.translate }, clip: { ...DEFAULTS.clip, ...upgradeClip(user.clip) } };
}

// Written beside and renamed over: a crash halfway through left half a JSON file, and Lumen would not start.
function writeAtomic(file: string, text: string, mode?: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}

export function saveSettings(next: Settings): void {
  writeAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

export function loadSecrets(): Secrets {
  const s = readJson<Secrets>(SECRETS_FILE);
  return {
    aiApiKey: process.env.LUMEN_AI_KEY ?? s.aiApiKey ?? '',
    embeddingApiKey: process.env.LUMEN_EMBEDDING_KEY ?? s.embeddingApiKey ?? '',
    apiUser: s.apiUser ?? 'lumen',
    apiPassword: process.env.LUMEN_API_PASSWORD ?? s.apiPassword ?? '',
  };
}

// A value given by the environment stays out of the file: what was on disk is kept in its place.
const SECRET_ENV = { aiApiKey: 'LUMEN_AI_KEY', embeddingApiKey: 'LUMEN_EMBEDDING_KEY', apiPassword: 'LUMEN_API_PASSWORD' } as const;

export function saveSecrets(next: Secrets): void {
  const disk = readJson<Partial<Secrets>>(SECRETS_FILE);
  const out = { ...next };
  for (const [k, env] of Object.entries(SECRET_ENV) as [keyof typeof SECRET_ENV, string][]) {
    if (process.env[env] !== undefined && out[k] === process.env[env]) out[k] = disk[k] ?? '';
  }
  writeAtomic(SECRETS_FILE, JSON.stringify(out, null, 2), 0o600);
}
