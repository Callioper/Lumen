// The time of day an event starts, for 首页's 今天 cards and the notice rows: what the AI read (Notice.time)
// or, for a post read before it was asked for, the time written next to the event's date in the post:
// 「10月29日（周三）14:00-16:00」, 「2026年10月29日 下午2点半」, 「10.29 19:30」. A post that names one time only
// is taken at it, wherever it stands. '' when the post does not say.

const CLOCK = /(上午|中午|下午|晚上|晚|早上)?\s*(\d{1,2})\s*(?:[:：](\d{2})|点(半|\d{1,2}分?)?)/g;
const AFTER_DATE = 40;     // characters after the date the time is looked for in

function hhmm(m: RegExpExecArray): string | null {
  const [, part, h0, mm, dian] = m;
  let h = Number(h0);
  const min = mm ? Number(mm) : dian === '半' ? 30 : dian ? Number(dian.replace('分', '')) : 0;
  if (h > 23 || min > 59) return null;
  // a time said in 点 needs a part of the day or a plausible hour: 「3点」 alone may be anything
  if (!mm && !part && (h < 7 || h > 22)) return null;
  if ((part === '下午' || part === '晚上' || part === '晚') && h < 12) h += 12;
  if (part === '中午' && h < 6) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function clocks(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(CLOCK)) {
    const t = hhmm(m as RegExpExecArray);
    if (t) out.push(t);
  }
  return out;
}

// The ways a post writes the day: 2026-10-29, 2026年10月29日, 10月29日, 10.29, 10/29.
function dayMarks(date: string): RegExp {
  const [y, m, d] = date.split('-').map(Number);
  return new RegExp(`(?:${y}\\s*[年./-]\\s*)?0?${m}\\s*(?:月|[./-])\\s*0?${d}(?!\\d)\\s*日?`, 'g');
}

export function eventTime(text: string, date: string): string {
  if (!date || !text) return '';
  for (const m of text.matchAll(dayMarks(date))) {
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + AFTER_DATE)
      // the weekday between the date and the time: 「（周三）」「星期三」
      .replace(/^\s*[（(]?\s*(周|星期|礼拜)[一二三四五六日天]\s*[)）]?/, '');
    const first = clocks(after)[0];
    if (first) return first;
  }
  const all = [...new Set(clocks(text).filter((t) => t >= '07:00'))];
  return all.length === 1 ? all[0] : '';
}
