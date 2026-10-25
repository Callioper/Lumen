// Measures how one article is read — furthest scroll point and time actively on screen —
// and reports it when the article is left (server/rec/signals.ts classifies it).

// No input for this long and the time stops counting: the reader walked away.
const IDLE_MS = 30_000;
const TICK_MS = 1_000;

export interface ViewContext { listScope: string; sortMode: 'latest' | 'recommend'; position: number }

interface View { entryId: number; ctx: ViewContext; progress: number; activeMs: number }

let current: View | null = null;
let lastInput = 0;
let lastTick = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const onInput = (): void => { lastInput = Date.now(); };

function tick(): void {
  const now = Date.now();
  if (current && document.visibilityState === 'visible' && now - lastInput < IDLE_MS) current.activeMs += now - lastTick;
  lastTick = now;
}

function send(v: View): void {
  // keepalive lets the report finish while the page unloads; sendBeacon cannot carry the x-lumen header.
  void fetch(`/api/entries/${v.entryId}/view`, {
    method: 'POST', keepalive: true,
    headers: { 'x-lumen': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ progress: v.progress, activeMs: Math.round(v.activeMs), ...v.ctx }),
  }).catch(() => { /* a lost view only weakens the profile a little */ });
}

export function endView(): void {
  if (!current) return;
  tick();
  send(current);
  current = null;
}

export function startView(entryId: number, ctx: ViewContext): void {
  if (current?.entryId === entryId) return;
  endView();
  current = { entryId, ctx, progress: 0, activeMs: 0 };
  lastInput = lastTick = Date.now();
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'scroll'] as const) window.addEventListener(ev, onInput, { passive: true, capture: true });
    window.addEventListener('pagehide', endView);
  }
}

// Called on scroll and once the body has rendered; an article that fits on screen is read to its end at once.
export function noteProgress(entryId: number, el: HTMLElement): void {
  if (current?.entryId !== entryId) return;
  const p = el.scrollHeight <= el.clientHeight ? 1 : (el.scrollTop + el.clientHeight) / el.scrollHeight;
  current.progress = Math.max(current.progress, Math.min(1, p));
}
