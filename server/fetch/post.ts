import { fetch } from 'undici';
import type { Settings } from '../config.ts';
import { dispatcherFor } from './http.ts';

export async function httpPost(url: string, body: unknown, headers: Record<string, string>, settings: Settings, timeoutMs: number):
  Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    dispatcher: dispatcherFor(new URL(url), settings),
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}
