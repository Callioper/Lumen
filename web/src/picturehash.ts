// Whether two pictures are the same one at another size or quality: an 8×8 average hash; and whether a
// picture is a QR or 小程序 code. Only for pictures served through Lumen's own /img (same origin),
// which a canvas may read.
const SIDE = 8;
// Bits that may differ between two copies of one picture (recompression, a resize).
export const SAME_PICTURE_BITS = 6;

// A code, sampled at 64 × 64: about square, its pixels pure black, pure white or a spot of colour (the
// logo in the middle), mostly white, and black and white changing places often along a row. Measured
// 10-26 on 149 pictures from 学术动态 posts: every QR and 小程序 code (their grey ≤ 0.16, changes ≥ 0.13)
// and no photo, headshot or poster (a grid of headshots: grey 0.34).
const CODE_SAMPLE = 64;
const CODE_SHAPE = [0.85, 1.2] as const;          // height / width
const CODE_MAX_GREY = 0.25;
const CODE_MAX_COLOUR = 0.2;
const CODE_MIN_LIGHT = 0.4;
const CODE_MIN_CHANGES = 0.12;
const SATURATED = 60, DARK = 80, LIGHT = 190, MID = 128;

export interface Look { hash: string | null; code: boolean }

function canvasOf(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;                       // a picture from elsewhere taints the canvas: nothing read, kept
  }
}

const greyOf = (px: Uint8ClampedArray, i: number): number => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;

export function averageHash(img: HTMLImageElement): string | null {
  const px = canvasOf(img, SIDE, SIDE);
  if (!px) return null;
  const grey: number[] = [];
  for (let i = 0; i < px.length; i += 4) grey.push(greyOf(px, i));
  const mean = grey.reduce((a, b) => a + b, 0) / grey.length;
  return grey.map((g) => (g > mean ? '1' : '0')).join('');
}

export function looksLikeCode(img: HTMLImageElement): boolean {
  const shape = img.naturalHeight / img.naturalWidth;
  if (!(shape >= CODE_SHAPE[0] && shape <= CODE_SHAPE[1])) return false;
  const S = CODE_SAMPLE;
  const px = canvasOf(img, S, S);
  if (!px) return false;
  let light = 0, grey = 0, colour = 0, changes = 0;
  const dark: boolean[] = [];
  for (let i = 0; i < px.length; i += 4) {
    const v = greyOf(px, i);
    dark.push(v < MID);
    if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > SATURATED) colour++;
    else if (v > LIGHT) light++;
    else if (v >= DARK) grey++;
  }
  for (let y = 0; y < S; y++) for (let x = 1; x < S; x++) if (dark[y * S + x] !== dark[y * S + x - 1]) changes++;
  const n = S * S;
  return grey / n <= CODE_MAX_GREY && colour / n <= CODE_MAX_COLOUR && light / n >= CODE_MIN_LIGHT && changes / (S * (S - 1)) >= CODE_MIN_CHANGES;
}

export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function loadLook(src: string): Promise<Look> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ hash: averageHash(img), code: looksLikeCode(img) });
    img.onerror = () => resolve({ hash: null, code: false });
    img.src = src;
  });
}
