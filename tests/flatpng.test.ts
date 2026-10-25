import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { isFlatCutout } from '../server/clip/flatpng.ts';

// An 8-bit RGBA PNG whose pixels come from px(x, y), every scanline with filter 0 (None) or 2 (Up).
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number, number], filter = 0): Buffer {
  const rows: number[] = [];
  let prev = Buffer.alloc(w * 4);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) row.set(px(x, y), x * 4);
    rows.push(filter, ...(filter === 2 ? row.map((v, i) => (v - prev[i]) & 0xff) : row));
    prev = row;
  }
  const chunk = (kind: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(kind, 'ascii'), body, Buffer.alloc(4)]);   // CRC is not checked
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('a flat cut-out on a transparent ground is page furniture; screenshots and see-through diagrams are kept', () => {
  // A blue question-mark-like blob: half the canvas clear, one colour.
  const mark = (x: number): [number, number, number, number] => (x < 100 ? [120, 190, 240, 255] : [0, 0, 0, 0]);
  assert.equal(isFlatCutout(png(200, 300, mark)), true);
  assert.equal(isFlatCutout(png(200, 300, mark, 2)), true);
  // A screenshot: opaque, whatever its colours.
  assert.equal(isFlatCutout(png(200, 300, () => [250, 250, 250, 255])), false);
  // A diagram on a transparent ground: as clear, but many shades.
  assert.equal(isFlatCutout(png(200, 300, (x, y) => (x < 100 ? [(x * 7) & 255, (y * 3) & 255, (x * y) & 255, 255] : [0, 0, 0, 0]))), false);
  // Not a PNG, or not one it reads: kept.
  assert.equal(isFlatCutout(Buffer.from('GIF89a')), false);
});
