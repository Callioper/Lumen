// What of 学术动态 is due soon, for 首页: what falls on today, calls closing and talks or conferences starting.
import type { Notice } from './api.ts';

// How far ahead each list looks: a call needs time to write for, a talk only to be remembered.
export const DEADLINE_DAYS = 30;
export const EVENT_DAYS = 14;

const today = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const daysUntil = (ymd: string, from: Date = today()): number => Math.round((new Date(`${ymd}T00:00:00`).getTime() - from.getTime()) / 86_400_000);

export interface DueSoon { today: Notice[]; closing: Notice[]; starting: Notice[] }

// Today: what closes or is held today, and what is under way. Then deadlines (征稿, 申报, 招聘…) and
// what is held (会议, 讲座, 活动) within their windows; each nearest first, nothing in two lists.
export function dueSoon(items: readonly Notice[], from: Date = today()): DueSoon {
  const ahead = items.filter((n) => n.next && n.status === 'upcoming');
  const by = (a: Notice, b: Notice): number => a.next!.date.localeCompare(b.next!.date);
  const isToday = (n: Notice): boolean => n.next!.what === '进行中' || daysUntil(n.next!.date, from) <= 0;
  const later = ahead.filter((n) => !isToday(n));
  return {
    today: ahead.filter(isToday).sort((a, b) => Number(b.next!.what === '截止') - Number(a.next!.what === '截止') || by(a, b)),
    closing: later.filter((n) => n.next!.what === '截止' && daysUntil(n.next!.date, from) <= DEADLINE_DAYS).sort(by),
    starting: later.filter((n) => n.next!.what === '举办' && daysUntil(n.next!.date, from) <= EVENT_DAYS).sort(by),
  };
}
