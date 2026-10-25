import type { Settings } from '../config.ts';
import { fetch } from 'undici';
import { httpPost } from '../fetch/post.ts';
import { dispatcherFor } from '../fetch/http.ts';

const MODELS_TIMEOUT_MS = 15_000;

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly perPost: boolean;       // this request was refused (its content, its size), not the account
  constructor(message: string, retryable: boolean, perPost = false) {
    super(message);
    this.retryable = retryable;
    this.perPost = perPost;
  }
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export async function chat(messages: ChatMessage[], settings: Settings, apiKey: string, maxTokens = 2048, timeoutMs = 120_000,
  extraBody: Record<string, unknown> = {}): Promise<string> {
  if (!apiKey) throw new LlmError('未配置 AI 密钥', false);
  const url = settings.ai.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const res = await httpPost(url, { model: settings.ai.model, messages, temperature: 0.2, max_tokens: maxTokens, stream: false, ...extraBody },
    { authorization: `Bearer ${apiKey}` }, settings, timeoutMs);
  if (res.status === 429 || res.status >= 500) throw new LlmError(`AI 服务 HTTP ${res.status}`, true);
  if (res.status === 422 && res.text.includes('sensitive')) throw new LlmError('内容被 AI 服务的审查拒绝', false, true);
  if (res.status >= 400) throw new LlmError(`AI 服务 HTTP ${res.status}: ${res.text.slice(0, 200)}`, false, res.status === 400 || res.status === 413 || res.status === 422);
  let data: { choices?: { message?: { content?: string } }[]; base_resp?: { status_code?: number; status_msg?: string } };
  try { data = JSON.parse(res.text); } catch { throw new LlmError('AI 返回不是 JSON', true); }
  // MiniMax reports some errors with HTTP 200 + base_resp.
  if (data.base_resp?.status_code) throw new LlmError(`AI 服务错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg}`, data.base_resp.status_code === 1002);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError('AI 返回为空', true);
  return stripThinking(content);
}

// OpenAI-compatible model listing (MiniMax serves it too).
export async function listModels(settings: Settings, apiKey: string): Promise<string[]> {
  if (!apiKey) throw new LlmError('未配置 AI 密钥', false);
  const url = new URL(settings.ai.baseUrl.replace(/\/$/, '') + '/models');
  const res = await fetch(url, {
    dispatcher: dispatcherFor(url, settings),
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status >= 400) throw new LlmError(`拉取模型列表失败：HTTP ${res.status} ${text.slice(0, 120)}`, false);
  let data: { data?: { id?: unknown }[] };
  try { data = JSON.parse(text); } catch { throw new LlmError('模型列表不是 JSON', false); }
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}
