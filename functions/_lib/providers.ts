/** Провайдеры языковых моделей для режима «свой ключ» — перенесено из AI DJ (dj_llm.py).
 *  По умолчанию приложение работает на Workers AI без ключей; пользователь может подключить свой. */
export type ProviderId = 'workers-ai' | 'anthropic' | 'zai' | 'gemini' | 'groq' | 'mistral' | 'deepseek' | 'qwen' | 'openai';

export interface Provider {
  id: ProviderId; name: string; short: string; url?: string; keyUrl?: string; defaultModel: string;
  prefix?: string; serial?: boolean; free: boolean;
}

export const PROVIDERS: Provider[] = [
  { id: 'workers-ai', name: 'Встроенная модель (Cloudflare Workers AI)', short: 'Встроенная', defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', free: true },
  { id: 'anthropic', name: 'Claude (Anthropic)', short: 'Claude', url: 'https://api.anthropic.com/v1/messages', keyUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-haiku-4-5-20251001', prefix: 'sk-ant-', free: false },
  { id: 'zai', name: 'GLM (Z.ai) — бесплатные Flash-модели', short: 'GLM', url: 'https://api.z.ai/api/paas/v4/chat/completions', keyUrl: 'https://z.ai/manage-apikey/apikey-list', defaultModel: 'glm-4.7-flash', serial: true, free: true },
  { id: 'gemini', name: 'Gemini (Google) — бесплатный Flash', short: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-3.8-flash', free: true },
  { id: 'groq', name: 'Groq — бесплатный gpt-oss', short: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', keyUrl: 'https://console.groq.com/keys', defaultModel: 'openai/gpt-oss-120b', prefix: 'gsk_', free: true },
  { id: 'mistral', name: 'Mistral — бесплатный тариф', short: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', keyUrl: 'https://console.mistral.ai/api-keys', defaultModel: 'mistral-small-latest', free: true },
  { id: 'deepseek', name: 'DeepSeek', short: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', keyUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-flash', prefix: 'sk-', free: false },
  { id: 'qwen', name: 'Qwen (Alibaba Cloud)', short: 'Qwen', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', keyUrl: 'https://modelstudio.console.alibabacloud.com/', defaultModel: 'qwen-plus', prefix: 'sk-', free: false },
  { id: 'openai', name: 'GPT (OpenAI)', short: 'GPT', url: 'https://api.openai.com/v1/chat/completions', keyUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-5.4-mini', prefix: 'sk-', free: false },
];

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface Env { DB: D1Database; AI: Ai; APP_NAME: string }

/** Один вызов модели: встроенная через binding AI, остальные — OpenAI-совместимый HTTP или Anthropic. */
export interface ChatOpts { provider?: ProviderId; apiKey?: string; model?: string; maxTokens?: number;
  /** JSON-схема ответа: Workers AI получает её как json_schema (ответ гарантированно валиден), OpenAI-совместимые — json_object. */
  jsonSchema?: Record<string, unknown> }

export async function chat(env: Env, messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === (opts.provider ?? 'workers-ai'))!;
  const model = opts.model ?? provider.defaultModel;
  const maxTokens = opts.maxTokens ?? 1024;

  if (provider.id === 'workers-ai') {
    const input: Record<string, unknown> = { messages, max_tokens: maxTokens };
    if (opts.jsonSchema) input.response_format = { type: 'json_schema', json_schema: opts.jsonSchema };
    const out: any = await env.AI.run(model as any, input as any);
    if (typeof out === 'string') return out;
    const r = out?.response;
    return typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r);
  }
  if (!opts.apiKey) throw new Error('Для этого провайдера нужен ключ');

  if (provider.id === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest = messages.filter(m => m.role !== 'system');
    const r = await fetch(provider.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: rest }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    return j.content?.map((c: any) => c.text ?? '').join('') ?? '';
  }

  const r = await fetch(provider.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(opts.jsonSchema ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!r.ok) throw new Error(`${provider.short} ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}
