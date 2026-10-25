// Whether two pictures are the same one at another size or quality: an 8×8 average hash.
// Only for pictures served through Lumen's own /img (same origin), which a canvas may read.
const SIDE = 8;
// Bits that may differ between two copies of one picture (recompression, a resize).
export const SAME_PICTURE_BITS = 6;

export function averageHash(img: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIDE; canvas.height = SIDE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, SIDE, SIDE);
    const px = ctx.getImageData(0, 0, SIDE, SIDE).data;
    const grey: number[] = [];
    for (let i = 0; i < px.length; i += 4) grey.push(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
    const mean = grey.reduce((a, b) => a + b, 0) / grey.length;
    return grey.map((g) => (g > mean ? '1' : '0')).join('');
  } catch {
    return null;                       // a picture from elsewhere taints the canvas: no hash, kept
  }
}

export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function loadHash(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(averageHash(img));
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
