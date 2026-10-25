// Links into 知网's search, built from what a report already knows: no fetching, no login.
// Both formats were tried in the browser (2026-10-23): korder=TI searches 篇名, korder=LY 文献来源,
// the latter listing the newest issue first.
const SEARCH = 'https://kns.cnki.net/kns8s/defaultresult/index';

// A subtitle is often cut or reworded between a journal's table of contents and a 公众号 repost;
// the main title alone still finds the paper.
export function mainTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const cut = t.split(/——|—|：|:|\s-\s/)[0].trim();
  return cut.length >= 4 ? cut : t;
}

export const cnkiTitleUrl = (title: string): string => `${SEARCH}?korder=TI&kw=${encodeURIComponent(mainTitle(title))}`;

// Feed names shorten the edition in brackets; 知网 spells it out.
const EDITIONS: [RegExp, string][] = [
  [/哲社版/, '哲学社会科学版'], [/人文社科版/, '人文社会科学版'], [/社科版/, '社会科学版'], [/人文版/, '人文科学版'],
];

// "《江西社会科学》2026年第6期" → 江西社会科学; "南开学报(哲社版)" → 南开学报(哲学社会科学版).
export function sourceName(venue: string): string {
  const quoted = /《([^》]+)》/.exec(venue)?.[1];
  let s = (quoted ?? venue).trim().replace(/（/g, '(').replace(/）/g, ')');
  for (const [re, full] of EDITIONS) s = s.replace(re, full);
  return s;
}

export const cnkiSourceUrl = (venue: string): string => `${SEARCH}?korder=LY&kw=${encodeURIComponent(sourceName(venue))}`;
