// Is a paper already in Zotero? Read-only queries to the local API, one at a time (parallel ones
// froze Zotero before). When Zotero is not answering the answer is "unknown", never "not in library".
import { normTitle, titleOverlap } from './ngram.ts';
import { log } from '../log.ts';

const ZOTERO_API = 'http://127.0.0.1:23119/api/users/0/items';
const TIMEOUT_MS = 6000;
const SAME_TITLE = 0.9;

export type InLibrary = boolean | null;   // null: not checked

export async function checkZotero(titles: readonly string[], fetchFn: typeof fetch = fetch): Promise<InLibrary[]> {
  const out: InLibrary[] = [];
  let alive = true;
  for (const title of titles) {
    // Search on the main title: subtitles are often dropped or punctuated differently.
    const main = title.split(/[：:——]/)[0].trim() || title;
    if (!alive || normTitle(main).length < 4) { out.push(null); continue; }
    try {
      const url = `${ZOTERO_API}?q=${encodeURIComponent(main)}&qmode=titleCreatorYear&limit=5&format=json`;
      const r = await fetchFn(url, { headers: { 'zotero-allowed-request': '1' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const hits = await r.json() as { data?: { title?: string } }[];
      out.push(hits.some((h) => titleOverlap(h.data?.title ?? '', title) >= SAME_TITLE));
    } catch (e) {
      // Not checked is told apart from not in the library (null, not false), but said nowhere else.
      log.warn(`[report] Zotero 没响应，这份报告跳过在库检查：${(e as Error).message}`);
      alive = false;
      out.push(null);
    }
  }
  return out;
}
