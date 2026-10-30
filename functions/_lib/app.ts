import { Hono } from 'hono';
import { chat, PROVIDERS, type Env as ProviderEnv } from './providers';
import {
  d1Store, requestCode, verifyCode, sessionFromToken, logout, readCookie,
  sessionCookie, clearSessionCookie, SESSION_COOKIE, CODE_TTL_SEC, type AuthStore, type User,
} from './auth';
import { loginCodeMail, sendMail, type MailEnv } from './mail';
import { extractResumeText, ExtractError, MAX_FILE_BYTES, MIN_TEXT_CHARS, normalizeText, selfTestExtract } from './extract';
import { analyzeResume, d1ProfileStore, publicProfile, SELF_TEST_RESUME, type ProfileStore } from './profile';
import { d1OnboardingStore, validateAnswers, type OnboardingStore } from './onboarding';
import { d1ItemStore, generateItems, parseGenerateBody, publicItem, KINDS, KIND_LABELS, LEVELS, TOPICS, DEFAULT_COUNT, MAX_COUNT, type ItemStore, type Kind, type Level, type Status, STATUSES } from './items';
import { d1AssessmentStore, startOrResume, answer as answerAssessment, abandon, current as currentAssessment, rescore, AssessmentError, TOTAL, ADAPTIVE_COUNT, type AssessmentStore } from './assessment';

export interface Env extends ProviderEnv, MailEnv {
  /** Только для локальной разработки: при '1' код входа возвращается в ответе, если почта не настроена. */
  DEV_ECHO_CODE?: string;
}

export type Store = AuthStore & ProfileStore & OnboardingStore & ItemStore & AssessmentStore;

type Vars = { store: Store; auth: { user: User; sessionId: string } | null };

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, locale: u.locale, tz: u.tz });

const EXTRACT_STATUS: Record<ExtractError['code'], number> = {
  resume_unsupported: 415, resume_too_large: 413, resume_unreadable: 422, resume_no_text: 422, resume_too_short: 400,
};

/** Создаёт приложение API. Хранилище можно подменить (тесты). */
export function createApp(version: string, makeStore: (env: Env) => Store = env => ({ ...d1Store(env.DB), ...d1ProfileStore(env.DB), ...d1OnboardingStore(env.DB), ...d1ItemStore(env.DB), ...d1AssessmentStore(env.DB) })) {
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
    const out: Record<string, unknown> = { ok: db === 'ok' && ai === 'ok', version, db, ai, mail: c.env.RESEND_API_KEY ? 'ok' : 'missing' };
    // ?deep=1 — прогон извлечения текста на крошечных встроенных PDF и DOCX: проверяет, что pdf.js и zip работают в этой среде.
    if (c.req.query('deep') === '1' || c.req.query('deep') === '2') {
      out.extract = await selfTestExtract();
      // и один короткий вызов встроенной модели — ловит ошибки Workers AI (лимиты, имя модели, формат ответа)
      try {
        const reply = await chat(c.env, [{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 8 });
        out.ai_chat = reply.trim() ? 'ok' : 'error: empty reply';
      } catch (e) { out.ai_chat = `error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`; }
      // ?deep=2 — полный разбор встроенного тестового резюме моделью: воспроизводит путь «резюме → профиль» в проде.
      if (c.req.query('deep') === '2') {
        try {
          const a = await analyzeResume(c.env, SELF_TEST_RESUME);
          out.analysis = `ok: ${a.specialty} / ${a.industry} / ${a.years} лет / ${a.keywords.length} терминов`;
        } catch (e) { out.analysis = `error: ${String(e instanceof Error ? e.message : e).slice(0, 400)}`; }
      }
    }
    return c.json(out);
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

  // --- резюме и профиль ---

  app.get('/profile', requireAuth, async (c) => {
    const p = await c.get('store').getProfile(c.get('auth')!.user.id);
    return c.json({ ok: true, profile: p ? publicProfile(p) : null });
  });

  /** Загрузка резюме: multipart с полем file (PDF, DOCX, TXT) или JSON {text}. Текст сохраняется сразу,
   *  затем модель строит профиль; если разбор не удался — 502, текст остаётся, можно повторить /resume/analyze. */
  app.post('/resume', requireAuth, async (c) => {
    const userId = c.get('auth')!.user.id;
    const ct = c.req.header('content-type') ?? '';
    let text: string; let name: string | null = null;
    try {
      if (ct.includes('multipart/form-data')) {
        const len = Number(c.req.header('content-length') ?? 0);
        if (len > MAX_FILE_BYTES + 4096) return c.json({ ok: false, error: 'resume_too_large' }, 413);
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) return c.json({ ok: false, error: 'resume_missing' }, 400);
        name = file.name.slice(0, 200);
        text = (await extractResumeText(file.name, file.type, await file.arrayBuffer())).text;
      } else {
        const body = await c.req.json().catch(() => ({}));
        text = normalizeText(typeof body.text === 'string' ? body.text : '');
        if (text.length < MIN_TEXT_CHARS) return c.json({ ok: false, error: 'resume_too_short' }, 400);
        name = 'текст';
      }
    } catch (e) {
      if (e instanceof ExtractError) return c.json({ ok: false, error: e.code }, EXTRACT_STATUS[e.code] as 400);
      throw e;
    }
    const now = new Date().toISOString();
    await c.get('store').saveResume(userId, text, name, now);
    return analyze(c, userId, text);
  });

  /** Повторный разбор уже сохранённого текста резюме. */
  app.post('/resume/analyze', requireAuth, async (c) => {
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

  // --- анкета знакомства ---

  /** Шесть ответов анкеты. Часовой пояс пишется в users, остальное — в profiles; разбор резюме не трогается. */
  app.put('/onboarding', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const v = validateAnswers(body);
    if (!v.ok) return c.json({ ok: false, error: 'onboarding_invalid', field: v.field, reason: v.reason }, 400);
    await c.get('store').saveAnswers(user.id, v.answers, new Date().toISOString());
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, profile: p ? publicProfile(p) : null, user: publicUser({ ...user, tz: v.answers.tz }) });
  });

  // --- банк заданий ---

  /** Справочник банка: уровни, виды и темы — для формы пополнения. */
  app.get('/items/topics', (c) => c.json({
    ok: true, levels: LEVELS, kinds: KINDS.map(id => ({ id, label: KIND_LABELS[id] })), topics: TOPICS, defaultCount: DEFAULT_COUNT, maxCount: MAX_COUNT,
  }));

  /** Сводка: сколько заданий в банке по уровню, виду и статусу. */
  app.get('/items/stats', requireAuth, async (c) => c.json({ ok: true, stats: await c.get('store').bankStats() }));

  /** Задания банка с ключами и заметками проверки — для просмотра владельцем. Фильтры: level, topic, kind, status, limit. */
  app.get('/items/bank', requireAuth, async (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    const level = q('level'), kind = q('kind'), status = q('status');
    if (level && !(LEVELS as readonly string[]).includes(level)) return c.json({ ok: false, error: 'items_invalid', field: 'level' }, 400);
    if (kind && !(KINDS as readonly string[]).includes(kind)) return c.json({ ok: false, error: 'items_invalid', field: 'kind' }, 400);
    if (status && !(STATUSES as readonly string[]).includes(status)) return c.json({ ok: false, error: 'items_invalid', field: 'status' }, 400);
    const items = await c.get('store').listItems({ level: level as Level, kind: kind as Kind, status: status as Status, topic: q('topic'), limit: Number(q('limit') ?? 50) || 50 });
    return c.json({ ok: true, items: items.map(publicItem) });
  });

  /** Пополнение банка: модель пишет задания по теме и уровню в домене пользователя, второй прогон проверяет каждое. */
  app.post('/items/generate', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const v = parseGenerateBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'items_invalid', field: v.field }, 400);
    const p = await c.get('store').getProfile(c.get('auth')!.user.id);
    const domain = { specialty: p?.specialty ?? null, industry: p?.industry ?? null, targetRole: p?.targetRole ?? null, keywords: p?.keywords ?? [] };
    try {
      const r = await generateItems(c.env, c.get('store'), { kind: v.kind, level: v.level, topic: v.topic, count: v.count, domain });
      const verified = r.items.filter(i => i.status === 'verified').length;
      return c.json({ ok: true, requested: v.count, verified, rejected: r.items.length - verified, dropped: r.dropped, items: r.items.map(publicItem) });
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e).slice(0, 300);
      console.error('item generation failed', detail);
      return c.json({ ok: false, error: 'items_failed', detail }, 502);
    }
  });

  // --- тест уровня ---

  const domainOf = async (c: any) => {
    const p = await c.get('store').getProfile(c.get('auth')!.user.id);
    return { specialty: p?.specialty ?? null, industry: p?.industry ?? null, targetRole: p?.targetRole ?? null, keywords: p?.keywords ?? [] };
  };
  const ASSESSMENT_STATUS: Record<AssessmentError['code'], number> = { assessment_none: 404, assessment_stale: 409, assessment_finished: 409, answer_invalid: 400, bank_empty: 502 };
  const assessmentFail = (c: any, e: unknown) => {
    if (e instanceof AssessmentError) return c.json({ ok: false, error: e.code, reason: e.reason, detail: e.message !== e.code ? e.message : undefined }, ASSESSMENT_STATUS[e.code]);
    throw e;
  };

  /** Состояние теста: активный с текущим заданием (без ключа) или последний завершённый с уровнем; null — теста не было. */
  app.get('/assessment', requireAuth, async (c) => c.json({ ok: true, total: TOTAL, adaptive: ADAPTIVE_COUNT, assessment: await currentAssessment(c.get('store'), c.get('auth')!.user.id) }));

  /** Начать или продолжить: возвращает текущее задание. Если банк пуст — модель пишет задание (до минуты). */
  app.post('/assessment/start', requireAuth, async (c) => {
    try { return c.json({ ok: true, assessment: await startOrResume(c.env, c.get('store'), c.get('auth')!.user.id, await domainOf(c)) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Ответ на текущее задание: {attemptId, answer}. Ответ проверяется сравнением с эталоном; после последнего (письма)
   *  модель оценивает письмо по рубрике и образцу, считаются пять осей и уровень — ответ приходит с result. */
  app.post('/assessment/answer', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, assessment: await answerAssessment(c.env, c.get('store'), c.get('auth')!.user.id, body.attemptId, body.answer, await domainOf(c)) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Пересчитать оценку последнего завершённого теста: письмо оценивается заново, если прошлый раз модель не ответила
   *  (или {force: true}); оси и уровень считаются заново. Для тестов, пройденных до появления оценки. */
  app.post('/assessment/score', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, assessment: await rescore(c.env, c.get('store'), c.get('auth')!.user.id, {}, body?.force === true) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Бросить начатый тест: следующий start начнёт новый, виденные задания не повторятся. */
  app.post('/assessment/abandon', requireAuth, async (c) => c.json({ ok: true, abandoned: await abandon(c.get('store'), c.get('auth')!.user.id) }));

  return app;
}
