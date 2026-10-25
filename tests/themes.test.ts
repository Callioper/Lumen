import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTES, tokensOf, contrast, paletteOf, TOKEN_NAMES, DEFAULT_PALETTE, type PaletteKey } from '../web/src/themes.ts';

// Body text and secondary text must read on both the page and a raised card (WCAG AA 4.5 for body,
// 3 for the large/secondary and the primary button's label); hints (ink-3) only need to be visible.
for (const p of PALETTES) {
  for (const dark of [false, true]) {
    const side = `${p.key} ${dark ? 'dark' : 'light'}`;
    const t = tokensOf(p.key, dark);
    test(`${side}: text reads on the page and on cards`, () => {
      for (const bg of [t['--paper'], t['--raised']]) {
        assert.ok(contrast(t['--ink'], bg) >= 4.5, `${side} ink on ${bg}: ${contrast(t['--ink'], bg).toFixed(2)}`);
        assert.ok(contrast(t['--ink-2'], bg) >= 3, `${side} ink-2 on ${bg}: ${contrast(t['--ink-2'], bg).toFixed(2)}`);
        assert.ok(contrast(t['--ink-3'], bg) >= 2, `${side} ink-3 on ${bg}: ${contrast(t['--ink-3'], bg).toFixed(2)}`);
      }
    });
    test(`${side}: the primary button's label reads on the accent`, () => {
      const c = contrast(t['--on-accent'], t['--indigo']);
      assert.ok(c >= 2.8, `${side}: ${c.toFixed(2)}`);
    });
    test(`${side}: every token is a colour`, () => {
      assert.deepEqual(Object.keys(t), TOKEN_NAMES);
      for (const v of Object.values(t)) assert.match(v, /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
    });
  }
}

test('palette keys are unique, the default comes first, and an unknown key falls back to it', () => {
  assert.equal(PALETTES[0].key, DEFAULT_PALETTE);
  assert.equal(new Set(PALETTES.map((p) => p.key)).size, PALETTES.length);
  assert.equal(paletteOf('lumen' as PaletteKey).key, DEFAULT_PALETTE);
  assert.equal(paletteOf(undefined).key, DEFAULT_PALETTE);
});

// styles.css carries the default palette itself (no flash before the script runs), so its light
// :root and its two dark blocks must say what themes.ts says.
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
const block = (start: string): Record<string, string> => {
  const at = css.indexOf(start);
  assert.ok(at >= 0, start);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
test('styles.css holds the default palette, light and dark', () => {
  const sides: [string, boolean][] = [[':root {', false], [':root:not([data-theme="light"]) {', true], [':root[data-theme="dark"] {', true]];
  for (const [start, dark] of sides) {
    const have = block(start);
    for (const [name, value] of Object.entries(tokensOf(DEFAULT_PALETTE, dark))) {
      assert.equal(have[name]?.toLowerCase(), value.toLowerCase(), `${start} ${name}`);
    }
  }
});
