/** Программа на четыре недели (3.1), дневное занятие (3.2, 3.5) и достижения (3.5). Ошибки ProgramError и LessonError уходят в app.onError. */
import { generateProgram, swapDays, current as currentProgram, PROGRAM_TOPICS, PROGRAM_DAYS } from '../program';
import { today as lessonToday, startOrResume as startLesson, answer as answerLesson, bonus as bonusLesson, WARMUP_COUNT, REVIEW_MAX, BONUS_MULTIPLIER, BONUS_CHANCE } from '../lesson';
import { syncAchievements, ACHIEVEMENTS } from '../achievements';
import { area, bodyOf, domainOf, profileOf, requireAuth, unlocked } from './context';

export function programRoutes() {
  const r = area();
  const programTopics = PROGRAM_TOPICS.map(({ id, label }) => ({ id, label }));

  /** Текущая программа: дни последней сборки с темой, форматом письма и причиной выбора; null — ещё не построена. */
  r.get('/program', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await currentProgram(c.get('store'), user.id, user.tz, await profileOf(c)) });
  });

  /** Построить или пересобрать программу с сегодняшнего дня по журналу ошибок, последнему тесту и дате собеседования.
   *  Пройденные дни остаются, незавершённые заменяются. */
  r.post('/program/generate', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await generateProgram(c.get('store'), user.id, user.tz, await profileOf(c)) });
  });

  /** Переставить темы двух дней занятий: {a, b} — id дней. Ошибка program_invalid с причиной not_found | same | not_lesson | not_planned | past. */
  r.post('/program/swap', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    return c.json({ ok: true, days: PROGRAM_DAYS, topics: programTopics, program: await swapDays(c.get('store'), user.id, user.tz, await profileOf(c), body.a, body.b) });
  });

  // --- дневное занятие ---

  const lessonMeta = { warmup: WARMUP_COUNT, reviewMax: REVIEW_MAX, bonusMultiplier: BONUS_MULTIPLIER, bonusChance: BONUS_CHANCE };

  /** Сегодня: день программы (доступно ли занятие и почему нет) и занятие по нему — активное с текущим шагом или завершённое с итогом. */
  r.get('/lesson', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const t = await lessonToday(c.get('store'), user.id, user.tz);
    return c.json({ ok: true, ...lessonMeta, today: t.today, day: t.info.day, available: t.info.available, reason: t.info.reason, lesson: t.lesson });
  });

  /** Начать занятие дня или продолжить: возвращает текущий шаг. Если банк пуст по теме — модель пишет задание (до минуты). */
  r.post('/lesson/start', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...lessonMeta, lesson: await startLesson(c.env, c.get('store'), user.id, user.tz, await domainOf(c)) });
  });

  /** Ответ на текущий шаг: {stepId, answer}. Разминка и карточки проверяются сравнением с эталоном, письмо — моделью
   *  по рубрике и образцу (при сбое модели — lesson_eval_failed 502, ответ не записан, можно отправить снова).
   *  В ответе last — разбор только что отвеченного шага, current — следующий. */
  r.post('/lesson/answer', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const lesson = await answerLesson(c.env, c.get('store'), user.id, body.stepId, body.answer, user.tz, await domainOf(c));
    return c.json({ ok: true, ...lessonMeta, lesson, unlocked: await unlocked(c) });
  });

  /** Бонусная задача после занятия: {accept: true} — выдать задачу ступенью выше (current — её шаг, ответ — через
   *  /lesson/answer), {accept: false} — отклонить. Без предложения — bonus_none 409 с причиной (declined | correct | wrong). */
  r.post('/lesson/bonus', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    return c.json({ ok: true, ...lessonMeta, lesson: await bonusLesson(c.env, c.get('store'), user.id, user.tz, await domainOf(c), body?.accept !== false) });
  });

  // --- достижения ---

  /** Каталог достижений с прогрессом: условия пересчитываются по ответам, новые открываются при каждом запросе.
   *  fresh — сколько открытых ещё не отмечено увиденным, включая открытые раньше ответом в занятии или тесте:
   *  по нему клиент гасит отметку «новое». */
  r.get('/achievements', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const a = await syncAchievements(c.get('store'), user.id, user.tz);
    return c.json({ ok: true, total: ACHIEVEMENTS.length, unlocked: a.all.filter(x => x.unlocked).length, fresh: a.all.filter(x => x.new).length, achievements: a.all });
  });

  /** Отметить открытые достижения увиденными — «новое» больше не показывается. */
  r.post('/achievements/seen', requireAuth, async (c) => {
    await c.get('store').markAchievementsSeen(c.get('auth')!.user.id, new Date().toISOString());
    return c.json({ ok: true });
  });

  return r;
}
