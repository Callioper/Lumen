// What of 学术动态 is due soon, for 首页: calls closing and talks or conferences starting.
import type { Notice } from './api.ts';

// How far ahead each list looks: a call needs time to write for, a talk only to be remembered.
export const DEADLINE_DAYS = 30;
export const EVENT_DAYS = 14;

const today = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const daysUntil = (ymd: string, from: Date = today()): number => Math.round((new Date(`${ymd}T00:00:00`).getTime() - from.getTime()) / 86_400_000);

// Deadlines (征稿, 申报, 招聘…) and what is held (会议, 讲座, 活动), each nearest first.
export function dueSoon(items: readonly Notice[], from: Date = today()): { closing: Notice[]; starting: Notice[] } {
  const ahead = items.filter((n) => n.next && n.status === 'upcoming');
  const by = (a: Notice, b: Notice): number => a.next!.date.localeCompare(b.next!.date);
  return {
    closing: ahead.filter((n) => n.next!.what === '截止' && daysUntil(n.next!.date, from) <= DEADLINE_DAYS).sort(by),
    starting: ahead.filter((n) => n.next!.what === '进行中' || (n.next!.what === '举办' && daysUntil(n.next!.date, from) <= EVENT_DAYS)).sort(by),
  };
}
