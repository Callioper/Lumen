import { fetch, Agent, ProxyAgent, type Dispatcher } from 'undici';
import iconv from 'iconv-lite';
import type { Settings } from '../config.ts';
import { assertPublicUrl, guardedAgent } from './guard.ts';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Lumen/1.0';
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const direct = new Agent({ connections: 16 });
let proxyAgent: ProxyAgent | null = null;
let proxyUrl = '';

function proxyFor(settings: Settings): ProxyAgent | null {
  if (!settings.proxy) return null;
  if (settings.proxy !== proxyUrl) {
    proxyAgent = new ProxyAgent(settings.proxy);
    proxyUrl = settings.proxy;
  }
  return proxyAgent;
}

export function bypassesProxy(host: string, noProxy: string[]): boolean {
  const h = host.toLowerCase();
  return noProxy.some((s) => h === s || h.endsWith('.' + s.replace(/^\./, '')));
}

export function dispatcherFor(url: URL, settings: Settings): Dispatcher {
  const p = proxyFor(settings);
  return p && !bypassesProxy(url.hostname, settings.noProxy) ? p : direct;
}

// undici reports every network failure as "fetch failed"; the useful part is in .cause.
export function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return '超时';
  const code = e?.cause?.code;
  const known: Record<string, string> = {
    ECONNREFUSED: '连接被拒绝（服务没开？）', ENOTFOUND: '域名解析失败', ECONNRESET: '连接被重置',
    UND_ERR_CONNECT_TIMEOUT: '连接超时', CERT_HAS_EXPIRED: '证书过期', UND_ERR_SOCKET: '连接中断',
  };
  if (code && known[code]) return `${known[code]} [${code}]`;
  const detail = e?.cause?.message ?? '';
  return (detail ? `${e.message}: ${detail}` : String(e?.message ?? err)).slice(0, 300);
}

export interface FetchResult {
  status: number;
  headers: Headers;
  body: Buffer;
  url: string;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  // For URLs taken from feed content: refuse loopback/LAN targets, including via redirects.
  publicOnly?: boolean;
}

const MAX_REDIRECTS = 5;

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`响应超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isProxyConnectError(err: unknown): boolean {
  const msg = String((err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.message ?? '');
  return /ECONNREFUSED|UND_ERR_CONNECT|proxy/i.test(msg);
}

async function fetchOnce(url: URL, settings: Settings, opts: FetchOptions, signal: AbortSignal): Promise<FetchResult> {
  const directAgent = opts.publicOnly ? guardedAgent : direct;
  const run = async (dispatcher: Dispatcher): Promise<FetchResult> => {
    const res = await fetch(url, {
      dispatcher,
      // publicOnly follows redirects itself so every hop gets checked.
      redirect: opts.publicOnly ? 'manual' : 'follow',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
      signal,
    });
    const body = await readCapped(res as unknown as Response, opts.maxBytes ?? MAX_BODY_BYTES);
    return { status: res.status, headers: res.headers as unknown as Headers, body, url: res.url || url.toString() };
  };
  const p = proxyFor(settings);
  const dispatcher = p && !bypassesProxy(url.hostname, settings.noProxy) ? p : directAgent;
  try {
    return await run(dispatcher);
  } catch (err) {
    // Proxy down (v2ray not running): fall back to a direct connection rather than failing every feed.
    if (dispatcher !== directAgent && isProxyConnectError(err)) return run(directAgent);
    throw err;
  }
}

export async function httpGet(rawUrl: string, settings: Settings, opts: FetchOptions = {}): Promise<FetchResult> {
  let url = new URL(rawUrl);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? settings.fetchTimeoutMs);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议 ${url.protocol}`);
    if (opts.publicOnly) await assertPublicUrl(url);
    const res = await fetchOnce(url, settings, opts, signal);
    const location = res.headers.get('location');
    if (!opts.publicOnly || res.status < 300 || res.status >= 400 || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('重定向次数过多');
    url = new URL(location, url);
  }
}

// Decode bytes honouring HTTP charset, then XML/HTML declarations (CNKI and some
// Chinese sites still serve GBK).
export function decodeBody(body: Buffer, contentType: string | null): string {
  const pick = (s: string | null | undefined): string | null => {
    const m = s?.match(/charset\s*=\s*["']?([\w-]+)/i);
    return m ? m[1].toLowerCase() : null;
  };
  const head = body.subarray(0, 2048).toString('latin1');
  let charset = pick(contentType)
    ?? head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1]?.toLowerCase()
    ?? pick(head.match(/<meta[^>]+charset[^>]*>/i)?.[0])
    ?? 'utf-8';
  if (charset === 'gb2312') charset = 'gbk';
  if (!iconv.encodingExists(charset)) charset = 'utf-8';
  const text = iconv.decode(body, charset);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
