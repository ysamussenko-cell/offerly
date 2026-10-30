import { Hono } from 'hono';
import { chat, PROVIDERS, type Env as ProviderEnv } from './providers';
import {
  d1Store, requestCode, verifyCode, sessionFromToken, logout, readCookie,
  sessionCookie, clearSessionCookie, SESSION_COOKIE, CODE_TTL_SEC, type AuthStore, type User,
} from './auth';
import { loginCodeMail, sendMail, type MailEnv } from './mail';

export interface Env extends ProviderEnv, MailEnv {
  /** Только для локальной разработки: при '1' код входа возвращается в ответе, если почта не настроена. */
  DEV_ECHO_CODE?: string;
}

type Vars = { store: AuthStore; auth: { user: User; sessionId: string } | null };

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, locale: u.locale, tz: u.tz });

/** Создаёт приложение API. Хранилище можно подменить (тесты). */
export function createApp(version: string, makeStore: (env: Env) => AuthStore = env => d1Store(env.DB)) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('store', makeStore(c.env));
    c.set('auth', null);
    await next();
  });

  const secure = (c: { req: { url: string } }) => new URL(c.req.url).protocol === 'https:';

  const requireAuth = async (c: any, next: () => Promise<void>) => {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    const found = await sessionFromToken(c.get('store'), token);
    if (!found) return c.json({ ok: false, error: 'unauthorized' }, 401);
    c.set('auth', { user: found.user, sessionId: found.session.id });
    await next();
  };

  app.get('/health', async (c) => {
    let db: 'ok' | 'missing' | 'error' = 'missing';
    let ai: 'ok' | 'missing' | 'error' = 'missing';
    if (c.env.DB) {
      try { await c.env.DB.prepare('select 1').first(); db = 'ok'; } catch { db = 'error'; }
    }
    if (c.env.AI) ai = 'ok';
    return c.json({ ok: db === 'ok' && ai === 'ok', version, db, ai, mail: c.env.RESEND_API_KEY ? 'ok' : 'missing' });
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

  // --- вход по почте ---

  app.post('/auth/request', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await requestCode(c.get('store'), body.email);
    if (!res.ok) {
      const status = res.reason === 'too_many' ? 429 : 400;
      return c.json({ ok: false, error: res.reason }, status);
    }
    const mail = await sendMail(c.env, String(body.email).trim().toLowerCase(), loginCodeMail(res.code, CODE_TTL_SEC / 60, c.env.APP_NAME));
    if (mail.sent) return c.json({ ok: true, delivery: 'email', expiresAt: res.expiresAt });
    if (mail.reason === 'provider_error') {
      console.error(mail.detail);
      return c.json({ ok: false, error: 'mail_failed' }, 502);
    }
    // Почта не настроена: в проде — честный отказ, локально — код в ответе.
    if (c.env.DEV_ECHO_CODE === '1') return c.json({ ok: true, delivery: 'echo', code: res.code, expiresAt: res.expiresAt });
    return c.json({ ok: false, error: 'mail_not_configured' }, 503);
  });

  app.post('/auth/verify', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await verifyCode(c.get('store'), body.email, body.code);
    if (!res.ok) {
      const status = res.reason === 'bad_input' ? 400 : res.reason === 'locked' ? 429 : 401;
      return c.json({ ok: false, error: res.reason }, status);
    }
    c.header('set-cookie', sessionCookie(res.token, res.expiresAt, secure(c)));
    return c.json({ ok: true, user: publicUser(res.user), isNew: res.isNew });
  });

  app.post('/auth/logout', async (c) => {
    await logout(c.get('store'), readCookie(c.req.header('cookie'), SESSION_COOKIE));
    c.header('set-cookie', clearSessionCookie(secure(c)));
    return c.json({ ok: true });
  });

  app.get('/me', requireAuth, (c) => c.json({ ok: true, user: publicUser(c.get('auth')!.user) }));

  return app;
}
