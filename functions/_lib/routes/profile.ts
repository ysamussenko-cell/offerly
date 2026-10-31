/** Резюме и профиль (2.2) и анкета знакомства (2.3). */
import { extractResumeText, MAX_FILE_BYTES, MIN_TEXT_CHARS, normalizeText } from '../extract';
import { analyzeResume, publicProfile } from '../profile';
import { validateAnswers } from '../onboarding';
import { area, bodyOf, publicUser, requireAuth } from './context';

export function profileRoutes() {
  const r = area();

  r.get('/profile', requireAuth, async (c) => {
    const p = await c.get('store').getProfile(c.get('auth')!.user.id);
    return c.json({ ok: true, profile: p ? publicProfile(p) : null });
  });

  /** Загрузка резюме: multipart с полем file (PDF, DOCX, TXT) или JSON {text}. Текст сохраняется сразу,
   *  затем модель строит профиль; если разбор не удался — 502, текст остаётся, можно повторить /resume/analyze.
   *  Ошибки извлечения (ExtractError) уходят в app.onError со своим статусом. */
  r.post('/resume', requireAuth, async (c) => {
    const userId = c.get('auth')!.user.id;
    const ct = c.req.header('content-type') ?? '';
    let text: string; let name: string | null = null;
    if (ct.includes('multipart/form-data')) {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > MAX_FILE_BYTES + 4096) return c.json({ ok: false, error: 'resume_too_large' }, 413);
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ ok: false, error: 'resume_missing' }, 400);
      name = file.name.slice(0, 200);
      text = (await extractResumeText(file.name, file.type, await file.arrayBuffer())).text;
    } else {
      const body = await bodyOf(c);
      text = normalizeText(typeof body.text === 'string' ? body.text : '');
      if (text.length < MIN_TEXT_CHARS) return c.json({ ok: false, error: 'resume_too_short' }, 400);
      name = 'текст';
    }
    const now = new Date().toISOString();
    await c.get('store').saveResume(userId, text, name, now);
    return analyze(c, userId, text);
  });

  /** Повторный разбор уже сохранённого текста резюме. */
  r.post('/resume/analyze', requireAuth, async (c) => {
    const userId = c.get('auth')!.user.id;
    const p = await c.get('store').getProfile(userId);
    if (!p?.resumeText) return c.json({ ok: false, error: 'resume_missing' }, 400);
    return analyze(c, userId, p.resumeText);
  });

  async function analyze(c: any, userId: string, text: string) {
    try {
      const a = await analyzeResume(c.env, text);
      await c.get('store').saveAnalysis(userId, a, new Date().toISOString());
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e).slice(0, 300);
      console.error('profile analysis failed', detail);
      const p = await c.get('store').getProfile(userId);
      return c.json({ ok: false, error: 'profile_failed', detail, profile: p ? publicProfile(p) : null }, 502);
    }
    const p = await c.get('store').getProfile(userId);
    return c.json({ ok: true, profile: p ? publicProfile(p) : null });
  }

  /** Шесть ответов анкеты. Часовой пояс пишется в users, остальное — в profiles; разбор резюме не трогается. */
  r.put('/onboarding', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const v = validateAnswers(body);
    if (!v.ok) return c.json({ ok: false, error: 'onboarding_invalid', field: v.field, reason: v.reason }, 400);
    await c.get('store').saveAnswers(user.id, v.answers, new Date().toISOString());
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, profile: p ? publicProfile(p) : null, user: publicUser({ ...user, tz: v.answers.tz }) });
  });

  return r;
}
