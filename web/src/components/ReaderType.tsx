// 排版 in the reader: font, size, line spacing and column width, kept per device (prefs).
import { useEffect, useRef, useState } from 'preact/hooks';
import { prefs, setPrefs } from '../store.ts';
import { Icon } from './Icon.tsx';
import { cx } from '../util.ts';

const FONT_MIN = 14;
const FONT_MAX = 24;
const LINE_HEIGHTS: [number, string][] = [[1.6, '紧凑'], [1.85, '适中'], [2.1, '宽松']];
const WIDTHS: [number, string][] = [[620, '窄'], [720, '中'], [880, '宽']];

export function TypeMenu() {
  const [isOpen, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);
  const p = prefs.value;
  const size = (d: number): void => setPrefs({ fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, p.fontSize + d)) });
  return (
    <div class="layout-pick" ref={ref}>
      <button class={cx('icon-btn', isOpen && 'on')} title="排版：字体、字号、行距、栏宽" aria-haspopup="menu" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <Icon name="type" />
      </button>
      {isOpen && (
        <div class="menu type-menu" role="menu">
          <div class="type-row"><span>字体</span>
            <div class="seg">
              <button class={cx(!p.serif && 'on')} onClick={() => setPrefs({ serif: false })}>无衬线</button>
              <button class={cx(p.serif && 'on')} onClick={() => setPrefs({ serif: true })}>衬线</button>
            </div>
          </div>
          <div class="type-row"><span>字号</span>
            <div class="seg">
              <button onClick={() => size(-1)} disabled={p.fontSize <= FONT_MIN} aria-label="缩小">A−</button>
              <button class="type-value" onClick={() => setPrefs({ fontSize: 17 })} title="恢复 17">{p.fontSize}</button>
              <button onClick={() => size(1)} disabled={p.fontSize >= FONT_MAX} aria-label="放大">A+</button>
            </div>
          </div>
          <div class="type-row"><span>行距</span>
            <div class="seg">{LINE_HEIGHTS.map(([v, label]) => <button key={v} class={cx(p.lineHeight === v && 'on')} onClick={() => setPrefs({ lineHeight: v })}>{label}</button>)}</div>
          </div>
          <div class="type-row"><span>栏宽</span>
            <div class="seg">{WIDTHS.map(([v, label]) => <button key={v} class={cx(p.proseWidth === v && 'on')} onClick={() => setPrefs({ proseWidth: v })}>{label}</button>)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
