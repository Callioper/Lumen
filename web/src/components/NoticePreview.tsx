// 首页's right column: the notice picked in the lists, with the post's cover above it and the pictures
// the post carries (posters, programmes) under it, so it can be read without opening the post.
import { useEffect, useState } from 'preact/hooks';
import { api, type Notice } from '../api.ts';
import { open, notify } from '../store.ts';
import { daysUntil } from '../due.ts';
import { cx, proxied, proxiedCover, toneOf } from '../util.ts';
import { Contact, FromPost, Live, Replays, md, shownName } from './Journals.tsx';
import { Icon } from './Icon.tsx';
import { loadHash, hashDistance, SAME_PICTURE_BITS } from '../picturehash.ts';

const POSTERS = 4;
const IMG = /<img\b[^>]*?\bsrc="([^"]+)"/g;
// One picture under several addresses: WeChat serves it at …/<id>/0 and …/<id>/640, with different queries.
// A relayed address (/img?u=…, wechat2rss's img-proxy inside it) is compared by the address it relays.
const RELAYS = 3;
function pictureKey(url: string): string {
  let target = url;
  for (let i = 0; i < RELAYS; i++) {
    let inner: string | null = null;
    try { inner = new URL(target, location.href).searchParams.get('u'); } catch { /* keep it as written */ }
    if (!inner) break;
    target = inner;
  }
  return target.replace(/[?#].*$/, '').replace(/\/\d+$/, '');
}

// The cover again in the body is often a file of its own: told apart by how it looks.
async function withoutCover(urls: string[], cover: string | null | undefined): Promise<string[]> {
  if (!cover || !urls.length) return urls;
  const [own, ...theirs] = await Promise.all([cover, ...urls].map((u) => loadHash(proxiedCover(u, 160))));
  if (!own) return urls;
  return urls.filter((_, i) => { const h = theirs[i]; return !h || hashDistance(own, h) > SAME_PICTURE_BITS; });
}

// The pictures in the post, apart from its cover.
function usePostImages(postId: number, cover: string | null | undefined): string[] {
  const [images, setImages] = useState<{ id: number; urls: string[] }>({ id: 0, urls: [] });
  useEffect(() => {
    let live = true;
    api.entry(postId).then(async (e) => {
      const html = e.content_full || e.content || '';
      const seen = new Set(cover ? [pictureKey(cover)] : []);
      const urls = [...html.matchAll(IMG)].map((m) => m[1].replace(/&amp;/g, '&'))
        .filter((u) => !seen.has(pictureKey(u)) && !!seen.add(pictureKey(u)));
      // One more than shown, in case the first is the cover.
      const shown = (await withoutCover(urls.slice(0, POSTERS + 1), cover)).slice(0, POSTERS);
      if (live) setImages({ id: postId, urls: shown });
    }).catch(() => { if (live) setImages({ id: postId, urls: [] }); });
    return () => { live = false; };
  }, [postId]);
  return images.id === postId ? images.urls : [];
}

// The countdown in words: how many days, and to what.
function countdown(n: Notice): { big: string; unit: string; tone: string } {
  if (!n.next) return { big: '常设', unit: '不限期', tone: '' };
  if (n.next.what === '进行中') return { big: '进行中', unit: `${md(n.next.date)}结束`, tone: 'on' };
  const left = daysUntil(n.next.date);
  const what = n.next.what === '截止' ? '截止' : '开始';
  if (left <= 0) return { big: '今天', unit: what, tone: 'now' };
  return { big: String(left), unit: `天后${what} · ${md(n.next.date)}`, tone: left <= 7 ? 'now' : '' };
}

async function readPost(id: number): Promise<void> {
  try {
    await open(await api.entry(id), { listScope: 'notices', sortMode: 'latest', position: 0 });
  } catch (e) {
    notify((e as Error).message, true);
  }
}

export function NoticePreview({ n }: { n: Notice | null }) {
  if (!n) return <div class="np-empty muted">点左边一条，在这里看详情。</div>;
  return <Preview key={`${n.post.id}:${n.name}`} n={n} />;
}

function Preview({ n }: { n: Notice }) {
  const posters = usePostImages(n.post.id, n.post.image);
  const c = countdown(n);
  const held = n.date ? `${md(n.date)}${n.end ? ` – ${md(n.end)}` : ''}` : '';
  const facts: [string, string][] = ([['举办', held],['截止', n.deadline ? md(n.deadline) : ''], ['地点', n.place], ['主办', n.organizer],
    ['主讲', n.speakers.join('、')]] as [string, string][]).filter(([, v]) => !!v);
  return (
    <article class="np">
      {n.post.image && (
        <figure class="np-hero">
          <img src={proxiedCover(n.post.image, 1080)} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).remove(); }} />
        </figure>
      )}
      <div class="np-body">
        <p class="np-tags">
          <span class={`notice-kind ${toneOf(n.kind)}`}>{n.kind}</span>
          {n.online && n.status === 'upcoming' && <span class="notice-onair">{n.online === '线上' ? '线上' : '直播'}</span>}
          {n.replays.length > 0 && <span class="notice-kind tone-teal">有录像</span>}
        </p>
        <h2 class="np-title">{shownName(n.name)}</h2>
        <p class={cx('np-count', c.tone)}><b>{c.big}</b><span>{c.unit}</span></p>
        {facts.length > 0 && (
          <dl class="np-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        )}
        {n.summary && <p class="np-summary">{n.summary}</p>}
        <Live n={n} />
        <Replays n={n} />
        {n.contact && <div class="np-line"><b>联系</b><Contact text={n.contact} /></div>}
        {posters.length > 0 && (
          <div class={cx('np-posters', posters.length === 1 && 'one')}>
            {posters.map((u) => (
              <a key={u} href={proxied(u)} target="_blank" rel="noopener noreferrer" title="看大图">
                <img src={proxiedCover(u, 520)} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).remove(); }} />
              </a>
            ))}
          </div>
        )}
        <footer class="np-foot">
          <FromPost post={n.post} scope="notices" extra={n.posts > 1 ? `${n.posts} 篇推文` : undefined} />
          <span class="np-actions">
            <button class="np-read" onClick={() => void readPost(n.post.id)}><Icon name="doc" size={14} />读推文</button>
            {n.post.link && <a class="np-out" href={n.post.link} target="_blank" rel="noopener noreferrer">原文 ↗</a>}
          </span>
        </footer>
      </div>
    </article>
  );
}
