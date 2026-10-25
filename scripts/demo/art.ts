// The demo's pictures, drawn as SVG data URIs so it loads nothing from elsewhere: book covers laid
// out the way a press would (a few house styles, printed inks on paper, a motif for what the book is
// about), posters and sleeves for the films and records, and wordless pictures for the posts.
import type { Topic } from './content.ts';

export type Look = 'band' | 'full' | 'motif' | 'series';
export interface CoverOf { title: string; authors: string; publisher: string; topic: Topic; look: Look; en?: string; original?: string; series?: string; translators?: string }

const PAPER = ['#f2ede3', '#ebe5d7', '#f5f2ea', '#e8e2d5'];
// One printing ink per subject, and a second to go with it.
const INK: Record<Topic, [string, string]> = {
  media: ['#a8502b', '#e2b25b'], posthuman: ['#45487f', '#c9a3c8'], labor: ['#a8362c', '#f0c05a'], city: ['#2c5a70', '#e6a35a'],
  translation: ['#6e3854', '#d9b08c'], scifi: ['#285f52', '#9fd0c0'], platform: ['#38475a', '#8fb3d9'], eco: ['#53733a', '#cfd98f'],
};
const DARK = '#22252a';
const SERIF = "'Songti SC','STSong','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif";
const SANS = "'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif";

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);
// A small seeded generator, so a picture comes out the same on every build.
function prng(seed: number): () => number {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 0x1000000; };
}
const uri = (svg: string): string => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
const open = (w: number, h: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
// Paper grain over everything; and, on a cover, the shade of the spine at the left.
const GRAIN = '<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/>' +
  '<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .09 0"/></filter>';
const grain = '<rect width="100%" height="100%" filter="url(#grain)"/>';
const SPINE = '<linearGradient id="spine" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".05" stop-color="#000" stop-opacity=".06"/>' +
  '<stop offset=".08" stop-color="#fff" stop-opacity=".1"/><stop offset=".14" stop-color="#fff" stop-opacity="0"/></linearGradient>';
const spine = '<rect width="100%" height="100%" fill="url(#spine)"/>';

const text = (x: number, y: number, s: string, size: number, fill: string, o: { font?: string; anchor?: string; weight?: number; spacing?: number; opacity?: number; italic?: boolean } = {}): string =>
  `<text x="${x}" y="${y}" font-family="${o.font ?? SERIF}" font-size="${size}" fill="${fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}` +
  `${o.weight ? ` font-weight="${o.weight}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}${o.opacity ? ` fill-opacity="${o.opacity}"` : ''}` +
  `${o.italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`;
// Set top to bottom, a character to a line, as a Chinese spine or a vertical title is.
const vertical = (x: number, y: number, s: string, size: number, fill: string, o: { font?: string; weight?: number; gap?: number } = {}): string =>
  [...s].map((ch, i) => text(x, y + i * size * (o.gap ?? 1.15), ch, size, fill, { font: o.font, anchor: 'middle', weight: o.weight })).join('');
// A title broken into lines of at most n characters, the last line not left with one alone.
function lines(s: string, n: number): string[] {
  const chars = [...s];
  if (chars.length <= n) return [s];
  const count = Math.ceil(chars.length / n);
  const per = Math.ceil(chars.length / count);
  return Array.from({ length: count }, (_, i) => chars.slice(i * per, (i + 1) * per).join(''));
}

// What a book or a post is about, drawn in a box at (x, y) of side s.
export function motif(topic: Topic, x: number, y: number, s: number, ink: string, accent: string, r: () => number): string {
  const p = (fx: number, fy: number): string => `${(x + fx * s).toFixed(1)},${(y + fy * s).toFixed(1)}`;
  switch (topic) {
    case 'media': {          // a lantern throwing its picture on a wall
      const rings = [0.34, 0.26, 0.18].map((k, i) => `<circle cx="${x + 0.68 * s}" cy="${y + 0.44 * s}" r="${k * s}" fill="${i ? 'none' : accent}" fill-opacity=".9" stroke="${ink}" stroke-width="${i ? 1.4 : 0}"/>`).join('');
      return `<polygon points="${p(0.14, 0.62)} ${p(0.68, 0.1)} ${p(0.68, 0.78)}" fill="${accent}" fill-opacity=".35"/>${rings}` +
        `<rect x="${x + 0.04 * s}" y="${y + 0.56 * s}" width="${0.16 * s}" height="${0.13 * s}" rx="2" fill="${ink}"/>` +
        `<rect x="${x + 0.07 * s}" y="${y + 0.69 * s}" width="${0.03 * s}" height="${0.2 * s}" fill="${ink}"/>`;
    }
    case 'posthuman': {      // a few nodes and what joins them
      const pts = Array.from({ length: 9 }, () => [0.1 + r() * 0.8, 0.1 + r() * 0.8]);
      const edges = pts.flatMap((a, i) => pts.slice(i + 1).filter((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.42)
        .map((b) => `<line x1="${x + a[0] * s}" y1="${y + a[1] * s}" x2="${x + b[0] * s}" y2="${y + b[1] * s}" stroke="${ink}" stroke-width="1.2" stroke-opacity=".7"/>`));
      const nodes = pts.map(([a, b], i) => `<circle cx="${x + a * s}" cy="${y + b * s}" r="${(i % 3 ? 0.025 : 0.05) * s}" fill="${i % 3 ? ink : accent}" stroke="${ink}" stroke-width="1"/>`);
      return `<circle cx="${x + s / 2}" cy="${y + s / 2}" r="${0.46 * s}" fill="none" stroke="${ink}" stroke-opacity=".25"/>${edges.join('')}${nodes.join('')}`;
    }
    case 'labor': {          // a wheel and the road going by
      const speed = Array.from({ length: 6 }, (_, i) => `<line x1="${x + (0.02 + r() * 0.2) * s}" y1="${y + (0.2 + i * 0.09) * s}" x2="${x + (0.42 + r() * 0.2) * s}" y2="${y + (0.2 + i * 0.09) * s}" stroke="${ink}" stroke-width="${1 + (i % 2) * 1.5}" stroke-linecap="round"/>`);
      return `${speed.join('')}<circle cx="${x + 0.7 * s}" cy="${y + 0.56 * s}" r="${0.22 * s}" fill="${accent}"/>` +
        `<circle cx="${x + 0.7 * s}" cy="${y + 0.56 * s}" r="${0.22 * s}" fill="none" stroke="${ink}" stroke-width="${0.035 * s}"/>` +
        `<circle cx="${x + 0.7 * s}" cy="${y + 0.56 * s}" r="${0.04 * s}" fill="${ink}"/>` +
        `<line x1="${x}" y1="${y + 0.8 * s}" x2="${x + s}" y2="${y + 0.8 * s}" stroke="${ink}" stroke-width="1.5"/>`;
    }
    case 'city': {           // a skyline, some windows lit
      let out = `<circle cx="${x + 0.74 * s}" cy="${y + 0.26 * s}" r="${0.12 * s}" fill="${accent}"/>`;
      let at = 0;
      while (at < 0.98) {
        const w = 0.08 + r() * 0.12, h = 0.25 + r() * 0.5;
        out += `<rect x="${x + at * s}" y="${y + (0.9 - h) * s}" width="${w * s - 2}" height="${h * s}" fill="${ink}"/>`;
        for (let wy = 0.9 - h + 0.05; wy < 0.85; wy += 0.07) {
          for (let wx = at + 0.02; wx < at + w - 0.03; wx += 0.035) if (r() < 0.3) out += `<rect x="${x + wx * s}" y="${y + wy * s}" width="${0.015 * s}" height="${0.025 * s}" fill="${accent}"/>`;
        }
        at += w;
      }
      return out + `<line x1="${x}" y1="${y + 0.9 * s}" x2="${x + s}" y2="${y + 0.9 * s}" stroke="${ink}" stroke-width="1.5"/>`;
    }
    case 'translation': {    // two circles of meaning, and the lines between
      const rows = Array.from({ length: 5 }, (_, i) => `<line x1="${x + 0.12 * s}" y1="${y + (0.78 + i * 0.045) * s}" x2="${x + (0.5 + r() * 0.38) * s}" y2="${y + (0.78 + i * 0.045) * s}" stroke="${ink}" stroke-width="1.4" stroke-opacity=".6"/>`);
      return `<circle cx="${x + 0.38 * s}" cy="${y + 0.4 * s}" r="${0.26 * s}" fill="${accent}" fill-opacity=".85"/>` +
        `<circle cx="${x + 0.62 * s}" cy="${y + 0.4 * s}" r="${0.26 * s}" fill="none" stroke="${ink}" stroke-width="${0.02 * s}"/>${rows.join('')}`;
    }
    case 'scifi': {          // a planet, its ring, a moon
      return `<circle cx="${x + 0.5 * s}" cy="${y + 0.5 * s}" r="${0.26 * s}" fill="${ink}"/>` +
        `<path d="M ${x + 0.24 * s} ${y + 0.5 * s} a ${0.26 * s} ${0.26 * s} 0 0 1 ${0.52 * s} 0" fill="${accent}" fill-opacity=".35"/>` +
        `<ellipse cx="${x + 0.5 * s}" cy="${y + 0.52 * s}" rx="${0.46 * s}" ry="${0.11 * s}" fill="none" stroke="${accent}" stroke-width="${0.02 * s}" transform="rotate(-14 ${x + 0.5 * s} ${y + 0.52 * s})"/>` +
        `<circle cx="${x + 0.84 * s}" cy="${y + 0.18 * s}" r="${0.05 * s}" fill="${accent}"/>` +
        Array.from({ length: 14 }, () => `<circle cx="${x + r() * s}" cy="${y + r() * s}" r="${0.4 + r() * 1.2}" fill="${ink}" fill-opacity=".6"/>`).join('');
    }
    case 'platform': {       // a grid of tiles, one picked out
      const k = Math.floor(r() * 9);
      return Array.from({ length: 9 }, (_, i) => {
        const cx = x + (0.08 + (i % 3) * 0.3) * s, cy = y + (0.08 + Math.floor(i / 3) * 0.3) * s;
        return `<rect x="${cx}" y="${cy}" width="${0.24 * s}" height="${0.24 * s}" rx="${0.03 * s}" fill="${i === k ? accent : 'none'}" stroke="${ink}" stroke-width="${i === k ? 0 : 1.4}"/>`;
      }).join('');
    }
    case 'eco': {            // water in layers, reeds at the bank
      const waves = Array.from({ length: 5 }, (_, i) => {
        const yy = y + (0.45 + i * 0.1) * s, a = 0.03 * s;
        return `<path d="M ${x} ${yy} q ${s / 8} ${-a} ${s / 4} 0 t ${s / 4} 0 t ${s / 4} 0 t ${s / 4} 0" fill="none" stroke="${i % 2 ? accent : ink}" stroke-width="${1.6 + (i % 2)}" stroke-linecap="round"/>`;
      });
      const reeds = Array.from({ length: 7 }, (_, i) => {
        const rx = x + (0.06 + i * 0.05 + r() * 0.02) * s, top = y + (0.08 + r() * 0.18) * s;
        return `<path d="M ${rx} ${y + 0.5 * s} Q ${rx + 0.02 * s} ${top + 0.1 * s} ${rx + 0.05 * s} ${top}" fill="none" stroke="${ink}" stroke-width="1.3"/>` +
          `<ellipse cx="${rx + 0.05 * s}" cy="${top}" rx="${0.012 * s}" ry="${0.04 * s}" fill="${ink}" transform="rotate(20 ${rx + 0.05 * s} ${top})"/>`;
      });
      return `<circle cx="${x + 0.72 * s}" cy="${y + 0.24 * s}" r="${0.13 * s}" fill="${accent}"/>${reeds.join('')}${waves.join('')}`;
    }
  }
}

// A book cover, 300 × 420, in one of four house styles.
export function bookCover(b: CoverOf): string {
  const w = 300, h = 420;
  const r = prng(hash(b.title));
  const [ink, accent] = INK[b.topic];
  const paper = PAPER[hash(b.publisher) % PAPER.length];
  const author = b.authors.replace(/\s*(著|编|编著)$/, '');
  let body: string;
  switch (b.look) {
    case 'band':             // paper, a band of ink down the left with the title set in it
      body = `<rect width="${w}" height="${h}" fill="${paper}"/><rect x="0" y="0" width="78" height="${h}" fill="${ink}"/>` +
        vertical(40, 74, b.title, 32, paper, { weight: 700, gap: 1.2 }) +
        motif(b.topic, 108, 92, 170, ink, accent, r) +
        vertical(272, 300, author, 13, DARK, { font: SANS }) +
        `<line x1="100" y1="370" x2="276" y2="370" stroke="${DARK}" stroke-width=".8"/>` +
        text(100, 392, b.publisher, 11, DARK, { font: SANS, spacing: 1 });
      break;
    case 'full': {           // ink edge to edge, the title large at the top, the motif in paper colour below
      const ls = lines(b.title, 5);
      body = `<rect width="${w}" height="${h}" fill="${ink}"/>` +
        ls.map((l, i) => text(28, 74 + i * 44, l, 38, paper, { weight: 700, spacing: 2 })).join('') +
        `<line x1="28" y1="${96 + (ls.length - 1) * 44}" x2="120" y2="${96 + (ls.length - 1) * 44}" stroke="${accent}" stroke-width="2"/>` +
        (b.en ? text(28, 116 + (ls.length - 1) * 44, b.en.toUpperCase(), 9, paper, { font: SANS, spacing: 2.2, opacity: 0.75 }) : '') +
        `<g opacity=".95">${motif(b.topic, 60, 170, 200, paper, accent, r)}</g>` +
        text(28, 388, author, 13, paper, { font: SANS, spacing: 1 }) +
        text(272, 388, b.publisher, 10, paper, { font: SANS, anchor: 'end', opacity: 0.8 });
      break;
    }
    case 'motif': {          // the motif carries the cover; the title under it
      const ls = lines(b.title, 7);
      body = `<rect width="${w}" height="${h}" fill="${paper}"/>` +
        `<rect x="22" y="22" width="${w - 44}" height="${h - 44}" fill="none" stroke="${ink}" stroke-width=".8" stroke-opacity=".5"/>` +
        motif(b.topic, 50, 46, 200, ink, accent, r) +
        ls.map((l, i) => text(w / 2, 292 + i * 34, l, 28, DARK, { anchor: 'middle', weight: 700, spacing: 3 })).join('') +
        text(w / 2, 300 + ls.length * 34, author, 12, DARK, { font: SANS, anchor: 'middle', spacing: 2, opacity: 0.8 }) +
        `<rect x="${w / 2 - 34}" y="372" width="10" height="10" fill="${ink}"/>` +
        text(w / 2 - 18, 381, b.publisher, 10, DARK, { font: SANS, spacing: 1 });
      break;
    }
    case 'series': {         // a translated series: its band at the top, the original author under the title
      body = `<rect width="${w}" height="${h}" fill="${paper}"/><rect x="0" y="0" width="${w}" height="70" fill="${ink}"/>` +
        text(28, 42, b.series ?? '译丛', 13, paper, { font: SANS, spacing: 4 }) +
        text(272, 42, `No.${String(1 + (hash(b.title) % 40)).padStart(2, '0')}`, 11, accent, { font: SANS, anchor: 'end', spacing: 1 }) +
        motif(b.topic, 170, 96, 110, ink, accent, r) +
        lines(b.title, 6).map((l, i) => text(28, 252 + i * 40, l, 34, DARK, { weight: 700, spacing: 2 })).join('') +
        (b.original ? text(28, 296, b.original, 12, ink, { italic: true, font: 'Georgia,serif' }) : '') +
        text(28, 318, `${author}${b.translators ? `　${b.translators}` : ''}`, 11, DARK, { font: SANS, opacity: 0.85 }) +
        `<line x1="28" y1="372" x2="272" y2="372" stroke="${ink}" stroke-width="2"/><line x1="28" y1="377" x2="272" y2="377" stroke="${ink}" stroke-width=".6"/>` +
        text(28, 398, b.publisher, 10, DARK, { font: SANS, spacing: 1 });
      break;
    }
  }
  return uri(open(w, h) + `<defs>${GRAIN}${SPINE}</defs>` + body + grain + spine + '</svg>');
}

// A film's poster: dark, the motif as its one image, the title over a billing block.
export function poster(title: string, topic: Topic, line: string): string {
  const w = 300, h = 420, r = prng(hash(title));
  const [ink, accent] = INK[topic];
  const billing = Array.from({ length: 3 }, (_, i) => `<rect x="${60 + (i % 2) * 8}" y="${384 + i * 6}" width="${180 - (i % 2) * 16}" height="2" fill="#fff" fill-opacity=".35"/>`).join('');
  return uri(open(w, h) + `<defs>${GRAIN}<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ink}"/><stop offset="1" stop-color="#0d0f12"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#sky)"/><g opacity=".9">${motif(topic, 40, 60, 220, accent, '#f4efe4', r)}</g>` +
    text(w / 2, 330, title, 30, '#f4efe4', { anchor: 'middle', weight: 700, spacing: 6 }) +
    text(w / 2, 356, line, 10, '#f4efe4', { font: SANS, anchor: 'middle', spacing: 3, opacity: 0.7 }) + billing + grain + '</svg>');
}

// A record's sleeve: square, bold, the title small in a corner.
export function sleeve(title: string, topic: Topic): string {
  const s = 300, r = prng(hash(title));
  const [ink, accent] = INK[topic];
  return uri(open(s, s) + `<defs>${GRAIN}</defs><rect width="${s}" height="${s}" fill="${accent}"/>` +
    motif(topic, 30, 30, 240, ink, '#f4efe4', r) + text(20, 282, title, 14, ink, { font: SANS, weight: 700, spacing: 2 }) + grain + '</svg>');
}

// A post's picture, with no words in it: a sky of its own (day, dusk, night or fog), and the subject
// drawn large, placed, sized and turned differently for each post so two on one subject differ.
export function scene(topic: Topic, key: string, w = 640, h = 400): string {
  const k = hash(key), r = prng(k);
  const [ink, accent] = INK[topic];
  const paper = PAPER[k % PAPER.length];
  const skies: [string, string, string, string][] = [     // top, bottom, motif ink, motif accent
    [paper, accent, ink, accent], [accent, ink, DARK, paper], [ink, '#121417', accent, paper], ['#d9d6cf', paper, ink, accent],
  ];
  const [top, bottom, mInk, mAccent] = skies[(k >>> 3) % skies.length];
  const s = Math.min(w, h) * (0.6 + r() * 0.32);
  const x = (w - s) * (0.15 + r() * 0.7), y = (h - s) * (0.3 + r() * 0.6);
  const flip = r() < 0.5 ? ` transform="translate(${w} 0) scale(-1 1)"` : '';
  return uri(open(w, h) + `<defs>${GRAIN}<linearGradient id="bg" x1="0" y1="0" x2="${r() < 0.5 ? 1 : 0}" y2="1"><stop offset="0" stop-color="${top}"/>` +
    `<stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>` +
    `<g${flip}>${motif(topic, x, y, s, mInk, mAccent, r)}</g>` + grain + '</svg>');
}
