/** Вход по почте с кодом (2.1): запрос кода, проверка, выход, текущий пользователь. */
import { requestCode, verifyCode, logout, readCookie, sessionCookie, clearSessionCookie, SESSION_COOKIE, CODE_TTL_SEC } from '../auth';
import { loginCodeMail, sendMail } from '../mail';
import { area, bodyOf, publicUser, requireAuth, secure } from './context';

export function authRoutes() {
  const r = area();

  r.post('/auth/request', async (c) => {
    const body = await bodyOf(c);
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

  r.post('/auth/verify', async (c) => {
    const body = await bodyOf(c);
    const res = await verifyCode(c.get('store'), body.email, body.code);
    if (!res.ok) {
      const status = res.reason === 'bad_input' ? 400 : res.reason === 'locked' ? 429 : 401;
      return c.json({ ok: false, error: res.reason }, status);
    }
    c.header('set-cookie', sessionCookie(res.token, res.expiresAt, secure(c)));
    return c.json({ ok: true, user: publicUser(res.user), isNew: res.isNew });
  });

  r.post('/auth/logout', async (c) => {
    await logout(c.get('store'), readCookie(c.req.header('cookie'), SESSION_COOKIE));
    c.header('set-cookie', clearSessionCookie(secure(c)));
    return c.json({ ok: true });
  });

  r.get('/me', requireAuth, (c) => c.json({ ok: true, user: publicUser(c.get('auth')!.user) }));

  return r;
}
