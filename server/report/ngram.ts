// Character n-grams for telling two titles apart without a model: no dictionary, no word
// segmentation, mixed Chinese and Latin alike (from 评论尸《省 Token 技巧》, §3).
const MIN_N = 2;
const MAX_N = 4;

// Punctuation, spaces and the 「作者｜」 separators carry nothing; Latin is compared lowercase.
export const normTitle = (s: string): string => s.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

export function grams(s: string): Set<string> {
  const t = [...normTitle(s)];
  const out = new Set<string>();
  for (let n = MIN_N; n <= MAX_N; n++) for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(''));
  if (!out.size && t.length) out.add(t.join(''));
  return out;
}

// |A ∩ B| / min(|A|, |B|): a short title fully inside a long one counts as the same,
// where Jaccard would be diluted by everything the long one adds.
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

export const titleOverlap = (a: string, b: string): number => overlap(grams(a), grams(b));
