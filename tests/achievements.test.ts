import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS, achievementByCode, streakProgress, syncAchievements, publicAchievement, d1AchievementStore,
  TOPIC_STREAK, STRETCH_STREAK, type AnswerRecord, type Context,
} from '../functions/_lib/achievements';
import { TOPICS } from '../functions/_lib/items';
import type { Item, Kind, Level } from '../functions/_lib/items';
import type { Lesson, LessonStep } from '../functions/_lib/lesson';
import type { Attempt } from '../functions/_lib/types';
import type { ErrorCard } from '../functions/_lib/cards';
import { d1LessonStore } from '../functions/_lib/lesson';
import { d1CardStore } from '../functions/_lib/cards';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { freshDb, d1Of } from './helpers/sqliteD1';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
const USER = 'u1';
const TZ = 'Asia/Almaty';
const NOW = '2026-11-12T03:00:00.000Z';
let seq = 0;
const at = (i: number) => `2026-11-${String(1 + Math.floor(i / 10)).padStart(2, '0')}T0${i % 10}:00:00.000Z`;

const rec = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  at: at(++seq), source: 'lesson', lessonId: 'l1', part: 'warmup', kind: 'mcq', topic: 'conjunctions', level: 'B1', lessonLevel: 'B1', writingFormat: null, correct: 1, score: 100, detail: null, ...over,
});
const writing = (format: 'review' | 'explain', errors: number, level: Level = 'B2', over: Partial<AnswerRecord> = {}) => rec({
  kind: 'writing', part: 'writing', writingFormat: format, correct: null, score: 60,
  detail: JSON.stringify({ axes: { grammar: 60, vocabulary: 60, coherence: 60, taskResponse: 60 }, level, summary: 's', errors: Array.from({ length: errors }, (_, i) => ({ original: `e${i}`, corrected: `c${i}`, note: 'n' })), rewrite: null }), ...over,
});
const lessonOf = (over: Partial<Lesson> = {}): Lesson => ({
  id: `l${++seq}`, userId: USER, programDayId: null, dayDate: '2026-11-02', topic: 'conjunctions', writing: 'review', level: 'B1', status: 'finished', warmupCount: 5, reviewCount: 0, score: 80,
  startedAt: NOW, finishedAt: NOW, updatedAt: NOW, bonus: null, ...over,
});
const cardOf = (retired: boolean): ErrorCard => ({ id: `c${++seq}`, userId: USER, topic: 'tenses', rule: null, example: 'ex', correction: 'fix', source: 'seed', origin: null, stability: 1, difficulty: 5, due: null, reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired, createdAt: NOW });
const ctx = (over: Partial<Context> = {}): Context => ({ log: [], cards: [], lessons: [], tz: TZ, ...over });
const check = (code: string, c: Context) => achievementByCode(code)!.check(c);

describe('каталог', () => {
  it('по достижению на каждую тему банка, письмо двух форматов, C1, растяжка, карточки, бонусы, разминка; коды уникальны', () => {
    const codes = ACHIEVEMENTS.map(a => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const t of TOPICS) expect(codes).toContain(`streak5:${t.id}`);
    for (const c of ['review-clean', 'explain-clean', 'writing-c1', 'stretch3', 'retired-1', 'retired-10', 'bonus-1', 'bonus-5', 'warmup-perfect']) expect(codes).toContain(c);
    expect(ACHIEVEMENTS).toHaveLength(TOPICS.length + 9);
    expect(achievementByCode('streak5:conjunctions')!.title).toBe('Пять подряд без ошибки — союзы и инверсия');
    for (const a of ACHIEVEMENTS) { expect(a.title).not.toMatch(/[!]/); expect(a.target).toBeGreaterThan(0); }
  });
});

describe('серии', () => {
  it('серия верных подряд: текущая — пока цель не взята; взятая — лучшая с датой пятого верного; неверный рвёт', () => {
    const rows = [rec(), rec(), rec({ correct: 0 }), rec(), rec(), rec()];
    expect(streakProgress(rows, 5, TZ)).toEqual({ value: 3, target: 5, detail: null });
    const fifth = rec();
    const full = [...rows, rec(), fifth, rec({ correct: 0 })];
    expect(streakProgress(full, 5, TZ)).toEqual({ value: 5, target: 5, detail: fifth.at.slice(0, 10) });
    expect(streakProgress([], 5, TZ)).toEqual({ value: 0, target: 5, detail: null });
  });
  it('пять подряд по теме: считаются тест, разминка и бонус той же темы; другая тема, письмо и повтор карточек — нет', () => {
    const log = [
      rec({ source: 'assessment', part: null, lessonId: null, lessonLevel: null }), rec({ topic: 'articles', correct: 0 }), rec(), rec({ part: 'bonus' }),
      writing('review', 2), rec({ part: 'review' as any, correct: 0 }), rec(), rec(),
    ];
    expect(check('streak5:conjunctions', ctx({ log }))).toMatchObject({ value: 5, target: TOPIC_STREAK });
    expect(check('streak5:articles', ctx({ log }))).toMatchObject({ value: 0 });
    expect(check('streak5:conjunctions', ctx({ log: log.slice(0, 4) }))).toMatchObject({ value: 3, detail: null });
  });
  it('три растяжки подряд: только разминка с уровнем задания выше уровня занятия', () => {
    const log = [rec({ level: 'B2' }), rec({ level: 'B1' , correct: 0 }), rec({ level: 'B2' }), rec({ level: 'B2', part: 'bonus' }), rec({ level: 'C1' })];
    expect(check('stretch3', ctx({ log }))).toMatchObject({ value: 3, target: STRETCH_STREAK });
    expect(check('stretch3', ctx({ log: [rec({ level: 'B2' }), rec({ level: 'B2', correct: 0 }), rec({ level: 'B2' })] }))).toMatchObject({ value: 1 });
  });
});

describe('письмо, карточки, бонусы, разминка', () => {
  it('отзыв и объяснение без правок — по формату письма с нулём ошибок; письмо C1 — по уровню экзаменатора', () => {
    const log = [writing('review', 1), writing('explain', 0, 'B1'), writing('review', 0, 'C1'), writing('review', 0, 'B2')];
    expect(check('review-clean', ctx({ log }))).toMatchObject({ value: 2, target: 1, detail: log[2].at.slice(0, 10) });
    expect(check('explain-clean', ctx({ log }))).toMatchObject({ value: 1, detail: log[1].at.slice(0, 10) });
    expect(check('writing-c1', ctx({ log }))).toMatchObject({ value: 1 });
    expect(check('review-clean', ctx({ log: [writing('review', 1), rec({ kind: 'writing', detail: null })] }))).toMatchObject({ value: 0 });
  });
  it('погашенные карточки — 1 и 10; бонусы — верно решённые занятия; разминка без ошибок — все задания разминки занятия верны', () => {
    const cards = [cardOf(true), cardOf(false), cardOf(true)];
    expect(check('retired-1', ctx({ cards }))).toMatchObject({ value: 2, target: 1 });
    expect(check('retired-10', ctx({ cards }))).toMatchObject({ value: 2, target: 10, detail: null });
    const lessons = [lessonOf({ bonus: 'correct' }), lessonOf({ bonus: 'wrong' }), lessonOf({ bonus: 'declined' }), lessonOf({ bonus: 'correct', finishedAt: '2026-11-05T03:00:00.000Z' })];
    expect(check('bonus-1', ctx({ lessons }))).toMatchObject({ value: 2, detail: '2026-11-12' });
    expect(check('bonus-5', ctx({ lessons }))).toMatchObject({ value: 2, target: 5, detail: null });
    const l1 = lessonOf(), l2 = lessonOf();
    const log = [...Array.from({ length: 5 }, () => rec({ lessonId: l1.id })), ...Array.from({ length: 4 }, () => rec({ lessonId: l2.id })), rec({ lessonId: l2.id, correct: 0 })];
    expect(check('warmup-perfect', ctx({ log, lessons: [l1, l2] }))).toMatchObject({ value: 1, target: 1 });
    expect(check('warmup-perfect', ctx({ log: log.slice(0, 4), lessons: [l1] }))).toMatchObject({ value: 0 }); // четыре из пяти — не вся разминка
  });
});

describe('открытие и запись', () => {
  function makeItem(kind: Kind, level: Level, topic: string): Item {
    const n = ++seq;
    return { id: `it${n}`, kind, level, topic, domain: null, prompt: `p ${n} ___`, options: kind === 'mcq' ? ['a', 'b', 'c', 'd'] : null, answer: kind === 'mcq' ? 'C' : `fixed ${n}`, rubric: null, explanation: null, status: 'verified', checkNote: null, checkedLevel: null, fingerprint: `fp${n}`, source: 'test', writingFormat: kind === 'writing' ? 'review' : null, createdAt: NOW, verifiedAt: null };
  }
  const step = (lessonId: string, item: Item, correct: number, position: number): LessonStep => ({ id: `s${++seq}`, lessonId, userId: USER, position, part: 'warmup', itemId: item.id, cardId: null, level: item.level, answer: 'C', correct, score: correct * 100, feedback: null, detail: null, createdAt: at(seq), answeredAt: at(seq) });

  it('sync открывает достижения один раз с датой, возвращает каталог с прогрессом (открытые первыми) и только новые; seen гасит «новое»', async () => {
    const mem = memoryStore();
    const l = lessonOf({ bonus: 'correct' });
    mem.lessons.push(l);
    const items = Array.from({ length: 5 }, () => makeItem('mcq', 'B1', 'articles'));
    mem.items.push(...items);
    items.forEach((it, i) => mem.steps.push(step(l.id, it, 1, i + 1)));
    mem.cards.push(cardOf(true));
    const r1 = await syncAchievements(mem.store, USER, TZ, { now: () => NOW });
    expect(r1.fresh.map(a => a.code).sort()).toEqual(['bonus-1', 'retired-1', 'streak5:articles', 'warmup-perfect']);
    expect(r1.all).toHaveLength(ACHIEVEMENTS.length);
    expect(r1.all.slice(0, 4).every(a => a.unlocked && a.new && a.unlockedAt === NOW)).toBe(true);
    expect(r1.all.find(a => a.code === 'streak5:articles')).toMatchObject({ unlocked: true, detail: mem.steps[4].answeredAt!.slice(0, 10), progress: { value: 5, target: 5 }, groupLabel: 'темы' });
    expect(r1.all.find(a => a.code === 'retired-10')).toMatchObject({ unlocked: false, new: false, progress: { value: 1, target: 10 } });
    expect(mem.achievements).toHaveLength(4);
    // повторный пересчёт ничего не добавляет и не меняет дату
    const r2 = await syncAchievements(mem.store, USER, TZ, { now: () => '2026-11-13T03:00:00.000Z' });
    expect(r2.fresh).toEqual([]); expect(mem.achievements).toHaveLength(4);
    expect(r2.all.find(a => a.code === 'bonus-1')!.unlockedAt).toBe(NOW);
    // открытое остаётся открытым, даже если данные изменились
    mem.cards[0].retired = false;
    const r3 = await syncAchievements(mem.store, USER, TZ);
    expect(r3.all.find(a => a.code === 'retired-1')).toMatchObject({ unlocked: true, progress: { value: 0, target: 1 } });
    await mem.store.markAchievementsSeen(USER, NOW);
    const r4 = await syncAchievements(mem.store, USER, TZ);
    expect(r4.all.filter(a => a.new)).toEqual([]);
    expect(r4.all.filter(a => a.unlocked)).toHaveLength(4);
    // незакрытые — по близости к цели
    const locked = r4.all.filter(a => !a.unlocked);
    for (let i = 1; i < locked.length; i++) expect(locked[i - 1].progress.value / locked[i - 1].progress.target).toBeGreaterThanOrEqual(locked[i].progress.value / locked[i].progress.target);
  });
  it('publicAchievement: прогресс не выше цели, detail из записи важнее расчётного', () => {
    const def = achievementByCode('retired-10')!;
    expect(publicAchievement(def, { value: 12, target: 10, detail: '2026-11-03' }, { userId: USER, code: def.code, unlockedAt: NOW, detail: '2026-11-01', seenAt: NOW })).toMatchObject({ unlocked: true, new: false, detail: '2026-11-01', progress: { value: 10, target: 10 } });
  });
  it('D1: журнал ответов объединяет попытки теста и шаги занятий по времени; достижения пишутся один раз и отмечаются увиденными', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'a@b.cc')`);
    db.exec(`INSERT INTO items (id, kind, level, topic, prompt, answer, status, writing_format, created_at) VALUES ('i1', 'mcq', 'B1', 'articles', 'p', 'C', 'verified', NULL, '${NOW}'), ('i2', 'writing', 'B2', 'register', 'p', 'a', 'verified', 'review', '${NOW}')`);
    db.exec(`INSERT INTO assessments (id, user_id, kind, started_at, status, current_level, updated_at) VALUES ('a1', '${USER}', 'placement', '${NOW}', 'finished', 'B1', '${NOW}')`);
    db.exec(`INSERT INTO attempts (id, user_id, assessment_id, item_id, position, level, answer, correct, score, created_at, answered_at) VALUES ('t1', '${USER}', 'a1', 'i1', 1, 'B1', 'C', 1, 100, '${NOW}', '2026-11-12T03:05:00.000Z'), ('t2', '${USER}', 'a1', 'i1', 2, 'B1', NULL, NULL, NULL, '${NOW}', NULL)`);
    const d1 = d1Of(db);
    const lessons = d1LessonStore(d1), store = d1AchievementStore(d1);
    await lessons.createLesson(lessonOf({ id: 'l1', level: 'B1' }));
    await lessons.insertStep({ id: 's1', lessonId: 'l1', userId: USER, position: 1, part: 'warmup', itemId: 'i1', cardId: null, level: 'B2', answer: 'A', correct: 0, score: 0, feedback: null, detail: null, createdAt: NOW, answeredAt: '2026-11-12T03:01:00.000Z' });
    await lessons.insertStep({ id: 's2', lessonId: 'l1', userId: USER, position: 6, part: 'writing', itemId: 'i2', cardId: null, level: 'B1', answer: 'text', correct: null, score: 70, feedback: null, detail: '{"axes":{},"level":"C1","errors":[]}', createdAt: NOW, answeredAt: '2026-11-12T03:09:00.000Z' });
    await lessons.insertStep({ id: 's3', lessonId: 'l1', userId: USER, position: 7, part: 'review', itemId: null, cardId: null, level: null, answer: null, correct: null, score: null, feedback: null, detail: null, createdAt: NOW, answeredAt: null });
    const log = await store.answerLog(USER);
    expect(log.map(r => [r.source, r.part, r.kind, r.topic, r.level, r.lessonLevel, r.writingFormat, r.correct])).toEqual([
      ['lesson', 'warmup', 'mcq', 'articles', 'B2', 'B1', null, 0],
      ['assessment', null, 'mcq', 'articles', 'B1', null, null, 1],
      ['lesson', 'writing', 'writing', 'register', 'B1', 'B1', 'review', null],
    ]);
    expect(log[2].detail).toContain('"C1"');
    expect(await store.listAchievements(USER)).toEqual([]);
    expect(await store.insertAchievements([{ userId: USER, code: 'writing-c1', unlockedAt: NOW, detail: '2026-11-12', seenAt: null }, { userId: USER, code: 'writing-c1', unlockedAt: '2027-01-01T00:00:00.000Z', detail: null, seenAt: null }])).toBe(1);
    expect(await store.listAchievements(USER)).toEqual([{ userId: USER, code: 'writing-c1', unlockedAt: NOW, detail: '2026-11-12', seenAt: null }]);
    await store.markAchievementsSeen(USER, '2026-11-12T04:00:00.000Z');
    expect((await store.listAchievements(USER))[0].seenAt).toBe('2026-11-12T04:00:00.000Z');
    // полный пересчёт по D1: письмо C1 уже открыто, review-clean открывается
    const full = { ...lessons, ...store, ...d1CardStore(d1) };
    const r = await syncAchievements(full, USER, TZ, { now: () => NOW });
    expect(r.fresh.map(a => a.code)).toEqual(['review-clean']);
    expect(r.all.filter(a => a.unlocked).map(a => a.code).sort()).toEqual(['review-clean', 'writing-c1']);
  });
});

describe('API достижений', () => {
  async function login() {
    const mem = memoryStore();
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, ENV);
    const post = (path: string, body: unknown, cookie?: string) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@example.com' })).json();
    const r2 = await post('/auth/verify', { email: 'y@example.com', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { mem, call, post, cookie, userId: mem.users[0].id };
  }
  it('без входа — 401; каталог с прогрессом и счётчиками; seen гасит новое', async () => {
    const { mem, call, post, cookie, userId } = await login();
    expect((await call('/achievements')).status).toBe(401);
    expect((await post('/achievements/seen', {})).status).toBe(401);
    mem.cards.push({ ...cardOf(true), userId });
    const g: any = await (await call('/achievements', { headers: { cookie } })).json();
    expect(g).toMatchObject({ ok: true, total: ACHIEVEMENTS.length, unlocked: 1, fresh: 1 });
    expect(g.achievements[0]).toMatchObject({ code: 'retired-1', unlocked: true, new: true, title: 'Первая погашенная карточка', groupLabel: 'журнал' });
    expect(g.achievements.every((a: any) => typeof a.title === 'string' && a.progress.target > 0)).toBe(true);
    expect((await post('/achievements/seen', {}, cookie)).status).toBe(200);
    const g2: any = await (await call('/achievements', { headers: { cookie } })).json();
    expect(g2).toMatchObject({ unlocked: 1, fresh: 0 }); expect(g2.achievements[0].new).toBe(false);
  });
});
