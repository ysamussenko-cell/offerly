import { Hono } from 'hono';
import { chat, PROVIDERS, type Env } from '../_lib/providers';

const app = new Hono<{ Bindings: Env }>().basePath('/api');
const VERSION = '0.1.0';

app.get('/health', async (c) => {
  let db: 'ok' | 'missing' | 'error' = 'missing';
  let ai: 'ok' | 'missing' | 'error' = 'missing';
  if (c.env.DB) {
    try { await c.env.DB.prepare('select 1').first(); db = 'ok'; } catch { db = 'error'; }
  }
  if (c.env.AI) ai = 'ok';
  return c.json({ ok: db === 'ok' && ai === 'ok', version: VERSION, db, ai });
});

app.get('/providers', (c) => c.json(PROVIDERS.map(({ id, name, short, keyUrl, defaultModel, free }) => ({ id, name, short, keyUrl, defaultModel, free }))));

app.post('/ai/ping', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = await chat(c.env, [
    { role: 'system', content: 'You are an English coach. Answer in one short sentence.' },
    { role: 'user', content: body.prompt ?? 'Say hello to a thermal power engineer preparing for an interview.' },
  ], { provider: body.provider, apiKey: body.apiKey, model: body.model, maxTokens: 120 });
  return c.json({ text });
});

export const onRequest: PagesFunction<Env> = (ctx) => app.fetch(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
