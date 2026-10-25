// 配色: published palettes, each with a light and a dark side, mapped onto the app's colour tokens
// (styles.css :root). The default, 纸墨, is what styles.css already says, so choosing it removes every
// override. The hex values are the palettes' own; where a palette has no step for a token (a second
// line colour, say) the nearest of its own steps is used. No DOM here: main.tsx applies tokensOf().

export type PaletteKey = 'plain' | 'flexoki' | 'solarized' | 'nord' | 'catppuccin' | 'rosepine' | 'everforest';

interface Tones {
  paper: string; paper2: string; raised: string;
  ink: string; ink2: string; ink3: string;
  line: string; line2: string;
  accent: string;   // --indigo: where you are, AI, the primary button
  seal: string;     // unread, 直播, new
  good: string; bad: string;
}
export interface Palette { key: PaletteKey; name: string; from: string; line: string; light: Tones; dark: Tones }

export const PALETTES: Palette[] = [
  {
    key: 'flexoki', name: '纸墨', from: 'Flexoki · 默认', line: '照印刷油墨和暖色纸调的，为读写长文设计。',
    light: { paper: '#FFFCF0', paper2: '#F2F0E5', raised: '#FFFCF0', ink: '#100F0F', ink2: '#575653', ink3: '#878580', line: '#E6E4D9', line2: '#DAD8CE', accent: '#24837B', seal: '#BC5215', good: '#66800B', bad: '#AF3029' },
    dark: { paper: '#100F0F', paper2: '#1C1B1A', raised: '#282726', ink: '#CECDC3', ink2: '#9F9D96', ink3: '#6F6E69', line: '#282726', line2: '#403E3C', accent: '#3AA99F', seal: '#DA702C', good: '#879A39', bad: '#D14D41' },
  },
  {
    key: 'plain', name: '素白', from: '中性灰', line: '白底中性灰，一点紫做强调，像常见的效率工具。',
    light: { paper: '#ffffff', paper2: '#f4f4f6', raised: '#ffffff', ink: '#18181b', ink2: '#52525b', ink3: '#8e8e98', line: '#ececef', line2: '#dedee3', accent: '#6553f5', seal: '#f2613f', good: '#22a55a', bad: '#e5484d' },
    dark: { paper: '#18181b', paper2: '#1f1f23', raised: '#26262b', ink: '#ececef', ink2: '#a8a8b3', ink3: '#72727d', line: '#27272c', line2: '#36363d', accent: '#9488ff', seal: '#ff7a59', good: '#4cc38a', bad: '#ff6369' },
  },
  {
    key: 'solarized', name: '日晒', from: 'Solarized', line: '老牌的低对比配色，米黄底，久看不累。',
    light: { paper: '#fdf6e3', paper2: '#eee8d5', raised: '#fdf6e3', ink: '#073642', ink2: '#586e75', ink3: '#839496', line: '#eee8d5', line2: '#e3dcc6', accent: '#268bd2', seal: '#cb4b16', good: '#859900', bad: '#dc322f' },
    dark: { paper: '#002b36', paper2: '#073642', raised: '#073642', ink: '#eee8d5', ink2: '#93a1a1', ink3: '#839496', line: '#073642', line2: '#0d4553', accent: '#268bd2', seal: '#cb4b16', good: '#859900', bad: '#dc322f' },
  },
  {
    key: 'nord', name: '北境', from: 'Nord', line: '北极的冷灰蓝，安静、克制。',
    light: { paper: '#ECEFF4', paper2: '#E5E9F0', raised: '#ECEFF4', ink: '#2E3440', ink2: '#4C566A', ink3: '#616E88', line: '#E5E9F0', line2: '#D8DEE9', accent: '#5E81AC', seal: '#D08770', good: '#A3BE8C', bad: '#BF616A' },
    dark: { paper: '#2E3440', paper2: '#3B4252', raised: '#3B4252', ink: '#ECEFF4', ink2: '#D8DEE9', ink3: '#8A93A5', line: '#3B4252', line2: '#4C566A', accent: '#88C0D0', seal: '#D08770', good: '#A3BE8C', bad: '#BF616A' },
  },
  {
    key: 'catppuccin', name: '奶咖', from: 'Catppuccin Latte / Mocha', line: '柔和的粉彩，浅色是拿铁，深色是摩卡。',
    light: { paper: '#eff1f5', paper2: '#e6e9ef', raised: '#eff1f5', ink: '#4c4f69', ink2: '#5c5f77', ink3: '#8c8fa1', line: '#dce0e8', line2: '#ccd0da', accent: '#8839ef', seal: '#fe640b', good: '#40a02b', bad: '#d20f39' },
    dark: { paper: '#1e1e2e', paper2: '#181825', raised: '#313244', ink: '#cdd6f4', ink2: '#bac2de', ink3: '#7f849c', line: '#313244', line2: '#45475a', accent: '#cba6f7', seal: '#fab387', good: '#a6e3a1', bad: '#f38ba8' },
  },
  {
    key: 'rosepine', name: '玫瑰松', from: 'Rosé Pine Dawn / Main', line: '玫瑰与松针，暖粉配深紫，偏文艺。',
    light: { paper: '#faf4ed', paper2: '#f2e9e1', raised: '#fffaf3', ink: '#575279', ink2: '#797593', ink3: '#9893a5', line: '#f2e9e1', line2: '#dfdad9', accent: '#907aa9', seal: '#d7827e', good: '#286983', bad: '#b4637a' },
    dark: { paper: '#191724', paper2: '#1f1d2e', raised: '#26233a', ink: '#e0def4', ink2: '#908caa', ink3: '#6e6a86', line: '#26233a', line2: '#403d52', accent: '#c4a7e7', seal: '#ebbcba', good: '#9ccfd8', bad: '#eb6f92' },
  },
  {
    key: 'everforest', name: '森林', from: 'Everforest', line: '常绿林的绿和米色，护眼取向。',
    light: { paper: '#FDF6E3', paper2: '#F4F0D9', raised: '#FDF6E3', ink: '#5C6A72', ink2: '#708089', ink3: '#939F91', line: '#EFEBD4', line2: '#E0DCC7', accent: '#35A77C', seal: '#F57D26', good: '#8DA101', bad: '#F85552' },
    dark: { paper: '#2D353B', paper2: '#232A2E', raised: '#343F44', ink: '#D3C6AA', ink2: '#9DA9A0', ink3: '#7A8478', line: '#343F44', line2: '#475258', accent: '#83C092', seal: '#E69875', good: '#A7C080', bad: '#E67E80' },
  },
];

export const DEFAULT_PALETTE: PaletteKey = 'flexoki';
// An unknown key (one kept from an older version) falls back to the default.
export const paletteOf = (key: PaletteKey | undefined): Palette => PALETTES.find((p) => p.key === key) ?? PALETTES[0];

// WCAG relative luminance and contrast, for picking the text colour on an accent and for the tests.
const channel = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// White on the accent where it reads, else the palette's darkest colour (pale accents of dark palettes).
export const onAccent = (t: Tones, dark: boolean): string => {
  const deep = dark ? t.paper : t.ink;
  return contrast('#ffffff', t.accent) >= contrast(deep, t.accent) ? '#ffffff' : deep;
};

// The CSS custom properties a palette sets; the soft and line tints are the accent and seal with alpha.
export function tokensOf(key: PaletteKey, dark: boolean): Record<string, string> {
  const t = paletteOf(key)[dark ? 'dark' : 'light'];
  const [soft, edge, sealSoft] = dark ? ['1c', '40', '22'] : ['14', '38', '1a'];
  return {
    '--paper': t.paper, '--paper-2': t.paper2, '--surface': t.paper, '--raised': t.raised,
    '--ink': t.ink, '--ink-2': t.ink2, '--ink-3': t.ink3, '--line': t.line, '--line-2': t.line2,
    '--indigo': t.accent, '--indigo-soft': t.accent + soft, '--indigo-line': t.accent + edge, '--on-accent': onAccent(t, dark),
    '--seal': t.seal, '--seal-soft': t.seal + sealSoft, '--good': t.good, '--bad': t.bad,
  };
}
// Every token any palette sets, to clear them when going back to the default.
export const TOKEN_NAMES = Object.keys(tokensOf('flexoki', false));
