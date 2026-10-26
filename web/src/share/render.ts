import { h, render } from 'preact';
import { toBlob } from 'html-to-image';
import { ShareCard, type CardStyle } from './ShareCard.tsx';
import type { ShareData } from './data.ts';

const PIXEL_RATIO = 2;
// A cover that has not loaded by then is left out rather than holding up the copy.
const IMAGE_WAIT_MS = 5000;

async function settle(img: HTMLImageElement): Promise<void> {
  if (!img.complete) {
    await Promise.race([
      new Promise<void>((done) => { img.addEventListener('load', () => done(), { once: true }); img.addEventListener('error', () => done(), { once: true }); }),
      new Promise<void>((done) => setTimeout(done, IMAGE_WAIT_MS)),
    ]);
  }
  // Broken or unfinished images would export as an empty box; a cover's frame goes with it.
  if (!img.complete || !img.naturalWidth) (img.closest('.sc-cover') ?? img).remove();
}

// Renders the card off screen and turns it into a PNG. Images must be same-origin (/img, /icon).
export async function cardPng(data: ShareData, style: CardStyle): Promise<Blob> {
  const host = document.createElement('div');
  host.className = 'share-stage';
  document.body.append(host);
  try {
    render(h(ShareCard, { data, style }), host);
    const card = host.firstElementChild as HTMLElement;
    await Promise.all([...card.querySelectorAll('img')].map(settle));
    await document.fonts.ready;
    // Fonts are the system's; skipFonts stops the library from fetching and inlining stylesheets.
    // includeQueryParams: the library caches embedded images for the page's lifetime by URL without
    // its query, so every /img?url=… cover was one key and each card after the first got its cover.
    const blob = await toBlob(card, { pixelRatio: PIXEL_RATIO, skipFonts: true, cacheBust: false, includeQueryParams: true });
    if (!blob) throw new Error('生成图片失败');
    return blob;
  } finally {
    render(null, host);
    host.remove();
  }
}

// The promise goes into the ClipboardItem directly, so the key press that started it still
// counts as the user's gesture when the image is ready.
export async function copyPng(png: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function savePng(blob: Blob, title: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 60) || 'Lumen 分享'}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
