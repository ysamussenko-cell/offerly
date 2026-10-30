import { describe, it, expect } from 'vitest';
import {
  warmupKind, warmupLevel, partAt, totalSteps, warmupTopics, reviewCards, gradeCard, lessonScore, pickWarmup, pickWriting,
  today as lessonToday, startOrResume, answer, d1LessonStore, LessonError, WARMUP_COUNT, REVIEW_MAX, REVIEW_INTERVAL, type Lesson, type LessonStep,
} from '../functions/_lib/lesson';
import { generateProgram, d1ProgramStore, type ProgramDay } from '../functions/_lib/program';
import { d1CardStore, type ErrorCard } from '../functions/_lib/cards';
import type { Assessment } from '../functions/_lib/assessment';
import type { Item, Kind, Level } from '../functions/_lib/items';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { freshDb, d1Of } from './helpers/sqliteD1';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
const USER = 'u1';
const TZ = 'Asia/Almaty';
const NOW = '2026-11-02T03:00:00.000Z'; // понедельник 2 ноября 2026 в Алматы
const TODAY = '2026-11-02';
const DOMAIN = { specialty: null, industry: null, targetRole: null, keywords: [] };
const rng = () => 0;
let seq = 0;
const nextId = () => `id${++seq}`;
const SHORT = Array.from({ length: 8 }, () => 'The boiler efficiency test shows a small loss.').join(' '); // 64 слова

const card = (topic: string, over: Partial<ErrorCard> = {}): ErrorCard => ({
  id: `c${++seq}`, userId: USER, topic, rule: 'правило карточки', example: `We have installed ${seq} boilers since 2020 at the plant.`, correction: `We installed ${seq} boilers in 2020 at the plant.`, source: 'seed',
  stability: 1, difficulty: 5, due: '2026-11-01', reps: 0, lapses: 0, retired: false, createdAt: NOW, ...over,
});
const assessment = (level: Level = 'B1'): Assessment => ({
  id: 'a1', userId: USER, kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level, currentLevel: level,
  updatedAt: NOW, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: NOW, scoringNote: null,
});
function makeItem(kind: Kind, level: Level, topic: string, over: Partial<Item> = {}): Item {
  const n = ++seq;
  const base = { id: `it${n}`, kind, level, topic, domain: null, rubric: null, explanation: 'правило одной строкой', status: 'verified' as const, checkNote: null, checkedLevel: null, fingerprint: `fp${n}`, source: 'test', writingFormat: null, createdAt: `2026-10-30T00:00:${String(n % 60).padStart(2, '0')}Z`, verifiedAt: null };
  if (kind === 'mcq') return { ...base, prompt: `We finished ___ energy audit number ${n} last week.`, options: ['a', 'an', 'the', '—'], answer: 'C', ...over };
  if (kind === 'correction') return { ...base, prompt: `The turbine have been inspected ${n} times since the overhaul.`, options: null, answer: `The turbine has been inspected ${n} times since the overhaul.`, ...over };
  return { ...base, prompt: `Write a short review of calculation ${n} for its author in 60–80 words.`, options: null, rubric: ['Отвечает прямо', 'Объясняет метод', 'Нейтральный тон'], answer: SHORT, writingFormat: 'review', ...over };
}
/** Банк под день «союзы и инверсия»: по четыре mcq и исправления на B1 и B2 (растяжка), письмо-отзыв на B1. */
function fillBank(items: Item[], topic = 'conjunctions') {
  for (const l of ['B1', 'B2'] as Level[]) for (let i = 0; i < 4; i++) { items.push(makeItem('mcq', l, topic)); items.push(makeItem('correction', l, topic)); }
  items.push(makeItem('writing', 'B1', topic));
  items.push(makeItem('writing', 'B1', topic, { writingFormat: 'explain' }));
}
const EVAL = { grammar: 60, vocabulary: 55, coherence: 58, task_response: 62, level: 'B2', summary: 'Коротко и по делу; следите за согласованием времён.', errors: [{ original: 'shows a small loss', corrected: 'showed a small loss', note: 'Прошедшее время для завершённого теста' }], rewrite: SHORT.replace(/shows/g, 'showed') };
const evalChat = async () => JSON.stringify(EVAL);
const day = (over: Partial<ProgramDay>): ProgramDay => ({
  id: `d${++seq}`, userId: USER, dayDate: TODAY, position: 1, week: 1, format: 'lesson', topic: 'conjunctions', writing: 'review', reason: 'r', status: 'planned', minutes: 25, score: null, completedAt: null, generatedAt: NOW, updatedAt: null, ...over,
});

describe('план занятия', () => {
  it('разминка: исправление на позициях 3 и 5, растяжка на 4 и 5; части по позициям; длина', () => {
    expect([1, 2, 3, 4, 5].map(warmupKind)).toEqual(['mcq', 'mcq', 'correction', 'mcq', 'correction']);
    expect([1, 2, 3, 4, 5].map(p => warmupLevel(p, 'B1'))).toEqual(['B1', 'B1', 'B1', 'B2', 'B2']);
    expect(warmupLevel(5, 'C1')).toBe('C1');
    const l = { warmupCount: WARMUP_COUNT, reviewCount: 3 };
    expect([1, 5, 6, 7, 9].map(p => partAt(p, l))).toEqual(['warmup', 'warmup', 'writing', 'review', 'review']);
    expect(totalSteps(l)).toBe(9);
    expect(totalSteps({ warmupCount: 5, reviewCount: 0 })).toBe(6);
  });
  it('темы разминки: тема дня; для смешанного повторения — темы занятий недели до этого дня и темы карточек, без повторов', () => {
    expect(warmupTopics(day({}), [], [])).toEqual(['conjunctions']);
    const sat = day({ topic: 'mixed', dayDate: '2026-11-07' });
    const week = [day({ topic: 'conjunctions', dayDate: '2026-11-02' }), day({ topic: 'register', dayDate: '2026-11-03' }), day({ topic: 'conjunctions', dayDate: '2026-11-04' }), day({ format: 'rehearsal', topic: 'task-response', dayDate: '2026-11-08' })];
    expect(warmupTopics(sat, week, [card('quantifiers'), card('task-response'), card('register', { retired: true })])).toEqual(['conjunctions', 'register', 'quantifiers']);
    expect(warmupTopics(sat, [], [])).toEqual(['spelling']);
  });
  it('карточки к повтору: срок наступил или не назначен, не погашенные, с примером и исправлением; раньше — с более ранним сроком; не больше лимита', () => {
    const cards = [card('a', { due: '2026-11-05' }), card('b', { due: null }), card('c', { due: '2026-10-20' }), card('d', { retired: true }), card('e', { example: null }), card('f', { due: TODAY })];
    const r = reviewCards(cards, TODAY);
    expect(r.map(c => c.topic)).toEqual(['b', 'c', 'f']);
    expect(reviewCards(Array.from({ length: 8 }, () => card('x')), TODAY)).toHaveLength(REVIEW_MAX);
  });
  it('проверка карточки: совпало с «как надо» без учёта регистра и знаков — верно; как написано или иначе — неверно; пусто — отказ', () => {
    const c = card('tenses');
    expect(gradeCard(c, c.correction!.toUpperCase() + '!')).toMatchObject({ ok: true, correct: 1 });
    expect(gradeCard(c, c.example)).toMatchObject({ ok: true, correct: 0 });
    expect(gradeCard(c, 'Something else entirely.')).toMatchObject({ ok: true, correct: 0 });
    expect(gradeCard(c, '  ')).toEqual({ ok: false, reason: 'empty' });
    expect(gradeCard(c, 'ab')).toEqual({ ok: false, reason: 'format' });
  });
  it('итог занятия — среднее баллов отвеченных шагов', () => {
    const s = (score: number | null, answered = true) => ({ score, answeredAt: answered ? NOW : null } as LessonStep);
    expect(lessonScore([s(100), s(0), s(58), s(100, false)])).toBe(53);
    expect(lessonScore([])).toBeNull();
  });
  it('выбор из банка: тема и уровень, затем соседние уровни; виденные не берутся; письмо — только формата дня', async () => {
    const mem = memoryStore(); fillBank(mem.items);
    const used = new Set<string>();
    const a = await pickWarmup(mem.store, 'mcq', 'B1', ['conjunctions'], used, rng);
    expect(a).toMatchObject({ kind: 'mcq', level: 'B1', topic: 'conjunctions' });
    used.add(a!.id);
    expect((await pickWarmup(mem.store, 'mcq', 'B1', ['conjunctions'], used, rng))!.id).not.toBe(a!.id);
    expect(await pickWarmup(mem.store, 'mcq', 'B1', ['passive'], used, rng)).toBeNull();
    expect((await pickWarmup(mem.store, 'mcq', 'C1', ['conjunctions'], used, rng))!.level).toBe('B2');
    expect((await pickWriting(mem.store, 'B2', 'review', used, rng))!.writingFormat).toBe('review');
    expect((await pickWriting(mem.store, 'B1', 'explain', used, rng))!.writingFormat).toBe('explain');
    expect(await pickWriting(mem.store, 'B1', 'review', new Set(mem.items.map(i => i.id)), rng)).toBeNull();
  });
});

describe('занятие в хранилище', () => {
  const now = () => NOW;
  async function setup(cards = 3) {
    const mem = memoryStore(); fillBank(mem.items);
    mem.assessments.push(assessment());
    for (let i = 0; i < cards; i++) mem.cards.push(card('conjunctions'));
    mem.cards.push(card('tenses', { retired: true }));
    await generateProgram(mem.store, USER, TZ, null, { now, id: nextId });
    return mem;
  }
  const opts = { now, id: nextId, rng, generate: false, chatFn: evalChat as any };

  it('без программы — lesson_no_day; репетиция — lesson_unavailable', async () => {
    const mem = memoryStore();
    const t = await lessonToday(mem.store, USER, TZ, { now });
    expect(t).toMatchObject({ today: TODAY, info: { day: null, available: false, reason: 'no_program' }, lesson: null });
    await expect(startOrResume(ENV, mem.store, USER, TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'lesson_no_day', reason: 'no_program' });
    const mem2 = await setup();
    const sunday = () => '2026-11-08T03:00:00.000Z';
    const t2 = await lessonToday(mem2.store, USER, TZ, { now: sunday });
    expect(t2.info).toMatchObject({ available: false, reason: 'rehearsal' }); expect(t2.info.day?.format).toBe('rehearsal');
    await expect(startOrResume(ENV, mem2.store, USER, TZ, DOMAIN, { ...opts, now: sunday })).rejects.toMatchObject({ code: 'lesson_unavailable', reason: 'rehearsal' });
  });

  it('полный ход: пять заданий разминки → письмо → три карточки; продолжение, разбор каждого шага, итог и день программы', async () => {
    const mem = await setup(3);
    const v1 = await startOrResume(ENV, mem.store, USER, TZ, DOMAIN, opts);
    expect(v1).toMatchObject({ status: 'active', date: TODAY, topic: 'conjunctions', topicLabel: 'Союзы и инверсия', writing: 'review', writingLabel: 'отзыв рецензента', level: 'B1', minutes: 20, total: 9, answered: 0 });
    expect(v1.day).toMatchObject({ today: true, format: 'lesson', status: 'planned' });
    expect(v1.current).toMatchObject({ position: 1, part: 'warmup', kind: 'mcq', level: 'B1', topicLabel: 'Союзы и инверсия' });
    expect(v1.current!.options).toHaveLength(4);
    expect(JSON.stringify(v1.current)).not.toContain('"answer"');
    // повторный старт возвращает тот же шаг
    const again = await startOrResume(ENV, mem.store, USER, TZ, DOMAIN, opts);
    expect(again.current!.stepId).toBe(v1.current!.stepId);
    expect(mem.lessons).toHaveLength(1);
    // чужой шаг и пустой ответ
    await expect(answer(ENV, mem.store, USER, 'nope', 'A', TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'lesson_stale' });
    await expect(answer(ENV, mem.store, USER, v1.current!.stepId, '', TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'answer_invalid', reason: 'empty' });
    // 1: верно, разбор в last — как написано и как надо
    let v = await answer(ENV, mem.store, USER, v1.current!.stepId, 'C', TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ position: 1, part: 'warmup', kind: 'mcq', correct: 1, score: 100, feedback: 'правило одной строкой' });
    expect(v.last!.written).toContain('the energy audit'); expect(v.last!.correction).toContain('the energy audit');
    expect(v.current).toMatchObject({ position: 2, kind: 'mcq' });
    // 2: неверно
    v = await answer(ENV, mem.store, USER, v.current!.stepId, 'A', TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ correct: 0, score: 0 }); expect(v.last!.written).toContain('a energy audit');
    // 3: исправление верно (регистр и знаки не важны)
    expect(v.current).toMatchObject({ position: 3, kind: 'correction', level: 'B1' });
    const it3 = mem.items.find(i => i.id === mem.steps[2].itemId)!;
    v = await answer(ENV, mem.store, USER, v.current!.stepId, it3.answer.toUpperCase(), TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ correct: 1, correction: it3.answer });
    // 4 и 5 — растяжка ступенью выше
    expect(v.current).toMatchObject({ position: 4, kind: 'mcq', level: 'B2' });
    v = await answer(ENV, mem.store, USER, v.current!.stepId, 'C', TZ, DOMAIN, opts);
    expect(v.current).toMatchObject({ position: 5, kind: 'correction', level: 'B2' });
    v = await answer(ENV, mem.store, USER, v.current!.stepId, v.current!.prompt, TZ, DOMAIN, opts); // неизменённое предложение — неверно
    expect(v.last).toMatchObject({ correct: 0 });
    expect(v.parts.warmup).toEqual({ total: 5, done: 5, correct: 3 });
    // 6: письмо — формат дня, оценка моделью; сбой модели не записывает ответ
    expect(v.current).toMatchObject({ position: 6, part: 'writing', kind: 'writing', words: { min: 60, max: 80 } });
    expect(mem.items.find(i => i.id === mem.steps[5].itemId)!.writingFormat).toBe('review');
    await expect(answer(ENV, mem.store, USER, v.current!.stepId, SHORT, TZ, DOMAIN, { ...opts, chatFn: (async () => 'no') as any })).rejects.toMatchObject({ code: 'lesson_eval_failed' });
    expect(mem.steps[5].answeredAt).toBeNull();
    await expect(answer(ENV, mem.store, USER, v.current!.stepId, 'too short', TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'answer_invalid', reason: 'too_short' });
    v = await answer(ENV, mem.store, USER, v.current!.stepId, SHORT, TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ part: 'writing', correct: null, score: 59, feedback: EVAL.summary, correction: EVAL.rewrite });
    expect(v.last!.writing).toMatchObject({ level: 'B2', errors: [{ original: 'shows a small loss' }], axes: { grammar: 60 } });
    expect(v.parts.writing).toEqual({ done: true, score: 59 });
    // 7–9: карточки — пример на экране, правило после ответа; счётчики и срок карточки меняются
    expect(v.current).toMatchObject({ position: 7, part: 'review', kind: 'card', kindLabel: 'карточка журнала', topicLabel: 'Союзы и инверсия' });
    const c7 = mem.cards.find(c => c.id === mem.steps[6].cardId)!;
    expect(v.current!.prompt).toBe(c7.example);
    v = await answer(ENV, mem.store, USER, v.current!.stepId, c7.correction, TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ part: 'review', correct: 1, score: 100, feedback: 'правило карточки', written: c7.correction, correction: c7.correction });
    expect(c7).toMatchObject({ reps: 1, lapses: 0, due: '2026-11-05' });
    expect(REVIEW_INTERVAL).toEqual({ correct: 3, wrong: 1 });
    const c8 = mem.cards.find(c => c.id === mem.steps[7].cardId)!;
    expect(c8.id).not.toBe(c7.id);
    v = await answer(ENV, mem.store, USER, v.current!.stepId, 'wrong answer here', TZ, DOMAIN, opts);
    expect(v.last).toMatchObject({ correct: 0 }); expect(c8).toMatchObject({ reps: 0, lapses: 1, due: '2026-11-03' });
    expect(v.current).toMatchObject({ position: 9, part: 'review' });
    const c9 = mem.cards.find(c => c.id === mem.steps[8].cardId)!;
    v = await answer(ENV, mem.store, USER, v.current!.stepId, c9.correction, TZ, DOMAIN, opts);
    // завершено: итог, день программы пройден с баллом
    expect(v.status).toBe('finished'); expect(v.current).toBeNull(); expect(v.answered).toBe(9);
    expect(v.parts.review).toEqual({ total: 3, done: 3, correct: 2 });
    expect(v.score).toBe(Math.round((100 + 0 + 100 + 100 + 0 + 59 + 100 + 0 + 100) / 9));
    expect(v.steps).toHaveLength(9); expect(v.finishedAt).toBe(NOW);
    expect(v.day).toMatchObject({ status: 'done', score: v.score, completedAt: NOW });
    expect(mem.programDays.find(d => d.dayDate === TODAY)).toMatchObject({ status: 'done', score: v.score });
    // после завершения — то же занятие по GET и по start; ответов больше не принимает
    const t = await lessonToday(mem.store, USER, TZ, { now });
    expect(t.lesson).toMatchObject({ id: v.id, status: 'finished', score: v.score });
    expect((await startOrResume(ENV, mem.store, USER, TZ, DOMAIN, opts)).status).toBe('finished');
    await expect(answer(ENV, mem.store, USER, 'x', 'A', TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'lesson_none' });
    // задания занятия больше не выдаются
    const used = await mem.store.usedLessonItemIds(USER);
    expect(used.size).toBe(6);
  });

  it('без карточек занятие короче на повтор; банк пуст по теме — bank_empty, с генерацией модель пишет задание', async () => {
    const mem = await setup(0);
    const v = await startOrResume(ENV, mem.store, USER, TZ, DOMAIN, opts);
    expect(v.total).toBe(6); expect(v.parts.review.total).toBe(0);
    // день с темой, которой в банке нет
    const mem2 = await setup(0);
    for (const d of mem2.programDays) if (d.dayDate === TODAY) d.topic = 'passive';
    await expect(startOrResume(ENV, mem2.store, USER, TZ, DOMAIN, opts)).rejects.toMatchObject({ code: 'bank_empty' });
    expect(mem2.lessons).toHaveLength(1); // занятие создано, шаг не выдан — следующий старт попробует снова
    const chatFn = async (_env: unknown, msgs: { content: string }[]) => {
      const user = msgs[msgs.length - 1].content;
      if (user.startsWith('Write ')) return JSON.stringify({ items: [{ prompt: 'The report ___ by the auditor yesterday.', options: ['wrote', 'was written', 'is writing', 'has written'], answer: 'B', explanation: 'Пассив прошедшего времени.' }] });
      return JSON.stringify({ answer: 'B', level: 'B1', issues: [] });
    };
    const v2 = await startOrResume(ENV, mem2.store, USER, TZ, DOMAIN, { ...opts, generate: true, chatFn: chatFn as any });
    expect(v2.current).toMatchObject({ position: 1, kind: 'mcq', topicLabel: 'Пассив' });
    expect(mem2.items.filter(i => i.topic === 'passive' && i.status === 'verified')).toHaveLength(1);
  });

  it('смешанное повторение в субботу берёт темы недели; письмо генерируется с форматом дня, когда в банке его нет', async () => {
    const mem = await setup(1);
    const sat = () => '2026-11-07T03:00:00.000Z';
    for (const d of mem.programDays) if (d.dayDate >= '2026-11-02' && d.dayDate <= '2026-11-06') d.topic = 'register';
    mem.items.push(makeItem('mcq', 'B1', 'register'), makeItem('mcq', 'B1', 'register'), makeItem('correction', 'B1', 'register'));
    const satDay = mem.programDays.find(d => d.dayDate === '2026-11-07')!;
    expect(satDay.topic).toBe('mixed');
    satDay.writing = 'explain';
    const o = { ...opts, now: sat };
    let v = await startOrResume(ENV, mem.store, USER, TZ, DOMAIN, o);
    expect(v.topicLabel).toBe('Смешанное повторение');
    expect(v.current).toMatchObject({ kind: 'mcq', topicLabel: 'Регистр рецензента' });
    for (let i = 0; i < 5; i++) v = await answer(ENV, mem.store, USER, v.current!.stepId, v.current!.kind === 'mcq' ? 'C' : v.current!.prompt, TZ, DOMAIN, o);
    expect(v.current).toMatchObject({ part: 'writing' });
    expect(mem.items.find(i => i.id === mem.steps[mem.steps.length - 1].itemId)!.writingFormat).toBe('explain');
    // письма формата explain в банке больше нет — генерация с форматом
    const mem2 = await setup(0);
    mem2.items.splice(0, mem2.items.length, ...mem2.items.filter(i => i.writingFormat !== 'explain'));
    const tue = () => '2026-11-03T03:00:00.000Z';
    const tueDay = mem2.programDays.find(d => d.dayDate === '2026-11-03')!;
    tueDay.topic = 'conjunctions'; tueDay.writing = 'explain';
    const seen: string[] = [];
    const chatFn = async (_env: unknown, msgs: { content: string }[]) => {
      seen.push(msgs[0].content);
      const user = msgs[msgs.length - 1].content;
      if (user.startsWith('Write ')) return JSON.stringify({ items: [{ prompt: 'Explain to the plant manager why the boiler efficiency test was postponed, in 60–80 words.', rubric: ['Причина названа прямо', 'Без жаргона', 'Есть следующий шаг'], answer: SHORT, explanation: 'Прямо и просто.' }] });
      return JSON.stringify({ answer: 'ok', level: 'B1', issues: [] });
    };
    const o2 = { ...opts, now: tue, generate: true, chatFn: chatFn as any };
    let w = await startOrResume(ENV, mem2.store, USER, TZ, DOMAIN, o2);
    expect(w.writing).toBe('explain');
    for (let i = 0; i < 5; i++) w = await answer(ENV, mem2.store, USER, w.current!.stepId, w.current!.kind === 'mcq' ? 'C' : w.current!.prompt, TZ, DOMAIN, o2);
    expect(w.current).toMatchObject({ part: 'writing', kind: 'writing' });
    expect(seen.some(s => s.includes('EXPLANATION FOR A NON-SPECIALIST'))).toBe(true);
    expect(mem2.items.find(i => i.id === mem2.steps[mem2.steps.length - 1].itemId)).toMatchObject({ writingFormat: 'explain', topic: mem2.programDays.find(d => d.dayDate === '2026-11-03')!.topic });
  });
});

describe('хранилище D1 (node:sqlite с миграциями)', () => {
  it('занятие и шаги: вставка, обновление, список, виденные задания; карточка и день программы обновляются', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'a@b.cc')`);
    db.exec(`INSERT INTO items (id, kind, level, topic, prompt, answer, status, writing_format, created_at) VALUES ('i1', 'writing', 'B1', 'register', 'p', 'a', 'verified', 'review', '${NOW}')`);
    db.exec(`INSERT INTO error_cards (id, user_id, topic, example, correction, due, created_at) VALUES ('c1', '${USER}', 'tenses', 'ex', 'fix', '2026-11-01', '${NOW}')`);
    db.exec(`INSERT INTO program_days (id, user_id, day_date, topic, format, status, position, week) VALUES ('d1', '${USER}', '${TODAY}', 'tenses', 'lesson', 'planned', 1, 1)`);
    const d1 = d1Of(db);
    const store = d1LessonStore(d1), cards = d1CardStore(d1), program = d1ProgramStore(d1);
    const l: Lesson = { id: 'l1', userId: USER, programDayId: 'd1', dayDate: TODAY, topic: 'tenses', writing: 'review', level: 'B1', status: 'active', warmupCount: 5, reviewCount: 1, score: null, startedAt: NOW, finishedAt: null, updatedAt: NOW };
    await store.createLesson(l);
    expect(await store.lessonForDay(USER, TODAY)).toEqual(l);
    expect(await store.lessonForDay(USER, '2026-11-03')).toBeNull();
    const s1: LessonStep = { id: 's1', lessonId: 'l1', userId: USER, position: 1, part: 'writing', itemId: 'i1', cardId: null, level: 'B1', answer: null, correct: null, score: null, feedback: null, detail: null, createdAt: NOW, answeredAt: null };
    const s2: LessonStep = { ...s1, id: 's2', position: 2, part: 'review', itemId: null, cardId: 'c1', level: null };
    await store.insertStep(s2); await store.insertStep(s1);
    expect((await store.listSteps('l1')).map(s => s.id)).toEqual(['s1', 's2']);
    await store.updateStep('s1', { answer: 'text', score: 61, feedback: 'ok', detail: '{"axes":{}}', answeredAt: NOW });
    await store.updateStep('s2', { answer: 'fix', correct: 1, score: 100, answeredAt: NOW });
    const steps = await store.listSteps('l1');
    expect(steps[0]).toMatchObject({ answer: 'text', score: 61, correct: null, detail: '{"axes":{}}', answeredAt: NOW });
    expect(steps[1]).toMatchObject({ correct: 1, score: 100, cardId: 'c1' });
    expect(await store.usedLessonItemIds(USER)).toEqual(new Set(['i1']));
    await store.updateLesson('l1', { status: 'finished', score: 80, finishedAt: NOW, reviewCount: 1 });
    expect(await store.lessonForDay(USER, TODAY)).toMatchObject({ status: 'finished', score: 80, finishedAt: NOW });
    await cards.updateCard('c1', { reps: 1, due: '2026-11-05' });
    expect(await cards.getCard('c1')).toMatchObject({ reps: 1, lapses: 0, due: '2026-11-05', retired: false });
    await cards.updateCard('c1', { retired: true });
    expect((await cards.getCard('c1'))!.retired).toBe(true);
    expect(await cards.getCard('nope')).toBeNull();
    await program.updateProgramDay('d1', { status: 'done', score: 80, completedAt: NOW, updatedAt: NOW });
    expect(await program.getProgramDay('d1')).toMatchObject({ status: 'done', score: 80, completedAt: NOW });
    // колонка формата письма читается
    const { d1ItemStore } = await import('../functions/_lib/items');
    expect((await d1ItemStore(d1).getItem('i1'))!.writingFormat).toBe('review');
  });
});

describe('API занятия', () => {
  async function login() {
    const mem = memoryStore(); fillBank(mem.items);
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, ENV);
    const post = (path: string, body: unknown, cookie?: string) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@example.com' })).json();
    const r2 = await post('/auth/verify', { email: 'y@example.com', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { mem, call, post, cookie, userId: mem.users[0].id };
  }
  it('без входа — 401', async () => {
    const { call, post } = await login();
    expect((await call('/lesson')).status).toBe(401);
    expect((await post('/lesson/start', {})).status).toBe(401);
    expect((await post('/lesson/answer', { stepId: 'x', answer: 'A' })).status).toBe(401);
  });
  it('без программы — занятие недоступно и start отвечает 404; с программой — start → answer → GET; чужой шаг — 409', async () => {
    const { mem, call, post, cookie } = await login();
    const g0: any = await (await call('/lesson', { headers: { cookie } })).json();
    expect(g0).toMatchObject({ ok: true, warmup: 5, reviewMax: 5, day: null, available: false, reason: 'no_program', lesson: null });
    const s0 = await post('/lesson/start', {}, cookie);
    expect(s0.status).toBe(404); expect(await s0.json()).toMatchObject({ ok: false, error: 'lesson_no_day', reason: 'no_program' });
    await post('/program/generate', {}, cookie);
    // день программы сегодня может оказаться репетицией или срезом — тогда 409 с причиной; иначе — занятие
    const g1: any = await (await call('/lesson', { headers: { cookie } })).json();
    expect(g1.day.today).toBe(true);
    const s1 = await post('/lesson/start', {}, cookie);
    if (!g1.available) {
      expect(s1.status).toBe(409); expect(await s1.json()).toMatchObject({ error: 'lesson_unavailable', reason: g1.reason });
      return;
    }
    // тема дня может быть любой — подложим задания по ней
    for (const l of ['B1', 'B2'] as Level[]) for (let i = 0; i < 3; i++) { mem.items.push(makeItem('mcq', l, g1.day.topic)); mem.items.push(makeItem('correction', l, g1.day.topic)); }
    const s2: any = await (await post('/lesson/start', {}, cookie)).json();
    expect(s2.ok).toBe(true); expect(s2.lesson.current.position).toBe(1);
    expect(JSON.stringify(s2.lesson.current)).not.toContain('"answer"');
    const bad = await post('/lesson/answer', { stepId: 'x', answer: 'C' }, cookie);
    expect(bad.status).toBe(409); expect(await bad.json()).toMatchObject({ error: 'lesson_stale' });
    const a: any = await (await post('/lesson/answer', { stepId: s2.lesson.current.stepId, answer: 'C' }, cookie)).json();
    expect(a.lesson.last).toMatchObject({ position: 1, correct: 1 }); expect(a.lesson.current.position).toBe(2);
    const g2: any = await (await call('/lesson', { headers: { cookie } })).json();
    expect(g2.lesson).toMatchObject({ id: s2.lesson.id, answered: 1 }); expect(g2.lesson.last).toBeNull();
    const empty = await post('/lesson/answer', { stepId: g2.lesson.current.stepId, answer: '' }, cookie);
    expect(empty.status).toBe(400); expect(await empty.json()).toMatchObject({ error: 'answer_invalid', reason: 'empty' });
  });
});
