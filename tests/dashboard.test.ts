import { describe, it, expect } from 'vitest';
import {
  weekStart, computeStreak, lessonMinutes, weeklyGoal, parseGoal, readinessAt, forecast, weekPlan, dashboard, d1DashboardStore,
  GAIN_PER_LESSON, MISS_PENALTY, MISS_CAP, STEP_CAP_MINUTES, GOAL_DAYS_DEFAULT, GOAL_MIN, GOAL_MAX, type ReadinessInput,
} from '../functions/_lib/dashboard';
import type { Assessment } from '../functions/_lib/assessment';
import { BONUS_MULTIPLIER, type Lesson, type LessonStep } from '../functions/_lib/lesson';
import type { ProgramDay } from '../functions/_lib/program';
import type { Profile } from '../functions/_lib/profile';
import { d1ProfileStore } from '../functions/_lib/profile';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { freshDb, d1Of } from './helpers/sqliteD1';

const USER = 'u1';
const TZ = 'Asia/Almaty';
const NOW = '2026-11-12T03:00:00.000Z'; // четверг 12 ноября 2026 в Алматы
const TODAY = '2026-11-12';
let seq = 0;

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  id: 'a1', userId: USER, kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level: 'B1', currentLevel: 'B1',
  updatedAt: NOW, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: NOW, scoringNote: null, adaptiveCount: 12, programDayId: null, ...over,
});
const lesson = (dayDate: string, score: number | null, status: Lesson['status'] = 'finished', bonus: Lesson['bonus'] = null): Lesson => ({
  id: `l${++seq}`, userId: USER, programDayId: null, dayDate, topic: 'articles', writing: 'review', level: 'B1', status, warmupCount: 5, reviewCount: 0, score,
  startedAt: `${dayDate}T02:00:00.000Z`, finishedAt: status === 'finished' ? `${dayDate}T02:20:00.000Z` : null, updatedAt: null, bonus,
});
const day = (dayDate: string, over: Partial<ProgramDay> = {}): ProgramDay => ({
  id: `d${++seq}`, userId: USER, dayDate, position: 1, week: 1, format: 'lesson', topic: 'articles', writing: 'review', reason: 'r', status: 'planned', minutes: 25, score: null, completedAt: null, generatedAt: NOW, updatedAt: null, ...over,
});
const step = (createdAt: string, answeredAt: string | null, lessonId = 'l'): LessonStep => ({
  id: `s${++seq}`, lessonId, userId: USER, position: seq, part: 'warmup', itemId: null, cardId: null, level: null, answer: null, correct: null, score: null, feedback: null, detail: null, createdAt, answeredAt,
});
const profile = (over: Partial<Profile> = {}): Profile => ({
  userId: USER, specialty: 'инженер', industry: 'энергетика', years: 15, targetRole: 'OpenTrain AI', keywords: [], summary: null, resumeText: null, resumeName: null, resumeAt: null,
  interviewDate: null, interviewFormat: 'ai', minutesPerDay: 25, nativeLanguage: 'русский', onboardedAt: NOW, targetLevel: 'C1', weeklyGoalMinutes: null, updatedAt: NOW, ...over,
});
const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({ assessment: assessment(), lessons: [], missed: [], today: TODAY, tz: TZ, ...over });

describe('календарь недели', () => {
  it('понедельник недели для любого дня, включая воскресенье и сам понедельник', () => {
    expect(weekStart('2026-11-12')).toBe('2026-11-09');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(weekStart('2026-11-15')).toBe('2026-11-09');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
  });
});

describe('серия с заморозкой', () => {
  const req = (...d: string[]) => new Set(d);
  it('пусто — нули; дни подряд считаются до сегодня, сегодня без занятия серию не рвёт', () => {
    expect(computeStreak(new Set(), new Set(), TODAY)).toMatchObject({ current: 0, best: 0, todayDone: false, freezeAvailable: true, frozen: [], missed: [] });
    const s = computeStreak(new Set(['2026-11-09', '2026-11-10', '2026-11-11']), req('2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'), TODAY);
    expect(s).toMatchObject({ current: 3, best: 3, todayDone: false, lastDone: '2026-11-11', freezeAvailable: true });
  });
  it('первая дыра в неделе закрывается заморозкой, вторая рвёт серию; заморозка недели потрачена', () => {
    const done = new Set(['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-09', '2026-11-11']);
    const required = req('2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12');
    const s = computeStreak(done, required, TODAY);
    // 4.11 — заморозка (неделя 2–8), 6.11 — пропуск: серия 3 рвётся; 10.11 — заморозка недели 9–15, 11.11 продолжает
    expect(s.frozen).toEqual(['2026-11-04', '2026-11-10']);
    expect(s.missed).toEqual(['2026-11-06']);
    expect(s.best).toBe(3);
    expect(s.current).toBe(2);
    expect(s.freezeAvailable).toBe(false);
  });
  it('дни без занятия в программе (репетиция, срез, нет программы) серию не трогают; сегодня пройдено — в серии', () => {
    const s = computeStreak(new Set(['2026-11-06', '2026-11-09', TODAY]), req('2026-11-06', '2026-11-09', TODAY), TODAY);
    expect(s).toMatchObject({ current: 3, best: 3, todayDone: true, frozen: [], missed: [] });
  });
  it('даты после сегодня не учитываются', () => {
    const s = computeStreak(new Set([TODAY]), req(TODAY, '2026-11-13', '2026-11-14'), TODAY);
    expect(s).toMatchObject({ current: 1, missed: [], frozen: [] });
  });
});

describe('минуты и недельная цель', () => {
  it('минуты занятия: от выдачи шага до ответа, пауза дольше предела не считается, шаг без ответа не считается', () => {
    const steps = [
      step('2026-11-12T02:00:00Z', '2026-11-12T02:03:30Z'),
      step('2026-11-12T02:03:30Z', '2026-11-12T04:00:00Z'), // пауза — только STEP_CAP_MINUTES
      step('2026-11-12T04:00:00Z', '2026-11-12T04:02:00Z'),
      step('2026-11-12T04:02:00Z', null),
    ];
    expect(lessonMinutes(steps)).toBe(Math.round(3.5 + STEP_CAP_MINUTES + 2));
    expect(lessonMinutes([])).toBe(0);
  });
  it('цель: своя из профиля, иначе минуты в день × дни; без профиля — 20 × дни', () => {
    expect(weeklyGoal(profile())).toEqual({ minutes: 25 * GOAL_DAYS_DEFAULT, custom: false });
    expect(weeklyGoal(profile({ weeklyGoalMinutes: 90 }))).toEqual({ minutes: 90, custom: true });
    expect(weeklyGoal(null)).toEqual({ minutes: 20 * GOAL_DAYS_DEFAULT, custom: false });
  });
  it('разбор цели: целое в пределах, строка с числом, null — сброс, иначе отказ с причиной', () => {
    expect(parseGoal(120)).toEqual({ ok: true, minutes: 120 });
    expect(parseGoal('150')).toEqual({ ok: true, minutes: 150 });
    expect(parseGoal(null)).toEqual({ ok: true, minutes: null });
    expect(parseGoal('')).toEqual({ ok: true, minutes: null });
    expect(parseGoal(GOAL_MIN - 1)).toEqual({ ok: false, reason: 'range' });
    expect(parseGoal(GOAL_MAX + 1)).toEqual({ ok: false, reason: 'range' });
    expect(parseGoal(12.5)).toEqual({ ok: false, reason: 'format' });
    expect(parseGoal('много')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('готовность', () => {
  it('без среза — null; база — сводный балл среза, уровень по баллу', () => {
    expect(readinessAt(input({ assessment: null }), TODAY)).toMatchObject({ value: null, base: null, level: null, lessons: 0 });
    expect(readinessAt(input(), TODAY)).toMatchObject({ value: 53, base: 53, baseKind: 'baseline', baseDate: '2026-10-29', level: 'B1', gained: 0, lost: 0 });
  });
  it('занятия после среза прибавляют пропорционально баллу, занятия до среза и незавершённые — нет', () => {
    const lessons = [lesson('2026-10-28', 100), lesson('2026-11-02', 100), lesson('2026-11-03', 50), lesson('2026-11-04', 80, 'active'), lesson('2026-11-05', null)];
    const r = readinessAt(input({ lessons }), TODAY);
    expect(r.lessons).toBe(2);
    expect(r.gained).toBe(GAIN_PER_LESSON * 1.5);
    expect(r.value).toBe(Math.round(53 + GAIN_PER_LESSON * 1.5));
  });
  it('верно решённый бонус удваивает вклад занятия; отклонённый или неверный — нет', () => {
    const lessons = [lesson('2026-11-02', 100, 'finished', 'correct'), lesson('2026-11-03', 50, 'finished', 'wrong'), lesson('2026-11-04', 100, 'finished', 'declined'), lesson('2026-11-05', 50, 'finished', 'offered')];
    const r = readinessAt(input({ lessons }), TODAY);
    expect(r).toMatchObject({ lessons: 4, bonuses: 1, gained: GAIN_PER_LESSON * (BONUS_MULTIPLIER + 0.5 + 1 + 0.5) });
    expect(r.value).toBe(Math.round(53 + GAIN_PER_LESSON * (BONUS_MULTIPLIER + 2)));
  });
  it('пропуски отнимают по MISS_PENALTY, но не больше MISS_CAP; дата отсечки — по дню', () => {
    const missed = ['2026-10-28', ...Array.from({ length: 15 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)];
    const r = readinessAt(input({ missed }), TODAY);
    expect(r.missed).toBe(12);
    expect(r.lost).toBe(Math.min(MISS_CAP, 12 * MISS_PENALTY));
    expect(r.value).toBe(53 - Math.min(MISS_CAP, 12 * MISS_PENALTY));
    expect(readinessAt(input({ missed }), '2026-11-03').missed).toBe(3);
  });
  it('держится в 0–100 и меняет уровень по порогу', () => {
    const lessons = Array.from({ length: 30 }, (_, i) => lesson(`2026-11-${String((i % 11) + 1).padStart(2, '0')}`, 100));
    const r = readinessAt(input({ assessment: assessment({ overall: 58 }), lessons }), TODAY);
    expect(r.value).toBe(100);
    expect(r.level).toBe('C1');
    expect(readinessAt(input({ assessment: assessment({ overall: 2 }), missed: ['2026-11-01', '2026-11-02', '2026-11-03'] }), TODAY).value).toBe(0);
  });
  it('прогноз: темп по разнице за окно, дни до следующей ступени и ожидание к собеседованию; нулевой темп — без дат', () => {
    const now = readinessAt(input({ lessons: [lesson('2026-11-09', 100), lesson('2026-11-10', 100), lesson('2026-11-11', 75)] }), TODAY);
    const before = readinessAt(input(), '2026-11-05');
    const f = forecast(now, before, 20, 'C1');
    expect(now.value).toBe(59); // 53 + 2 + 2 + 1.5
    expect(f.perDay).toBe(0.9); // 6 за 7 дней, с округлением до десятых
    expect(f.next).toEqual({ level: 'B2', points: 1, days: 2 });
    expect(f.atInterview).toBe(Math.round(59 + 0.9 * 20));
    expect(f.target).toEqual({ level: 'C1', points: 85, reached: false });
    const flat = forecast(readinessAt(input(), TODAY), readinessAt(input(), '2026-11-05'), null, 'B2');
    expect(flat.perDay).toBe(0);
    expect(flat.next).toEqual({ level: 'B2', points: 7, days: null });
    expect(flat.atInterview).toBeNull();
    expect(flat.target).toEqual({ level: 'B2', points: 60, reached: false });
    expect(forecast(readinessAt(input({ assessment: null }), TODAY), readinessAt(input({ assessment: null }), TODAY), 5, 'C1')).toMatchObject({ perDay: 0, next: null, atInterview: null });
  });
});

describe('план недели', () => {
  it('семь дней с понедельника: пройдено, идёт, сегодня, план, заморожено, репетиция и срез — план, свободно', () => {
    const days = [day('2026-11-09'), day('2026-11-10'), day('2026-11-11'), day('2026-11-12'), day('2026-11-13'), day('2026-11-14', { format: 'rehearsal', topic: 'task-response', writing: null }), day('2026-11-15', { format: 'checkpoint', topic: 'mixed', writing: null })];
    const lessons = [{ dayDate: '2026-11-09', status: 'finished' as const, score: 80, minutes: 22 }, { dayDate: '2026-11-11', status: 'active' as const, score: null, minutes: 7 }];
    const streak = computeStreak(new Set(['2026-11-09']), new Set(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']), TODAY);
    const w = weekPlan(days, lessons, streak, TODAY);
    expect(w.map(d => d.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(w.map(d => d.weekday)).toEqual(['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']);
    // репетиция (4.1) и срез (4.3) — обычные дни плана
    expect(w.map(d => d.status)).toEqual(['done', 'frozen', 'active', 'today', 'planned', 'planned', 'planned']);
    expect(w[0]).toMatchObject({ minutes: 22, score: 80, past: true, today: false });
    expect(w[2]).toMatchObject({ minutes: 7, score: null });
    expect(w[3]).toMatchObject({ today: true, past: false });
    expect(w[5].day?.formatLabel).toBe('репетиция интервью');
    const free = weekPlan([], [], computeStreak(new Set(), new Set(), TODAY), TODAY);
    expect(free.every(d => d.status === 'free' && d.day === null)).toBe(true);
  });
  it('день программы done без записи занятия — пройдено; вторая дыра недели — пропущено', () => {
    const days = [day('2026-11-09', { status: 'done', score: 70 }), day('2026-11-10'), day('2026-11-11'), day('2026-11-12')];
    const streak = computeStreak(new Set(['2026-11-09']), new Set(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']), TODAY);
    const w = weekPlan(days, [], streak, TODAY);
    expect(w.slice(0, 4).map(d => d.status)).toEqual(['done', 'frozen', 'missed', 'today']);
    expect(w[0].score).toBe(70);
  });
});

describe('сборка главного экрана', () => {
  function seed() {
    const mem = memoryStore();
    mem.assessments.push(assessment());
    mem.profiles.set(USER, profile({ interviewDate: '2026-12-02' }));
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) mem.programDays.push(day(d));
    mem.programDays.push(day('2026-11-07', { format: 'lesson', topic: 'mixed' }), day('2026-11-08', { format: 'rehearsal', topic: 'task-response', writing: null }), day('2026-11-14', { format: 'lesson', topic: 'mixed' }), day('2026-11-15', { format: 'checkpoint', topic: 'mixed', writing: null }));
    for (const [d, s] of [['2026-11-02', 100], ['2026-11-03', 80], ['2026-11-05', 60], ['2026-11-06', 50], ['2026-11-09', 90], ['2026-11-10', 100], ['2026-11-11', 70]] as [string, number][]) {
      const l = lesson(d, s); mem.lessons.push(l);
      mem.steps.push(step(`${d}T02:00:00Z`, `${d}T02:08:00Z`, l.id), step(`${d}T02:08:00Z`, `${d}T02:14:00Z`, l.id));
    }
    return mem;
  }
  it('собирает готовность с прогнозом, отсчёт, серию, цель и неделю из занятий и программы', async () => {
    const mem = seed();
    const v = await dashboard(mem.store, USER, TZ, mem.profiles.get(USER)!, { now: () => NOW });
    expect(v.today).toBe(TODAY);
    // 4.11 — заморозка недели 2–8 (серия 2–6 = 4), 7.11 рвёт серию; 9–11.11 — серия 3
    expect(v.streak).toMatchObject({ current: 3, best: 4, todayDone: false, freezeAvailable: true, frozen: ['2026-11-04'], missed: ['2026-11-07'], lastDone: '2026-11-11' });
    // 53 + 2·(1 + .8 + .6 + .5 + .9 + 1 + .7) − 1 = 53 + 11 − 1 = 63
    expect(v.readiness).toMatchObject({ value: 63, base: 53, gained: 11, lost: 1, lessons: 7, missed: 1, level: 'B2' });
    expect(v.readiness.forecast.perDay).toBeGreaterThan(0);
    expect(v.readiness.forecast.target).toEqual({ level: 'C1', points: 85, reached: false });
    expect(v.countdown).toEqual({ interviewDate: '2026-12-02', daysLeft: 20 });
    expect(v.readiness.forecast.atInterview).toBe(Math.round(63 + v.readiness.forecast.perDay * 20));
    expect(v.goal).toEqual({ minutes: 125, custom: false, done: 42, left: 83, default: 125, percent: 34 });
    expect(v.week.map(d => d.status)).toEqual(['done', 'done', 'done', 'today', 'planned', 'planned', 'planned']);
    expect(v.week.map(d => d.minutes)).toEqual([14, 14, 14, 0, 0, 0, 0]);
    expect(v.program).toEqual({ exists: true, endDate: '2026-11-15', done: 0, total: 14 });
  });
  it('без программы и среза — пустые значения, цель по умолчанию, неделя свободна', async () => {
    const mem = memoryStore();
    const v = await dashboard(mem.store, USER, TZ, null, { now: () => NOW });
    expect(v.readiness.value).toBeNull();
    expect(v.streak.current).toBe(0);
    expect(v.goal).toMatchObject({ minutes: 100, custom: false, done: 0, percent: 0 });
    expect(v.week.every(d => d.status === 'free')).toBe(true);
    expect(v.program).toEqual({ exists: false, endDate: null, done: 0, total: 0 });
    expect(v.countdown).toEqual({ interviewDate: null, daysLeft: null });
  });
  it('API: GET /api/dashboard и PUT /api/dashboard/goal с проверкой; без cookie — 401', async () => {
    const mem = seed();
    const env = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    expect((await call('/dashboard')).status).toBe(401);
    expect((await call('/dashboard/goal', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"minutes":100}' })).status).toBe(401);
    const r1 = await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com' }) });
    const { code } = await r1.json() as any;
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com', code }) });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const uid = mem.users[0].id;
    // переносим данные на созданного пользователя
    mem.profiles.set(uid, { ...mem.profiles.get(USER)!, userId: uid });
    for (const x of [...mem.assessments, ...mem.lessons, ...mem.programDays]) x.userId = uid;
    const g = await call('/dashboard', { headers: { cookie } });
    expect(g.status).toBe(200);
    const j: any = await g.json();
    expect(j.ok).toBe(true);
    // API берёт настоящее «сегодня» — занятия ноября ещё впереди, поэтому готовность равна базе среза
    expect(j.readiness).toMatchObject({ base: 53, baseKind: 'baseline' });
    expect(j.goal).toMatchObject({ minutes: 125, custom: false });
    expect(j.countdown.interviewDate).toBe('2026-12-02');
    expect(j.gainPerLesson).toBe(GAIN_PER_LESSON);
    expect(j.week).toHaveLength(7);
    const bad = await call('/dashboard/goal', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 5 }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'goal_invalid', reason: 'range' });
    const ok = await call('/dashboard/goal', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 60 }) });
    expect(ok.status).toBe(200);
    const k: any = await ok.json();
    expect(k.goal).toMatchObject({ minutes: 60, custom: true });
    expect(mem.profiles.get(uid)!.weeklyGoalMinutes).toBe(60);
    const reset = await call('/dashboard/goal', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ minutes: null }) });
    expect(((await reset.json()) as any).goal).toMatchObject({ minutes: 125, custom: false });
  });
  it('D1: миграция 0012 — цель пишется и читается профилем, сброс в NULL', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'y@example.com')`);
    const d1 = d1Of(db);
    const store = d1DashboardStore(d1), profiles = d1ProfileStore(d1);
    await store.saveWeeklyGoal(USER, 90, NOW);
    expect((await profiles.getProfile(USER))?.weeklyGoalMinutes).toBe(90);
    db.exec(`UPDATE profiles SET target_level = 'C1', minutes_per_day = 25 WHERE user_id = '${USER}'`);
    const p = await profiles.getProfile(USER);
    expect(p?.targetLevel).toBe('C1');
    expect(weeklyGoal(p)).toEqual({ minutes: 90, custom: true });
    await store.saveWeeklyGoal(USER, null, NOW);
    expect((await profiles.getProfile(USER))?.weeklyGoalMinutes).toBeNull();
    expect(weeklyGoal(await profiles.getProfile(USER))).toEqual({ minutes: 125, custom: false });
  });
});
