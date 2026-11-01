/** Тест уровня (2.5–2.6) и контрольный срез (4.3). Ошибки AssessmentError уходят в app.onError. */
import { startOrResume, answer as answerAssessment, abandon, current as currentAssessment, rescore, TOTAL, ADAPTIVE_COUNT, CHECKPOINT_TOTAL, CHECKPOINT_ADAPTIVE, SIGNIFICANT_DELTA } from '../assessment';
import { today as checkpointToday, startOrResume as startCheckpoint, answer as answerCheckpoint, rescore as rescoreCheckpoint, abandon as abandonCheckpoint } from '../checkpoint';
import { area, bodyOf, domainOf, profileOf, requireAuth } from './context';

export function assessmentRoutes() {
  const r = area();

  /** Состояние теста: активный с текущим заданием (без ключа) или последний завершённый с уровнем; null — теста не было. */
  r.get('/assessment', requireAuth, async (c) => c.json({ ok: true, total: TOTAL, adaptive: ADAPTIVE_COUNT, assessment: await currentAssessment(c.get('store'), c.get('auth')!.user.id) }));

  /** Начать или продолжить: возвращает текущее задание. Если банк пуст — модель пишет задание (до минуты). */
  r.post('/assessment/start', requireAuth, async (c) =>
    c.json({ ok: true, assessment: await startOrResume(c.env, c.get('store'), c.get('auth')!.user.id, await domainOf(c)) }));

  /** Ответ на текущее задание: {attemptId, answer}. Ответ проверяется сравнением с эталоном; после последнего (письма)
   *  модель оценивает письмо по рубрике и образцу, считаются пять осей и уровень — ответ приходит с result. */
  r.post('/assessment/answer', requireAuth, async (c) => {
    const body = await bodyOf(c);
    const user = c.get('auth')!.user;
    return c.json({ ok: true, assessment: await answerAssessment(c.env, c.get('store'), user.id, body.attemptId, body.answer, await domainOf(c), { tz: user.tz }) });
  });

  /** Пересчитать оценку последнего завершённого теста: письмо оценивается заново, если прошлый раз модель не ответила
   *  (или {force: true}); оси и уровень считаются заново. Для тестов, пройденных до появления оценки. */
  r.post('/assessment/score', requireAuth, async (c) => {
    const body = await bodyOf(c);
    const user = c.get('auth')!.user;
    return c.json({ ok: true, assessment: await rescore(c.env, c.get('store'), user.id, { tz: user.tz }, body?.force === true) });
  });

  /** Бросить начатый тест: следующий start начнёт новый, виденные задания не повторятся. */
  r.post('/assessment/abandon', requireAuth, async (c) => c.json({ ok: true, abandoned: await abandon(c.get('store'), c.get('auth')!.user.id) }));

  // --- контрольный срез ---

  const checkpointMeta = { total: CHECKPOINT_TOTAL, adaptive: CHECKPOINT_ADAPTIVE, significant: SIGNIFICANT_DELTA };

  /** Сегодня: срез ли по программе, следующий запланированный, активный или последний пройденный срез (со сравнением). */
  r.get('/checkpoint', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...checkpointMeta, ...(await checkpointToday(c.get('store'), user.id, user.tz)) });
  });

  /** Начать срез (восемь заданий со старта с текущего уровня, чтение, письмо) или продолжить начатый. Идёт тест уровня — assessment_busy 409. */
  r.post('/checkpoint/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...checkpointMeta, checkpoint: await startCheckpoint(c.env, c.get('store'), user.id, user.tz, await profileOf(c)) });
  });

  /** Ответ на текущее задание среза: {attemptId, answer}. После последнего — оценка, сравнение с прошлым тестом,
   *  день программы отмечается пройденным, оставшиеся дни программы пересобираются по новому профилю ошибок. */
  r.post('/checkpoint/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    return c.json({ ok: true, ...checkpointMeta, checkpoint: await answerCheckpoint(c.env, c.get('store'), user.id, body.attemptId, body.answer, user.tz, await profileOf(c)) });
  });

  /** Пересчитать последний завершённый срез (письмо не оценено или {force: true}). */
  r.post('/checkpoint/score', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    return c.json({ ok: true, ...checkpointMeta, checkpoint: await rescoreCheckpoint(c.env, c.get('store'), user.id, user.tz, await profileOf(c), body?.force === true) });
  });

  /** Бросить начатый срез: следующий start начнёт новый. */
  r.post('/checkpoint/abandon', requireAuth, async (c) => c.json({ ok: true, abandoned: await abandonCheckpoint(c.get('store'), c.get('auth')!.user.id) }));

  return r;
}
