// 首页's right column: the notice picked in the lists, with the post's cover above it and the pictures
// the post carries (posters, programmes) under it, so it can be read without opening the post.
import { useEffect, useState } from 'preact/hooks';
import { api, type Notice } from '../api.ts';
import { open, notify } from '../store.ts';
import { daysUntil } from '../due.ts';
import { cx, proxied, proxiedCover, safeLink, toneOf } from '../util.ts';
import { Contact, FromPost, Live, Replays, md, shownName } from './Journals.tsx';
import { Ranks } from './Ranks.tsx';
import { Icon } from './Icon.tsx';
import { loadLook, hashDistance, SAME_PICTURE_BITS } from '../picturehash.ts';

const POSTERS = 4;

// A roundup's cover is no notice's own (server/content/notices.ts own).
export const ownCover = (n: Notice): string | null => (n.own === undefined ? n.post.image ?? null : n.own?.image ?? null);

// Asked for beyond those shown: some will be the cover again or a QR code.
const ASKED = 8;

// The cover again in the body is often a file of its own, told apart by how it looks; a QR or 小程序
// code by its pixels (picturehash.ts), which the server cannot read without an image decoder.
async function shownOf(urls: string[], cover: string | null | undefined): Promise<string[]> {
  const [own, ...looks] = await Promise.all([cover ? loadLook(proxiedCover(cover, 520)) : null, ...urls.map((u) => loadLook(proxiedCover(u, 520)))]);
  return urls.filter((_, i) => {
    const { hash, code } = looks[i];
    return !code && !(own?.hash && hash && hashDistance(own.hash, hash) <= SAME_PICTURE_BITS);
  });
}

// While the server's OCR reads the post's pictures (about 1.6 s each), asked once more after this.
const READ_AGAIN_MS = 20_000;

// The pictures in the post apart from its cover; the server leaves out GIFs, dividers, banners and
// mastheads as the archive does, and keeps the posters, told by the text read in them.
function usePostImages(postId: number, cover: string | null | undefined): string[] {
  const [images, setImages] = useState<{ id: number; urls: string[] }>({ id: 0, urls: [] });
  useEffect(() => {
    if (!postId) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    const ask = (retry: boolean): void => {
      api.pictures(postId, ASKED).then(async ({ urls, reading }) => {
        const shown = (await shownOf(urls, cover)).slice(0, POSTERS);
        if (!live) return;
        setImages({ id: postId, urls: shown });
        if (reading && retry) again = setTimeout(() => ask(false), READ_AGAIN_MS);
      }).catch(() => { if (live && retry) setImages({ id: postId, urls: [] }); });     // asked again: what was shown stays
    };
    ask(true);
    return () => { live = false; clearTimeout(again); };
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
  const cover = ownCover(n);
  const posters = usePostImages(n.own === undefined ? n.post.id : n.own?.id ?? 0, cover);
  const c = countdown(n);
  const link = safeLink(n.post.link);
  const held = n.date ? `${md(n.date)}${n.end ? ` – ${md(n.end)}` : ''}` : '';
  const facts: [string, string][] = ([['举办', held],['截止', n.deadline ? md(n.deadline) : ''], ['地点', n.place], ['主办', n.organizer],
    ['主讲', n.speakers.join('、')]] as [string, string][]).filter(([, v]) => !!v);
  return (
    <article class="np">
      {cover && (
        <figure class="np-hero">
          <img src={proxiedCover(cover, 1080)} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).remove(); }} />
        </figure>
      )}
      <div class="np-body">
        <p class="np-tags">
          <span class={`notice-kind ${toneOf(n.kind)}`}>{n.kind}</span>
          <Ranks rank={n.rank} />
          {n.online && n.status === 'upcoming' && <span class="notice-onair">{n.online === '线上' ? '线上' : '直播'}</span>}
          {n.replays.length > 0 && <span class="notice-kind tone-teal">有录像</span>}
          {(n.recaps?.length ?? 0) > 0 && <span class="notice-kind tone-teal">有纪要</span>}
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
            {link && <a class="np-out" href={link} target="_blank" rel="noopener noreferrer">原文 ↗</a>}
          </span>
        </footer>
      </div>
    </article>
  );
}
