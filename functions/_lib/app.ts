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
import { d1CardStore, publicCard, CARD_TOPICS, type CardStore } from './cards';
import { d1AssessmentStore, startOrResume, answer as answerAssessment, abandon, current as currentAssessment, rescore, AssessmentError, TOTAL, ADAPTIVE_COUNT, CHECKPOINT_TOTAL, CHECKPOINT_ADAPTIVE, SIGNIFICANT_DELTA, type AssessmentStore } from './assessment';
import { today as checkpointToday, startOrResume as startCheckpoint, answer as answerCheckpoint, rescore as rescoreCheckpoint, abandon as abandonCheckpoint } from './checkpoint';
import { d1ProgramStore, generateProgram, swapDays, current as currentProgram, ProgramError, PROGRAM_TOPICS, PROGRAM_DAYS, type ProgramStore } from './program';
import { d1LessonStore, today as lessonToday, startOrResume as startLesson, answer as answerLesson, bonus as bonusLesson, LessonError, WARMUP_COUNT, REVIEW_MAX, BONUS_MULTIPLIER, BONUS_CHANCE, type LessonStore } from './lesson';
import { d1DashboardStore, dashboard, parseGoal, GAIN_PER_LESSON, MISS_PENALTY, MISS_CAP, FREEZES_PER_WEEK, GOAL_MIN, GOAL_MAX, GOAL_DAYS_DEFAULT, type DashboardStore } from './dashboard';
import { d1AchievementStore, syncAchievements, ACHIEVEMENTS, type AchievementStore } from './achievements';
import { d1RehearsalStore, today as rehearsalToday, startOrResume as startRehearsal, answer as answerRehearsal, rescore as rescoreRehearsal, abandon as abandonRehearsal, RehearsalError, QUESTION_COUNT, ANSWER_WORDS, REPLACEMENTS, type RehearsalStore } from './rehearsal';
import { d1SpeechStore, recordSpeech, speak, publicSpeech, validateTtsText, selfTestVoice, VoiceError, MAX_AUDIO_BYTES, MAX_SECONDS, MAX_TTS_CHARS, STT_MODEL, TTS_MODEL, type SpeechStore } from './voice';
import { d1DigestStore, parseNotifyAt, digestState, nextDigest, buildDigest, sendDigestNow, localClock, minutesOf, DEFAULT_NOTIFY_AT, SEND_WINDOW_MINUTES, CRON_STEP_MINUTES, type DigestStore } from './digest';
import { d1PushStore, vapidKeys, parseSubscribeBody, publicSubscription, sendPushNow, sentOnIfPassed, PushError, VAPID_SETTING_KEY, type PushEnv, type PushStore } from './push';
import { d1SettingsStore, masterKey, parseKeyBody, saveKey, checkKey, userProvider, publicKey, providerOptions, decryptSecret, exportData, exportCounts, exportFileName, SettingsError, type SettingsEnv, type SettingsStore } from './settings';

export interface Env extends ProviderEnv, MailEnv, PushEnv, SettingsEnv {
  /** Адрес приложения для ссылок в письмах; без него — адрес по умолчанию из digest.ts. */
  APP_URL?: string;
  /** Только для локальной разработки: при '1' код входа возвращается в ответе, если почта не настроена. */
  DEV_ECHO_CODE?: string;
}

export type Store = AuthStore & ProfileStore & OnboardingStore & ItemStore & AssessmentStore & CardStore & ProgramStore & LessonStore & DashboardStore & AchievementStore & RehearsalStore & SpeechStore & DigestStore & PushStore & SettingsStore;

type Vars = { store: Store; auth: { user: User; sessionId: string } | null };

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, locale: u.locale, tz: u.tz });

const EXTRACT_STATUS: Record<ExtractError['code'], number> = {
  resume_unsupported: 415, resume_too_large: 413, resume_unreadable: 422, resume_no_text: 422, resume_too_short: 400,
};

/** Создаёт приложение API. Хранилище можно подменить (тесты). */
export function createApp(version: string, makeStore: (env: Env) => Store = env => ({ ...d1Store(env.DB), ...d1ProfileStore(env.DB), ...d1OnboardingStore(env.DB), ...d1ItemStore(env.DB), ...d1AssessmentStore(env.DB), ...d1CardStore(env.DB), ...d1ProgramStore(env.DB), ...d1LessonStore(env.DB), ...d1DashboardStore(env.DB), ...d1AchievementStore(env.DB), ...d1RehearsalStore(env.DB), ...d1SpeechStore(env.DB), ...d1DigestStore(env.DB), ...d1PushStore(env.DB), ...d1SettingsStore(env.DB) })) {
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
    // Свой ключ провайдера (4.6): расшифровывается на время запроса и уходит в env — chat() возьмёт его вместо встроенной модели.
    // Сбой чтения ключа не должен ронять запрос: без него работает встроенная модель.
    try {
      const own = await userProvider(c.env, c.get('store'), found.user.id);
      if (own) c.env = { ...c.env, USER_PROVIDER: own };
    } catch (e) { console.error('provider key unreadable', String(e instanceof Error ? e.message : e).slice(0, 200)); }
    await next();
  };

  app.get('/health', async (c) => {
    let db: 'ok' | 'missing' | 'error' = 'missing';
    let ai: 'ok' | 'missing' | 'error' = 'missing';
    if (c.env.DB) {
      try { await c.env.DB.prepare('select 1').first(); db = 'ok'; } catch { db = 'error'; }
    }
    if (c.env.AI) ai = 'ok';
    // push: откуда ключи VAPID — секреты окружения, запись в app_settings или ещё не создавались (создаются при первом GET /api/push)
    let push: 'env' | 'db' | 'pending' | 'error' = c.env.VAPID_PRIVATE_KEY ? 'env' : 'pending';
    if (push === 'pending' && db === 'ok') { try { push = (await c.get('store').getSetting(VAPID_SETTING_KEY)) ? 'db' : 'pending'; } catch { push = 'error'; } }
    const out: Record<string, unknown> = { ok: db === 'ok' && ai === 'ok', version, db, ai, mail: c.env.RESEND_API_KEY ? 'ok' : 'missing', push };
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
        // голосовой контур: MeloTTS озвучивает фразу, Whisper её распознаёт — проверка обеих моделей без записи с микрофона
        out.voice = await selfTestVoice(c.env);
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
  const ASSESSMENT_STATUS: Record<AssessmentError['code'], number> = { assessment_none: 404, assessment_stale: 409, assessment_finished: 409, assessment_busy: 409, answer_invalid: 400, bank_empty: 502 };
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

  // --- контрольный срез ---

  const checkpointMeta = { total: CHECKPOINT_TOTAL, adaptive: CHECKPOINT_ADAPTIVE, significant: SIGNIFICANT_DELTA };
  const profileOf = async (c: any) => c.get('store').getProfile(c.get('auth')!.user.id);

  /** Сегодня: срез ли по программе, следующий запланированный, активный или последний пройденный срез (со сравнением). */
  app.get('/checkpoint', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...checkpointMeta, ...(await checkpointToday(c.get('store'), user.id, user.tz)) });
  });

  /** Начать срез (восемь заданий со старта с текущего уровня, чтение, письмо) или продолжить начатый. Идёт тест уровня — assessment_busy 409. */
  app.post('/checkpoint/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    try { return c.json({ ok: true, ...checkpointMeta, checkpoint: await startCheckpoint(c.env, c.get('store'), user.id, user.tz, await profileOf(c)) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Ответ на текущее задание среза: {attemptId, answer}. После последнего — оценка, сравнение с прошлым тестом,
   *  день программы отмечается пройденным, оставшиеся дни программы пересобираются по новому профилю ошибок. */
  app.post('/checkpoint/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...checkpointMeta, checkpoint: await answerCheckpoint(c.env, c.get('store'), user.id, body.attemptId, body.answer, user.tz, await profileOf(c)) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Пересчитать последний завершённый срез (письмо не оценено или {force: true}). */
  app.post('/checkpoint/score', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...checkpointMeta, checkpoint: await rescoreCheckpoint(c.env, c.get('store'), user.id, user.tz, await profileOf(c), body?.force === true) }); }
    catch (e) { return assessmentFail(c, e); }
  });

  /** Бросить начатый срез: следующий start начнёт новый. */
  app.post('/checkpoint/abandon', requireAuth, async (c) => c.json({ ok: true, abandoned: await abandonCheckpoint(c.get('store'), c.get('auth')!.user.id) }));

  // --- журнал ошибок ---

  /** Карточки ошибок пользователя: к повтору — первыми, погашенные — в конце. Создание из ошибок и повторы по FSRS — 3.3. */
  app.get('/cards', requireAuth, async (c) => {
    const cards = await c.get('store').listCards(c.get('auth')!.user.id);
    return c.json({ ok: true, topics: CARD_TOPICS.map(({ id, label }) => ({ id, label })), cards: cards.map(publicCard) });
  });

  // --- программа на четыре недели ---

  const programFail = (c: any, e: unknown) => {
    if (e instanceof ProgramError) return c.json({ ok: false, error: e.code, reason: e.reason }, e.code === 'program_none' ? 404 : 400);
    throw e;
  };
  const programTopics = PROGRAM_TOPICS.map(({ id, label }) => ({ id, label }));

  /** Текущая программа: дни последней сборки с темой, форматом письма и причиной выбора; null — ещё не построена. */
  app.get('/program', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await currentProgram(c.get('store'), user.id, user.tz, p) });
  });

  /** Построить или пересобрать программу с сегодняшнего дня по журналу ошибок, последнему тесту и дате собеседования.
   *  Пройденные дни остаются, незавершённые заменяются. */
  app.post('/program/generate', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await generateProgram(c.get('store'), user.id, user.tz, p) });
  });

  /** Переставить темы двух дней занятий: {a, b} — id дней. Ошибка program_invalid с причиной not_found | same | not_lesson | not_planned | past. */
  app.post('/program/swap', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const p = await c.get('store').getProfile(user.id);
    try { return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await swapDays(c.get('store'), user.id, user.tz, p, body.a, body.b) }); }
    catch (e) { return programFail(c, e); }
  });

  // --- дневное занятие ---

  const LESSON_STATUS: Record<LessonError['code'], number> = { lesson_no_day: 404, lesson_unavailable: 409, lesson_none: 404, lesson_stale: 409, answer_invalid: 400, bank_empty: 502, lesson_eval_failed: 502, bonus_none: 409 };
  const lessonFail = (c: any, e: unknown) => {
    if (e instanceof LessonError) return c.json({ ok: false, error: e.code, reason: e.reason, detail: e.message !== e.code ? e.message : undefined }, LESSON_STATUS[e.code]);
    throw e;
  };
  const lessonMeta = { warmup: WARMUP_COUNT, reviewMax: REVIEW_MAX, bonusMultiplier: BONUS_MULTIPLIER, bonusChance: BONUS_CHANCE };
  /** После ответа — пересчёт достижений; только что открытые уходят в ответ, чтобы занятие показало их сразу. */
  const unlocked = async (c: any) => { const u = c.get('auth')!.user; return (await syncAchievements(c.get('store'), u.id, u.tz)).fresh; };

  /** Сегодня: день программы (доступно ли занятие и почему нет) и занятие по нему — активное с текущим шагом или завершённое с итогом. */
  app.get('/lesson', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const r = await lessonToday(c.get('store'), user.id, user.tz);
    return c.json({ ok: true, ...lessonMeta, today: r.today, day: r.info.day, available: r.info.available, reason: r.info.reason, lesson: r.lesson });
  });

  /** Начать занятие дня или продолжить: возвращает текущий шаг. Если банк пуст по теме — модель пишет задание (до минуты). */
  app.post('/lesson/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    try { return c.json({ ok: true, ...lessonMeta, lesson: await startLesson(c.env, c.get('store'), user.id, user.tz, await domainOf(c)) }); }
    catch (e) { return lessonFail(c, e); }
  });

  /** Ответ на текущий шаг: {stepId, answer}. Разминка и карточки проверяются сравнением с эталоном, письмо — моделью
   *  по рубрике и образцу (при сбое модели — lesson_eval_failed 502, ответ не записан, можно отправить снова).
   *  В ответе last — разбор только что отвеченного шага, current — следующий. */
  app.post('/lesson/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try {
      const lesson = await answerLesson(c.env, c.get('store'), user.id, body.stepId, body.answer, user.tz, await domainOf(c));
      return c.json({ ok: true, ...lessonMeta, lesson, unlocked: await unlocked(c) });
    } catch (e) { return lessonFail(c, e); }
  });

  /** Бонусная задача после занятия: {accept: true} — выдать задачу ступенью выше (current — её шаг, ответ — через
   *  /lesson/answer), {accept: false} — отклонить. Без предложения — bonus_none 409 с причиной (declined | correct | wrong). */
  app.post('/lesson/bonus', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...lessonMeta, lesson: await bonusLesson(c.env, c.get('store'), user.id, user.tz, await domainOf(c), body?.accept !== false) }); }
    catch (e) { return lessonFail(c, e); }
  });

  // --- репетиция интервью ---

  const REHEARSAL_STATUS: Record<RehearsalError['code'], number> = { rehearsal_none: 404, rehearsal_stale: 409, rehearsal_finished: 409, answer_invalid: 400, rehearsal_eval_failed: 502 };
  const rehearsalFail = (c: any, e: unknown) => {
    if (e instanceof RehearsalError) return c.json({ ok: false, error: e.code, reason: e.reason, detail: e.message !== e.code ? e.message : undefined }, REHEARSAL_STATUS[e.code]);
    throw e;
  };
  const rehearsalMeta = { questions: QUESTION_COUNT, words: ANSWER_WORDS, replacements: REPLACEMENTS };

  /** Сегодня: репетиция ли по программе, сегодняшняя репетиция (идёт — с текущим вопросом, прошла — с разбором) и последняя прежняя. */
  app.get('/rehearsal', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...rehearsalMeta, ...(await rehearsalToday(c.get('store'), user.id, user.tz)) });
  });

  /** Начать репетицию (модель пишет сценарий по целевой позиции — до минуты; не написала — встроенный) или продолжить начатую. */
  app.post('/rehearsal/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    try { return c.json({ ok: true, ...rehearsalMeta, rehearsal: await startRehearsal(c.env, c.get('store'), user.id, user.tz, await profileOf(c)) }); }
    catch (e) { return rehearsalFail(c, e); }
  });

  /** Ответ на текущий вопрос: {turnId, answer}. После последнего — разбор всего разговора моделью (до минуты):
   *  пять осей, что сказано хорошо, три фразы заменить (уходят в журнал). Сбой разбора — reviewNote, повтор через /rehearsal/review. */
  app.post('/rehearsal/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try {
      const raw = body.speechId ? { text: body.answer, speechId: body.speechId } : body.answer;
      const rehearsal = await answerRehearsal(c.env, c.get('store'), user.id, body.turnId, raw, user.tz, await profileOf(c));
      return c.json({ ok: true, ...rehearsalMeta, rehearsal, unlocked: await unlocked(c) });
    } catch (e) { return rehearsalFail(c, e); }
  });

  // --- голос ---

  const VOICE_STATUS: Record<VoiceError['code'], number> = { audio_missing: 400, audio_unsupported: 415, audio_too_large: 413, audio_empty: 422, stt_failed: 502, tts_failed: 502, tts_text_invalid: 400 };
  const voiceFail = (c: any, e: unknown) => {
    if (e instanceof VoiceError) return c.json({ ok: false, error: e.code, detail: e.message !== e.code ? e.message : undefined }, VOICE_STATUS[e.code]);
    throw e;
  };
  const voiceMeta = { maxBytes: MAX_AUDIO_BYTES, maxSeconds: MAX_SECONDS, maxChars: MAX_TTS_CHARS, stt: STT_MODEL, tts: TTS_MODEL };

  /** Распознать запись речи: multipart с полем audio (WAV 16 кГц моно — клиент перекодирует сам; WebM/MP4/OGG/MP3 — как есть).
   *  Ответ — запись speech_takes: расшифровка и мерки (темп, паузы, заполнители, беглость); её id передаётся с ответом
   *  репетиции, чтобы беглость вошла в оси. Текст расшифровки ученик может поправить перед отправкой. */
  app.post('/voice/transcribe', requireAuth, async (c) => {
    const userId = c.get('auth')!.user.id;
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_AUDIO_BYTES + 4096) return c.json({ ok: false, error: 'audio_too_large' }, 413);
    const ct = c.req.header('content-type') ?? '';
    let bytes: Uint8Array | null = null; let mime = '';
    if (ct.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.audio ?? body.file;
      if (file instanceof File) { bytes = new Uint8Array(await file.arrayBuffer()); mime = file.type || ''; }
    } else if (ct.startsWith('audio/') || ct.startsWith('video/')) {
      bytes = new Uint8Array(await c.req.arrayBuffer()); mime = ct;
    }
    try {
      const p = await c.get('store').getProfile(userId);
      const hint = p?.keywords?.length ? p.keywords.slice(0, 12).join(', ') : undefined;
      const take = await recordSpeech(c.env, c.get('store'), userId, bytes ?? new Uint8Array(0), mime, { hint });
      return c.json({ ok: true, ...voiceMeta, speech: publicSpeech(take) });
    } catch (e) { return voiceFail(c, e); }
  });

  /** Озвучить реплику тренера: {text} до MAX_TTS_CHARS знаков → MP3 (MeloTTS). */
  app.post('/voice/speak', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const v = validateTtsText(body?.text);
    if (!v.ok) return c.json({ ok: false, error: 'tts_text_invalid', reason: v.reason }, 400);
    try {
      const s = await speak(c.env, v.text);
      return new Response(s.audio, { status: 200, headers: { 'content-type': s.mime, 'cache-control': 'private, max-age=3600', 'x-tts-model': s.model } });
    } catch (e) { return voiceFail(c, e); }
  });

  /** Справочник голоса: пределы записи и текста, модели. */
  app.get('/voice/meta', requireAuth, (c) => c.json({ ok: true, ...voiceMeta }));

  /** Разобрать последнюю завершённую репетицию заново: когда разбора нет (сбой модели) или {force: true}. */
  app.post('/rehearsal/review', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...rehearsalMeta, rehearsal: await rescoreRehearsal(c.env, c.get('store'), user.id, user.tz, await profileOf(c), body?.force === true) }); }
    catch (e) { return rehearsalFail(c, e); }
  });

  /** Бросить начатую репетицию: следующий start напишет новый сценарий. */
  app.post('/rehearsal/abandon', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, abandoned: await abandonRehearsal(c.get('store'), user.id, user.tz) });
  });

  // --- достижения ---

  /** Каталог достижений с прогрессом: условия пересчитываются по ответам, новые открываются при каждом запросе. */
  app.get('/achievements', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const r = await syncAchievements(c.get('store'), user.id, user.tz);
    return c.json({ ok: true, total: ACHIEVEMENTS.length, unlocked: r.all.filter(a => a.unlocked).length, fresh: r.fresh.length, achievements: r.all });
  });

  /** Отметить открытые достижения увиденными — «новое» больше не показывается. */
  app.post('/achievements/seen', requireAuth, async (c) => {
    await c.get('store').markAchievementsSeen(c.get('auth')!.user.id, new Date().toISOString());
    return c.json({ ok: true });
  });

  // --- главный экран ---

  const dashboardMeta = { gainPerLesson: GAIN_PER_LESSON, missPenalty: MISS_PENALTY, missCap: MISS_CAP, freezesPerWeek: FREEZES_PER_WEEK, goalMin: GOAL_MIN, goalMax: GOAL_MAX, goalDays: GOAL_DAYS_DEFAULT, bonusMultiplier: BONUS_MULTIPLIER };

  /** Готовность 0–100 с разбором и прогнозом, обратный отсчёт, серия с заморозкой, недельная цель и план недели. */
  app.get('/dashboard', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, ...dashboardMeta, ...(await dashboard(c.get('store'), user.id, user.tz, p)) });
  });

  /** Своя недельная цель: {minutes} — целое от GOAL_MIN до GOAL_MAX; null — вернуться к значению по умолчанию. */
  app.put('/dashboard/goal', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const v = parseGoal(body?.minutes);
    if (!v.ok) return c.json({ ok: false, error: 'goal_invalid', reason: v.reason }, 400);
    await c.get('store').saveWeeklyGoal(user.id, v.minutes, new Date().toISOString());
    const p = await c.get('store').getProfile(user.id);
    return c.json({ ok: true, ...dashboardMeta, ...(await dashboard(c.get('store'), user.id, user.tz, p)) });
  });

  // --- ежедневное письмо ---

  const digestMeta = { defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES, stepMinutes: CRON_STEP_MINUTES };
  /** Состояние письма: время, включено ли, что было сегодня, когда следующее, настроена ли почта — и предпросмотр (тема и текст). */
  const digestView = async (c: any, preview: boolean) => {
    const user = c.get('auth')!.user;
    const p = await c.get('store').getProfile(user.id);
    const now = new Date();
    const s = digestState({ notifyAt: p?.notifyAt ?? null, digestSentOn: p?.digestSentOn ?? null }, user.tz, now);
    const out: Record<string, unknown> = {
      ok: true, ...digestMeta, notifyAt: p?.notifyAt ?? null, enabled: s.state !== 'off', tz: user.tz, localTime: s.time, today: s.date, state: s.state,
      sentOn: p?.digestSentOn ?? null, next: nextDigest({ notifyAt: p?.notifyAt ?? null, digestSentOn: p?.digestSentOn ?? null }, user.tz, now),
      mail: c.env.RESEND_API_KEY ? 'ok' : 'missing',
    };
    if (preview) {
      const { mail, data } = await buildDigest(c.env, c.get('store'), user, p);
      out.preview = { subject: mail.subject, text: mail.text, headline: mail.headline, dueCards: data.dueCards };
    }
    return out;
  };

  app.get('/digest', requireAuth, async (c) => c.json(await digestView(c, c.req.query('preview') !== '0')));

  /** Время письма: {notifyAt: "HH:MM"} — включить или переставить; {notifyAt: null} — выключить.
   *  Если назначенное время сегодня уже прошло, первое письмо придёт завтра (день отмечается сразу). */
  app.put('/digest', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const v = parseNotifyAt(body?.notifyAt);
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    const now = new Date();
    const clock = localClock(user.tz, now);
    const sentOn = v.value && clock.minutes >= minutesOf(v.value) ? clock.date : null;
    await c.get('store').saveNotifyAt(user.id, v.value, sentOn, now.toISOString());
    return c.json(await digestView(c, false));
  });

  /** Прислать письмо сейчас, вне расписания. Почта не настроена — 503, Resend отказал — 502. */
  app.post('/digest/send', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const p = await c.get('store').getProfile(user.id);
    const r = await sendDigestNow(c.env, c.get('store'), user, p);
    if (!r.result.sent) {
      if (r.result.reason === 'provider_error') { console.error(r.result.detail); return c.json({ ok: false, error: 'mail_failed', detail: r.result.detail }, 502); }
      return c.json({ ok: false, error: 'mail_not_configured' }, 503);
    }
    return c.json({ ok: true, subject: r.subject, sentOn: r.sentOn, id: r.result.id ?? null });
  });

  // --- Web Push: одно напоминание в день ---

  const pushMeta = { defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES, stepMinutes: CRON_STEP_MINUTES };
  /** Состояние напоминания: открытый ключ VAPID для PushManager, время, состояние дня, следующий срок, устройства (без endpoint и ключей). */
  const pushView = async (c: any) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const now = new Date();
    const { keys, source } = await vapidKeys(c.env, store, now.toISOString());
    const setting = await store.getPushSetting(user.id);
    const p = { notifyAt: setting?.pushAt ?? null, digestSentOn: setting?.sentOn ?? null };
    const s = digestState(p, user.tz, now);
    const subs = await store.listPushSubscriptions(user.id);
    return {
      ok: true, ...pushMeta, publicKey: keys.publicKey, keySource: source, pushAt: setting?.pushAt ?? null, enabled: s.state !== 'off', tz: user.tz, localTime: s.time, today: s.date,
      state: s.state, sentOn: setting?.sentOn ?? null, note: setting?.note ?? null, next: nextDigest(p, user.tz, now), subscriptions: subs.map(publicSubscription),
    };
  };
  const pushFail = (c: any, e: unknown) => {
    if (e instanceof PushError && e.code === 'vapid_invalid') { console.error(e.message); return c.json({ ok: false, error: 'vapid_invalid', detail: e.message }, 503); }
    throw e;
  };

  app.get('/push', requireAuth, async (c) => { try { return c.json(await pushView(c)); } catch (e) { return pushFail(c, e); } });

  /** Время напоминания: {pushAt: "HH:MM"} — включить или переставить; {pushAt: null} — выключить (подписки устройств остаются). */
  app.put('/push', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const v = parseNotifyAt(body?.pushAt);
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    const now = new Date();
    await c.get('store').savePushAt(user.id, v.value, sentOnIfPassed(v.value, user.tz, now), now.toISOString());
    try { return c.json(await pushView(c)); } catch (e) { return pushFail(c, e); }
  });

  /** Подписка браузера: {endpoint, keys:{p256dh, auth}, userAgent?, pushAt?}. Если напоминание ещё не включено — включается
   *  на pushAt, иначе на время письма, иначе на время по умолчанию. */
  app.post('/push/subscribe', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await c.req.json().catch(() => ({}));
    const v = parseSubscribeBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'push_invalid', reason: v.reason }, 400);
    const at = body?.pushAt === undefined ? { ok: true as const, value: null } : parseNotifyAt(body.pushAt);
    if (!at.ok) return c.json({ ok: false, error: 'notify_invalid', reason: at.reason }, 400);
    const now = new Date();
    const existing = (await store.listPushSubscriptions(user.id)).find((s: { endpoint: string }) => s.endpoint === v.value.endpoint);
    await store.upsertPushSubscription({ id: existing?.id ?? crypto.randomUUID(), userId: user.id, ...v.value, createdAt: existing?.createdAt ?? now.toISOString(), lastSentAt: existing?.lastSentAt ?? null, lastError: null });
    const setting = await store.getPushSetting(user.id);
    if (!setting?.pushAt || at.value) {
      const pushAt = at.value ?? (await store.getProfile(user.id))?.notifyAt ?? DEFAULT_NOTIFY_AT;
      await store.savePushAt(user.id, pushAt, sentOnIfPassed(pushAt, user.tz, now), now.toISOString());
    }
    try { return c.json(await pushView(c)); } catch (e) { return pushFail(c, e); }
  });

  /** Отписать это устройство: {endpoint}. Последнее устройство выключает и напоминание — слать больше некуда. */
  app.delete('/push/subscribe', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await c.req.json().catch(() => ({}));
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) return c.json({ ok: false, error: 'push_invalid', reason: 'endpoint' }, 400);
    const removed = await store.deletePushSubscription(endpoint, user.id);
    const now = new Date();
    if ((await store.listPushSubscriptions(user.id)).length === 0 && (await store.getPushSetting(user.id))?.pushAt) await store.savePushAt(user.id, null, null, now.toISOString());
    try { return c.json({ ...(await pushView(c)), removed }); } catch (e) { return pushFail(c, e); }
  });

  /** Прислать напоминание сейчас на все устройства; день не отмечается. Устройств нет — 404, ни одно не приняло — 502. */
  app.post('/push/send', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    if ((await store.listPushSubscriptions(user.id)).length === 0) return c.json({ ok: false, error: 'push_no_subscriptions' }, 404);
    try {
      const r = await sendPushNow(c.env, store, user, await store.getProfile(user.id));
      if (r.delivered === 0) { console.error(JSON.stringify(r.devices)); return c.json({ ok: false, error: 'push_failed', devices: r.devices, reminder: r.reminder }, 502); }
      return c.json({ ok: true, delivered: r.delivered, devices: r.devices, reminder: r.reminder });
    } catch (e) { return pushFail(c, e); }
  });

  // --- настройки (4.6): свой ключ провайдера, время уведомлений, экспорт данных ---

  const SETTINGS_STATUS: Record<SettingsError['code'], number> = { key_invalid: 400, key_unreadable: 409, key_none: 404, key_check_failed: 502 };
  const settingsFail = (c: any, e: unknown) => {
    if (e instanceof SettingsError) return c.json({ ok: false, error: e.code, reason: e.reason, detail: e.message !== e.code ? e.message : undefined }, SETTINGS_STATUS[e.code]);
    throw e;
  };
  /** Сводка настроек: ключ (без самого ключа), откуда мастер-ключ, оба канала уведомлений с общим поясом, счётчики для экспорта. */
  const settingsView = async (c: any) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const now = new Date();
    const row = await store.getProviderKey(user.id);
    const { key: mk, source } = await masterKey(c.env, store, now.toISOString());
    const readable = row ? (await decryptSecret(mk, row.keyEnc, user.id)) != null : false;
    const p = await store.getProfile(user.id);
    const push = await store.getPushSetting(user.id);
    const subs = await store.listPushSubscriptions(user.id);
    const clock = localClock(user.tz, now);
    return {
      ok: true,
      provider: { key: publicKey(row, readable), keySource: source, providers: providerOptions(), builtin: PROVIDERS[0].name },
      notifications: {
        tz: user.tz, localTime: clock.time, defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES,
        mail: { at: p?.notifyAt ?? null, enabled: Boolean(p?.notifyAt), configured: Boolean(c.env.RESEND_API_KEY) },
        push: { at: push?.pushAt ?? null, enabled: Boolean(push?.pushAt), devices: subs.length },
      },
      data: { counts: await exportCounts(store, user.id), file: exportFileName(clock.date) },
    };
  };

  app.get('/settings', requireAuth, async (c) => { try { return c.json(await settingsView(c)); } catch (e) { return settingsFail(c, e); } });

  /** Сохранить свой ключ: {provider, apiKey, model?}. Ключ шифруется, в ответе — только провайдер, модель и последние четыре знака. */
  app.put('/settings/key', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await c.req.json().catch(() => ({}));
    const v = parseKeyBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'key_invalid', reason: v.reason }, 400);
    try {
      await saveKey(c.env, c.get('store'), user.id, v.value, new Date().toISOString());
      return c.json(await settingsView(c));
    } catch (e) { return settingsFail(c, e); }
  });

  /** Проверить сохранённый ключ коротким вызовом модели (без отката на встроенную): {ok, reply | detail}. */
  app.post('/settings/key/check', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    try {
      const r = await checkKey(c.env, c.get('store'), user.id, new Date().toISOString());
      const view = await settingsView(c);
      if (!r.ok) return c.json({ ...view, ok: false, error: 'key_check_failed', detail: r.detail }, 502);
      return c.json({ ...view, reply: r.reply });
    } catch (e) { return settingsFail(c, e); }
  });

  /** Убрать свой ключ — дальше работает встроенная модель. */
  app.delete('/settings/key', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const removed = await c.get('store').deleteProviderKey(user.id);
    try { return c.json({ ...(await settingsView(c)), removed }); } catch (e) { return settingsFail(c, e); }
  });

  /** Общее время уведомлений: {at: "HH:MM", mail: bool, push: bool}. Канал без галочки выключается; push без подписанных
   *  устройств включить нельзя — push_no_subscriptions 404. Прошедшее сегодня время — первое уведомление завтра. */
  app.put('/settings/notifications', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await c.req.json().catch(() => ({}));
    const mail = body?.mail === true, push = body?.push === true;
    const v = mail || push ? parseNotifyAt(body?.at) : { ok: true as const, value: null };
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    if (push && (await store.listPushSubscriptions(user.id)).length === 0) return c.json({ ok: false, error: 'push_no_subscriptions' }, 404);
    const now = new Date();
    const at = v.value;
    const mailAt = mail ? at : null, pushAt = push ? at : null;
    await store.saveNotifyAt(user.id, mailAt, sentOnIfPassed(mailAt, user.tz, now), now.toISOString());
    await store.savePushAt(user.id, pushAt, sentOnIfPassed(pushAt, user.tz, now), now.toISOString());
    try { return c.json(await settingsView(c)); } catch (e) { return settingsFail(c, e); }
  });

  /** Все данные пользователя одним JSON-файлом (без ключа провайдера и адресов push-подписок). */
  app.get('/export', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const now = new Date();
    const data = await exportData(c.get('store'), user, version, now.toISOString());
    const name = exportFileName(localClock(user.tz, now).date);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    });
  });

  return app;
}
