import { describe, it, expect } from 'vitest';
import {
  programLength, checkpointPositions, layout, errorProfile, assignTopics, buildProgram, generateProgram, swapDays, current,
  d1ProgramStore, ProgramError, PROGRAM_DAYS, WEAK_AXIS, BASE_WEIGHT, CARD_WEIGHT, LESSON_TOPICS, MIXED_TOPIC, WRITING_FORMATS, type ProgramDay,
} from '../functions/_lib/program';
import type { ErrorCard } from '../functions/_lib/cards';
import type { Assessment } from '../functions/_lib/assessment';
import type { Attempt } from '../functions/_lib/types';
import type { Item } from '../functions/_lib/items';
import type { Profile } from '../functions/_lib/profile';
import { createApp, type Env } from '../functions/_lib/app';
import { freshDb, d1Of, sqlStore } from './helpers/sqliteD1';

const USER = 'u1';
const NOW = '2026-11-02T03:00:00.000Z'; // понедельник 2 ноября 2026 в Алматы
const TZ = 'Asia/Almaty';
let seq = 0;
const nextId = () => `d${++seq}`;

const card = (topic: string, retired = false): ErrorCard => ({
  id: `c${++seq}`, userId: USER, topic, rule: 'правило', example: 'wrong', correction: 'right', source: 'seed',
  origin: null, stability: 1, difficulty: 5, due: '2026-11-01', reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired, createdAt: NOW,
});
const assessment = (axes: Record<string, number | null>, kind: Assessment['kind'] = 'baseline'): Assessment => ({
  id: 'a1', userId: USER, kind, status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level: 'B1', currentLevel: 'B1',
  updatedAt: NOW, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null, ...axes } as any, overall: 53, scoredAt: NOW, scoringNote: null, adaptiveCount: 12, programDayId: null,
});
const item = (id: string, topic: string): Item => ({
  id, kind: 'mcq', level: 'B1', topic, domain: null, prompt: '___', options: ['a', 'b', 'c', 'd'], answer: 'A', rubric: null, explanation: null,
  status: 'verified', checkNote: null, checkedLevel: null, writingFormat: null, fingerprint: id, source: 'test', createdAt: NOW, verifiedAt: null,
});
const attempt = (itemId: string, correct: number | null): Attempt => ({
  id: `t${++seq}`, userId: USER, assessmentId: 'a1', itemId, position: 1, level: 'B1', answer: 'B', correct, score: correct == null ? null : correct * 100,
  feedback: null, detail: null, createdAt: NOW, answeredAt: NOW,
});
const profile = (over: Partial<Profile> = {}): Profile => ({
  userId: USER, specialty: 'инженер', industry: 'энергетика', years: 15, targetRole: 'Отбор на OpenTrain AI', keywords: [], summary: null,
  resumeText: null, resumeName: null, resumeAt: null, interviewDate: null, interviewFormat: 'ai', minutesPerDay: 25, nativeLanguage: 'русский', onboardedAt: NOW, targetLevel: 'C1', weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: NOW, ...over,
});

/** Журнал как у первого пользователя: союзы и регистр по две карточки, остальное по одной. */
const YURIY_CARDS = ['conjunctions', 'conjunctions', 'quantifiers', 'relative', 'vocabulary', 'register', 'quantifiers', 'verb-patterns', 'conditionals', 'articles', 'tenses', 'register', 'spelling', 'task-response'].map(t => card(t));

describe('длина программы и срезы', () => {
  it('без даты — четыре недели; до собеседования — не дальше дня перед ним; собеседование сегодня или прошло — четыре недели', () => {
    expect(programLength('2026-11-02', null)).toBe(PROGRAM_DAYS);
    expect(programLength('2026-11-02', '2026-11-12')).toBe(10);
    expect(programLength('2026-11-02', '2026-11-03')).toBe(1);
    expect(programLength('2026-11-02', '2026-11-02')).toBe(PROGRAM_DAYS);
    expect(programLength('2026-11-02', '2026-10-01')).toBe(PROGRAM_DAYS);
    expect(programLength('2026-11-02', '2027-03-01')).toBe(PROGRAM_DAYS);
  });
  it('срезы на 14-й и 28-й день; короткая программа от недели заканчивается срезом; короче недели — без среза', () => {
    expect(checkpointPositions(28)).toEqual([14, 28]);
    expect(checkpointPositions(20)).toEqual([14]);
    expect(checkpointPositions(10)).toEqual([10]);
    expect(checkpointPositions(5)).toEqual([]);
  });
});

describe('разметка дней', () => {
  it('с понедельника: воскресенья — репетиция, субботы — смешанное повторение, срез в конце второй и четвёртой недели сдвигает репетицию на субботу', () => {
    const days = layout('2026-11-02', 28);
    expect(days).toHaveLength(28);
    const kinds = days.map(d => d.kind);
    expect(days[0].date).toBe('2026-11-02');
    expect(days[27].date).toBe('2026-11-29');
    expect(kinds[13]).toBe('checkpoint'); expect(kinds[27]).toBe('checkpoint');
    expect(kinds[12]).toBe('rehearsal'); expect(kinds[26]).toBe('rehearsal'); // субботы перед срезом
    expect(kinds[6]).toBe('rehearsal'); expect(kinds[20]).toBe('rehearsal'); // обычные воскресенья
    expect(kinds[5]).toBe('mixed'); expect(kinds[19]).toBe('mixed');
    expect(kinds.filter(k => k === 'lesson')).toHaveLength(20);
    expect(days.map(d => d.week)).toEqual([...Array(28)].map((_, i) => Math.floor(i / 7) + 1));
  });
  it('со среды: первая неделя короче до воскресенья, недели считаются по семь дней программы', () => {
    const days = layout('2026-11-04', 10);
    expect(days.map(d => d.kind)).toEqual(['lesson', 'lesson', 'lesson', 'mixed', 'rehearsal', 'lesson', 'lesson', 'lesson', 'lesson', 'checkpoint']);
  });
});

describe('профиль ошибок', () => {
  it('вес темы: базовый + карточки ×2 + ошибки теста + слабые оси; погашенные карточки не считаются', () => {
    const items = new Map([['i1', item('i1', 'modals')], ['i2', item('i2', 'conjunctions')]]);
    const p = errorProfile([...YURIY_CARDS, card('modals', true)], assessment({}), [attempt('i1', 0), attempt('i2', 0), attempt('i2', 1)], items);
    const w = Object.fromEntries(p.topics.map(t => [t.topic, t]));
    // все четыре оси ниже порога B2 (60) — у каждой темы добавка по числу её осей
    expect(WEAK_AXIS).toBe(60);
    expect(w.conjunctions.weight).toBe(BASE_WEIGHT + 2 * CARD_WEIGHT + 1 + 2); // грамматика и связность
    expect(w.conjunctions.weakAxes).toEqual(['grammar', 'coherence']);
    expect(w.vocabulary.weight).toBe(BASE_WEIGHT + CARD_WEIGHT + 1); // ось словаря
    expect(w.modals.weight).toBe(BASE_WEIGHT + 1 + 1); // ошибка в тесте + грамматика, погашенная карточка не в счёт
    expect(w['task-response'].weight).toBe(BASE_WEIGHT + CARD_WEIGHT + 1);
    expect(w.passive.weight).toBe(BASE_WEIGHT + 1);
    expect(p.cards).toBe(14);
    expect(p.assessment?.kind).toBe('baseline');
  });
  it('без журнала и теста все темы весят одинаково, осей нет', () => {
    const p = errorProfile([], null, [], new Map());
    expect(new Set(p.topics.map(t => t.weight))).toEqual(new Set([BASE_WEIGHT]));
    expect(p.axes).toBeNull();
    expect(p.topics).toHaveLength(LESSON_TOPICS.length);
  });
  it('сильные оси добавки не дают', () => {
    const p = errorProfile([], assessment({ grammar: 80, vocabulary: 70, coherence: 65, taskResponse: 61 }), [], new Map());
    expect(p.topics.every(t => t.weakAxes.length === 0)).toBe(true);
  });
});

describe('распределение тем', () => {
  it('тяжёлые темы встречаются чаще, лёгкие — реже, подряд тема не повторяется, темы с карточками — все хотя бы раз за 20 занятий', () => {
    const p = errorProfile(YURIY_CARDS, assessment({}), [], new Map());
    const seqs = assignTopics(20, p.topics).map(t => t.topic);
    expect(seqs).toHaveLength(20);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).not.toBe(seqs[i - 1]);
    const count = (t: string) => seqs.filter(x => x === t).length;
    expect(count('conjunctions')).toBeGreaterThan(count('passive'));
    expect(count('register')).toBeGreaterThan(count('modals'));
    for (const t of p.topics.filter(t => t.cards > 0)) expect(count(t.topic), t.topic).toBeGreaterThanOrEqual(1); // темы с карточками — все
    expect(seqs[0]).toBe('conjunctions'); // самая тяжёлая тема — в первый день
  });
  it('одна тема — повторяется, раз выбирать не из чего', () => {
    expect(assignTopics(3, [{ topic: 'x', label: 'x', weight: 1, cards: 0, mistakes: 0, weakAxes: [] }]).map(t => t.topic)).toEqual(['x', 'x', 'x']);
  });
});

describe('сборка программы', () => {
  const build = (over: Partial<Parameters<typeof buildProgram>[0]> = {}) => buildProgram({
    userId: USER, startDate: '2026-11-02', interviewDate: null, minutesPerDay: 25, targetRole: 'Отбор на OpenTrain AI',
    profile: errorProfile(YURIY_CARDS, assessment({}), [], new Map()), now: NOW, id: nextId, ...over,
  });
  it('28 дней: письмо чередуется по дням занятий, у репетиции и среза письма нет, у каждого дня причина', () => {
    const days = build();
    expect(days).toHaveLength(28);
    const lessons = days.filter(d => d.format === 'lesson');
    expect(lessons.map(d => d.writing)).toEqual(lessons.map((_, i) => WRITING_FORMATS[i % 2]));
    expect(days.filter(d => d.format !== 'lesson').every(d => d.writing === null)).toBe(true);
    expect(days.every(d => d.reason && d.reason.length > 5)).toBe(true);
    expect(days.find(d => d.format === 'checkpoint')!.reason).toBe('укороченный тест, сравнение с исходным срезом от 29 октября 2026');
    expect(days.find(d => d.format === 'checkpoint')!.minutes).toBe(15);
    expect(days.find(d => d.format === 'rehearsal')!.reason).toContain('OpenTrain AI');
    expect(lessons.every(d => d.minutes === 25)).toBe(true);
    expect(days.filter(d => d.topic === MIXED_TOPIC.id && d.format === 'lesson')).toHaveLength(2);
    expect(days[0].reason).toBe('2 карточки в журнале, ось «точность грамматики» 54, ось «связность» 54');
    expect(days.every(d => d.status === 'planned' && d.generatedAt === NOW)).toBe(true);
  });
  it('занятые даты пропускаются, собеседование укорачивает программу', () => {
    const days = build({ interviewDate: '2026-11-12', occupied: new Set(['2026-11-02']) });
    expect(days).toHaveLength(9);
    expect(days[0].dayDate).toBe('2026-11-03');
    expect(days[0].position).toBe(2);
    expect(days[days.length - 1]).toMatchObject({ dayDate: '2026-11-11', format: 'checkpoint' });
  });
  it('без журнала и теста причина честная, срез — первая точка сравнения', () => {
    const days = build({ profile: errorProfile([], null, [], new Map()), targetRole: null });
    expect(days[0].reason).toContain('ошибок по теме пока не записано');
    expect(days.find(d => d.format === 'checkpoint')!.reason).toContain('первая точка сравнения');
    expect(days.find(d => d.format === 'rehearsal')!.reason).toContain('по профилю резюме');
  });
});

describe('программа в хранилище', () => {
  const now = () => NOW;
  async function setup() {
    const mem = sqlStore(); mem.addUser(USER);
    await mem.store.insertCards(YURIY_CARDS.map(c => ({ ...c })));
    await mem.putAssessment(assessment({}));
    return mem;
  }
  it('построить → посмотреть; пересборка сохраняет пройденный день и заменяет остальные', async () => {
    const mem = await setup();
    expect(await current(mem.store, USER, TZ, profile(), now)).toBeNull();
    const v = await generateProgram(mem.store, USER, TZ, profile(), { now, id: nextId });
    expect(v.startDate).toBe('2026-11-02'); expect(v.endDate).toBe('2026-11-29'); expect(v.totalDays).toBe(28); expect(v.today).toBe('2026-11-02');
    expect(v.counts).toEqual({ lessons: 22, rehearsals: 4, checkpoints: 2, done: 0 });
    expect(v.days[0].today).toBe(true); expect(v.days[0].weekday).toBe('пн'); expect(v.days[0].topicLabel).toBe('Союзы и инверсия');
    expect(v.days[0].writingLabel).toBe('отзыв рецензента'); expect(v.days[1].writingLabel).toBe('объяснение неспециалисту');
    expect(v.topics.find(t => t.id === 'conjunctions')!.days).toBeGreaterThan(1);
    // день пройден — пересборка завтра его не трогает и не дублирует
    const [first] = await mem.store.listProgramDays(USER);
    await mem.store.updateProgramDay(first.id, { status: 'done', completedAt: NOW });
    const tomorrow = () => '2026-11-03T03:00:00.000Z';
    const v2 = await generateProgram(mem.store, USER, TZ, profile({ interviewDate: '2026-11-20' }), { now: tomorrow, id: nextId });
    expect(v2.startDate).toBe('2026-11-02'); // идущая программа не начинается заново
    expect(v2.days[0]).toMatchObject({ date: '2026-11-02', status: 'done', past: true, position: 1 });
    expect(v2.days[1]).toMatchObject({ date: '2026-11-03', today: true, status: 'planned', position: 2 });
    expect(v2.endDate).toBe('2026-11-19');
    expect(v2.totalDays).toBe(18);
    expect(new Set(v2.days.map(d => d.date)).size).toBe(v2.days.length);
    expect(mem.rows("SELECT id FROM program_days WHERE status = 'planned' AND generated_at = ?", NOW)).toHaveLength(0);
    expect(v2.counts.done).toBe(1);
    // программа закончилась — новая начинается сегодня
    const later = () => '2026-12-01T03:00:00.000Z';
    const v3 = await generateProgram(mem.store, USER, TZ, profile(), { now: later, id: nextId });
    expect(v3.startDate).toBe('2026-12-01'); expect(v3.totalDays).toBe(28); expect(v3.counts.done).toBe(0);
  });
  it('перестановка тем: только занятия, только не пройденные, не в прошлом', async () => {
    const mem = await setup();
    const v = await generateProgram(mem.store, USER, TZ, profile(), { now, id: nextId });
    const [a, b] = v.days.filter(d => d.format === 'lesson');
    const v2 = await swapDays(mem.store, USER, TZ, profile(), a.id, b.id, { now });
    expect(v2.days[0]).toMatchObject({ id: a.id, topic: b.topic, reason: b.reason, writing: a.writing });
    expect(v2.days[1]).toMatchObject({ id: b.id, topic: a.topic, reason: a.reason });
    const rehearsal = v.days.find(d => d.format === 'rehearsal')!;
    await expect(swapDays(mem.store, USER, TZ, profile(), a.id, rehearsal.id)).rejects.toMatchObject({ code: 'program_invalid', reason: 'not_lesson' });
    await expect(swapDays(mem.store, USER, TZ, profile(), a.id, a.id)).rejects.toMatchObject({ reason: 'same' });
    await expect(swapDays(mem.store, USER, TZ, profile(), a.id, 'nope')).rejects.toMatchObject({ reason: 'not_found' });
    await expect(swapDays(mem.store, 'other', TZ, profile(), a.id, b.id)).rejects.toMatchObject({ reason: 'not_found' });
    await mem.store.updateProgramDay(b.id, { status: 'done' });
    await expect(swapDays(mem.store, USER, TZ, profile(), a.id, b.id)).rejects.toMatchObject({ reason: 'not_planned' });
    const c = v.days.filter(d => d.format === 'lesson')[2];
    await expect(swapDays(mem.store, USER, TZ, profile(), a.id, c.id, { now: () => '2026-11-05T03:00:00.000Z' })).rejects.toBeInstanceOf(ProgramError);
  });
});

describe('хранилище D1 (node:sqlite с миграциями)', () => {
  it('вставляет дни, при пересборке удаляет только незавершённые с даты, переставляет темы', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'a@b.cc')`);
    const store = d1ProgramStore(d1Of(db));
    const days = buildProgram({ userId: USER, startDate: '2026-11-02', interviewDate: null, minutesPerDay: 20, targetRole: null, profile: errorProfile([], null, [], new Map()), now: NOW, id: nextId });
    await store.replacePlannedDays(USER, '2026-11-02', days);
    const list = await store.listProgramDays(USER);
    expect(list).toHaveLength(28);
    expect(list[0]).toMatchObject({ dayDate: '2026-11-02', position: 1, week: 1, format: 'lesson', writing: 'review', status: 'planned', minutes: 20, generatedAt: NOW });
    expect(list[13]).toMatchObject({ format: 'checkpoint', writing: null });
    db.exec(`UPDATE program_days SET status = 'done', completed_at = '${NOW}' WHERE id = '${list[0].id}'`);
    await store.replacePlannedDays(USER, '2026-11-03', days.slice(1).map(d => ({ ...d, id: nextId(), generatedAt: '2026-11-03T00:00:00.000Z' })));
    const list2 = await store.listProgramDays(USER);
    expect(list2).toHaveLength(28);
    expect(list2[0]).toMatchObject({ id: list[0].id, status: 'done' });
    expect(list2[1].generatedAt).toBe('2026-11-03T00:00:00.000Z');
    await store.updateProgramDay(list2[1].id, { topic: 'passive', reason: 'проверка', updatedAt: NOW });
    expect(await store.getProgramDay(list2[1].id)).toMatchObject({ topic: 'passive', reason: 'проверка', updatedAt: NOW });
    expect(await store.getProgramDay('nope')).toBeNull();
    expect(await store.listProgramDays('other')).toEqual([]);
  });
});

describe('API программы', () => {
  const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
  async function login() {
    const mem = sqlStore();
    const app = createApp('test');
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, { ...ENV, DB: mem.DB });
    const post = (path: string, body: unknown, cookie?: string) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@example.com' })).json();
    const r2 = await post('/auth/verify', { email: 'y@example.com', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const userId = mem.rows<{ id: string }>('SELECT id FROM users')[0].id;
    return { mem, call, post, cookie, userId };
  }
  it('без входа — 401', async () => {
    const { call, post } = await login();
    expect((await call('/program')).status).toBe(401);
    expect((await post('/program/generate', {})).status).toBe(401);
    expect((await post('/program/swap', { a: 'x', b: 'y' })).status).toBe(401);
  });
  it('пустая программа → generate → GET → swap; ошибки перестановки — 400 с причиной', async () => {
    const { mem, call, post, cookie, userId } = await login();
    await mem.store.insertCards(YURIY_CARDS.map(c => ({ ...c, userId })));
    const empty: any = await (await call('/program', { headers: { cookie } })).json();
    expect(empty.program).toBeNull(); expect(empty.days).toBe(28); expect(empty.topics.some((t: any) => t.id === 'mixed')).toBe(true);
    const g: any = await (await post('/program/generate', {}, cookie)).json();
    expect(g.ok).toBe(true); expect(g.program.totalDays).toBe(28); expect(g.program.days[0].today).toBe(true);
    const got: any = await (await call('/program', { headers: { cookie } })).json();
    expect(got.program.generatedAt).toBe(g.program.generatedAt);
    const [a, b] = got.program.days.filter((d: any) => d.format === 'lesson');
    const s: any = await (await post('/program/swap', { a: a.id, b: b.id }, cookie)).json();
    expect(s.program.days.find((d: any) => d.id === a.id).topic).toBe(b.topic);
    const bad = await post('/program/swap', { a: a.id, b: a.id }, cookie);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'program_invalid', reason: 'same' });
  });
});
