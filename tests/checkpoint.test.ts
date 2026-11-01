import { describe, it, expect } from 'vitest';
import {
  kindAt, planFor, compare, estimateLevel, startOrResume as startAssessment, current as currentAssessment, abandon as abandonAssessment,
  CHECKPOINT_ADAPTIVE, CHECKPOINT_TOTAL, ADAPTIVE_COUNT, TOTAL, SIGNIFICANT_DELTA, type Assessment,
} from '../functions/_lib/assessment';
import { today as checkpointToday, startOrResume, answer, rescore, abandon } from '../functions/_lib/checkpoint';
import { dashboard } from '../functions/_lib/dashboard';
import { LEVELS, TOPICS, type Item, type Kind, type Level } from '../functions/_lib/items';
import type { ProgramDay } from '../functions/_lib/program';
import type { Profile } from '../functions/_lib/profile';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
const USER = 'u1';
const TZ = 'Asia/Almaty';
const NOW = '2026-11-13T05:00:00.000Z'; // пятница 13 ноября 2026 в Алматы — 14-й день программы с 31 октября, срез по плану
const TODAY = '2026-11-13';
const DOMAIN = { specialty: null, industry: null, targetRole: null, keywords: [] };
let seq = 0;
const nextId = () => `id${++seq}`;
const rng = () => 0;

const SHORT = Array.from({ length: 8 }, () => 'The boiler efficiency test shows a small loss.').join(' '); // 64 слова
const PASSAGE = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} of the report says the boiler efficiency fell after the retrofit.`).join(' ');

function makeItem(kind: Kind, level: Level, topic = TOPICS[seq % TOPICS.length].id): Item {
  const n = ++seq;
  const base = { id: `it${n}`, kind, level, topic, domain: null, rubric: null, explanation: 'правило одной строкой', status: 'verified' as const, checkNote: null, checkedLevel: null, fingerprint: `fp${n}`, source: 'test', createdAt: `2026-10-30T00:00:${String(n % 60).padStart(2, '0')}Z`, verifiedAt: null, writingFormat: null };
  if (kind === 'mcq') return { ...base, prompt: `We finished ___ energy audit number ${n} last week.`, options: ['a', 'an', 'the', '—'], answer: 'C' };
  if (kind === 'correction') return { ...base, prompt: `The turbine have been inspected ${n} times since the overhaul.`, options: null, answer: `The turbine has been inspected ${n} times since the overhaul.` };
  if (kind === 'reading') return { ...base, prompt: PASSAGE, options: [
    { question: 'What does the report mainly say?', options: ['Efficiency rose', 'Efficiency fell', 'Nothing changed', 'The boiler was replaced'], answer: 'B' },
    { question: 'What does the author imply about the retrofit?', options: ['It succeeded', 'It was free', 'It did not help', 'It was postponed'], answer: 'C' },
  ], answer: 'B,C' };
  return { ...base, prompt: `Write a short reply to a reviewer about calculation ${n} in 60–80 words.`, options: null, rubric: ['Отвечает прямо'], answer: SHORT };
}
function fillBank(items: Item[]) {
  for (const l of LEVELS) {
    for (let i = 0; i < 4; i++) { items.push(makeItem('mcq', l)); items.push(makeItem('correction', l)); }
    items.push(makeItem('reading', l)); items.push(makeItem('reading', l)); items.push(makeItem('writing', l)); items.push(makeItem('writing', l));
  }
}

const profile = (over: Partial<Profile> = {}): Profile => ({
  userId: USER, specialty: null, industry: null, years: null, targetRole: 'OpenTrain AI', keywords: [], summary: null, resumeText: null, resumeName: null, resumeAt: null,
  interviewDate: null, interviewFormat: null, minutesPerDay: 25, nativeLanguage: 'русский', onboardedAt: NOW, targetLevel: 'C1', weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: NOW, ...over,
});
const baseline = (over: Partial<Assessment> = {}): Assessment => ({
  id: 'a-base', userId: USER, kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level: 'B1', currentLevel: 'B1',
  updatedAt: NOW, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: NOW, scoringNote: 'срез вне приложения', adaptiveCount: 12, programDayId: null, ...over,
});
const day = (over: Partial<ProgramDay> = {}): ProgramDay => ({
  id: `d${++seq}`, userId: USER, dayDate: TODAY, position: 14, week: 2, format: 'checkpoint', topic: 'mixed', writing: null, reason: 'укороченный тест, сравнение с исходным срезом от 29 октября 2026', status: 'planned', minutes: 15, score: null, completedAt: null, generatedAt: '2026-10-31T04:00:00.000Z', updatedAt: null, ...over,
});
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Программа 31.10–27.11: срез сегодня (14-й день), занятия до и после. */
function seedProgram(days: ProgramDay[]) {
  for (let p = 1; p <= 28; p++) {
    const date = addDays('2026-10-31', p - 1);
    if (p === 14 || p === 28) { days.push(day({ dayDate: date, position: p, week: Math.ceil(p / 7) })); continue; }
    days.push(day({ dayDate: date, position: p, week: Math.ceil(p / 7), format: 'lesson', topic: p % 2 ? 'articles' : 'tenses', writing: 'review', reason: 'тема', status: date < TODAY ? 'done' : 'planned', score: date < TODAY ? 70 : null, minutes: 25 }));
  }
}

const opts = () => ({ rng, id: nextId, now: () => NOW, generate: false });

describe('план среза и сравнение', () => {
  it('срез короче: восемь адаптивных (исправление на 3 и 6), чтение, письмо — десять шагов; тест уровня как был', () => {
    expect(planFor('checkpoint')).toEqual({ adaptive: CHECKPOINT_ADAPTIVE, total: CHECKPOINT_TOTAL });
    expect(planFor('placement')).toEqual({ adaptive: ADAPTIVE_COUNT, total: TOTAL });
    const kinds = Array.from({ length: CHECKPOINT_TOTAL }, (_, i) => kindAt(i + 1, CHECKPOINT_ADAPTIVE));
    expect(kinds).toEqual(['mcq', 'mcq', 'correction', 'mcq', 'mcq', 'correction', 'mcq', 'mcq', 'reading', 'writing']);
    // предварительный уровень по восьми заданиям: чтение на позиции 9 не считается
    const list = Array.from({ length: 8 }, (_, i) => ({ position: i + 1, level: 'B2' as Level, correct: 1 }));
    expect(estimateLevel([...list, { position: 9, level: 'C1', correct: 1 }], CHECKPOINT_ADAPTIVE)).toBe('B2');
  });

  it('сравнение: уровень вырос / тот же (с ростом балла, в погрешности, с просадкой) / снизился; оси ±SIGNIFICANT_DELTA', () => {
    const prev = baseline();
    const up = compare({ level: 'B2', overall: 62, axes: { grammar: 70, vocabulary: 55, coherence: 60, taskResponse: 44, fluency: null } }, prev)!;
    expect(up.level).toEqual({ before: 'B1', after: 'B2', change: 'up' });
    expect(up.overall).toEqual({ before: 53, after: 62, delta: 9 });
    expect(up.verdict).toMatch(/^Уровень вырос: B1 → B2, сводный балл \+9 к исходному срезу от 29 октября 2026 \(/);
    expect(up.improved).toEqual(['grammar', 'vocabulary', 'coherence']);
    expect(up.declined).toEqual(['taskResponse']);
    expect(up.axes.find(a => a.id === 'fluency')).toMatchObject({ before: null, after: null, delta: null });
    expect(up.previous).toMatchObject({ id: 'a-base', kind: 'baseline', kindLabel: 'исходный срез', level: 'B1', overall: 53 });

    const sameUp = compare({ level: 'B1', overall: 58, axes: prev.axes }, prev)!;
    expect(sameUp.level.change).toBe('same');
    expect(sameUp.verdict).toContain('Уровень тот же — B1, но сводный балл вырос на 5');
    expect(sameUp.verdict).toContain('до B2 осталось 2');

    const noise = compare({ level: 'B1', overall: 53 + SIGNIFICANT_DELTA - 1, axes: prev.axes }, prev)!;
    expect(noise.verdict).toContain('в пределах погрешности');
    expect(noise.improved).toEqual([]);

    const sameDown = compare({ level: 'B1', overall: 46, axes: prev.axes }, prev)!;
    expect(sameDown.verdict).toContain('снизился на 7');

    const down = compare({ level: 'A2', overall: 30, axes: prev.axes }, prev)!;
    expect(down.level.change).toBe('down');
    expect(down.verdict).toMatch(/^Уровень снизился: B1 → A2/);
    expect(compare({ level: null, overall: null, axes: null }, prev)).toBeNull();
  });
});

describe('ход среза', () => {
  it('по плану: старт с уровня последнего теста, 10 шагов, день программы → done с баллом, сравнение и пересборка программы', async () => {
    const mem = memoryStore(); fillBank(mem.items);
    mem.assessments.push(baseline({ level: 'B2' }));
    seedProgram(mem.programDays);
    mem.profiles.set(USER, profile());
    const o = opts();

    const t0 = await checkpointToday(mem.store, USER, TZ, o);
    expect(t0.today).toBe(TODAY); expect(t0.scheduled).toBe(true); expect(t0.day?.position).toBe(14); expect(t0.next?.position).toBe(28); expect(t0.checkpoint).toBeNull();

    let v = await startOrResume(ENV, mem.store, USER, TZ, profile(), o);
    expect(v.kind).toBe('checkpoint'); expect(v.status).toBe('active'); expect(v.total).toBe(10);
    expect(v.day?.position).toBe(14); expect(v.programDayId).toBe(t0.day!.id);
    expect(mem.assessments[1]).toMatchObject({ kind: 'checkpoint', currentLevel: 'B2', adaptiveCount: 8, programDayId: t0.day!.id });
    expect(mem.attempts[0].level).toBe('B2');
    // повторный старт — тот же срез
    expect((await startOrResume(ENV, mem.store, USER, TZ, profile(), o)).id).toBe(v.id);
    // карточка «Тест уровня» срез не видит: там исходный срез
    expect((await currentAssessment(mem.store, USER))?.kind).toBe('baseline');
    // тест уровня, пока идёт срез, не начать
    await expect(startAssessment(ENV, mem.store, USER, DOMAIN, o)).rejects.toMatchObject({ code: 'assessment_busy', reason: 'checkpoint' });

    const key = (attId: string) => { const t = mem.attempts.find(x => x.id === attId)!; return mem.items.find(i => i.id === t.itemId)!; };
    const oldPlanned = mem.programDays.filter(d => d.status === 'planned' && d.dayDate > TODAY).map(d => d.id);
    expect(oldPlanned.length).toBe(14);
    while (v.status === 'active') {
      const cur = v.current!;
      const ans = cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? SHORT : key(cur.attemptId).answer;
      v = await answer(ENV, mem.store, USER, cur.attemptId, ans, TZ, profile(), o);
      if (v.status === 'active') expect(v.programAdjusted).toBe(false);
    }
    expect(v.answered).toBe(10); expect(v.level).toBe('C1');
    expect(v.summary).toEqual({ adaptiveTotal: 8, adaptiveCorrect: 8, readingScore: 100, writingWords: 64 });
    expect(v.result).not.toBeNull(); expect(v.result!.scoringNote).toMatch(/письмо не оценено/); // модель вернула {}
    expect(v.comparison).not.toBeNull();
    expect(v.comparison!.previous.id).toBe('a-base'); expect(v.comparison!.level.change).toBe('up');
    expect(v.comparison!.verdict).toMatch(/^Уровень вырос: B2 → C1/);
    // день программы пройден с сводным баллом
    const d = mem.programDays.find(x => x.id === t0.day!.id)!;
    expect(d.status).toBe('done'); expect(d.score).toBe(v.result!.overall); expect(d.completedAt).toBe(NOW);
    expect(v.day?.status).toBe('done');
    // программа пересобрана: planned-дни после сегодня заменены, пройденные и сегодняшний остались
    expect(v.programAdjusted).toBe(true);
    const planned = mem.programDays.filter(x => x.status === 'planned' && x.dayDate > TODAY);
    expect(planned.length).toBe(14);
    expect(planned.every(x => !oldPlanned.includes(x.id))).toBe(true);
    expect(planned.every(x => x.generatedAt === NOW)).toBe(true);
    expect(mem.programDays.filter(x => x.status === 'done')).toHaveLength(13 + 1);
    const cp28 = planned.find(x => x.position === 28)!;
    expect(cp28.format).toBe('checkpoint'); expect(cp28.reason).toContain('сравнение с контрольным срезом от 13 ноября 2026');

    // сегодня: срез пройден, следующий — 28-й день; готовность — от нового среза, день в серии
    const t1 = await checkpointToday(mem.store, USER, TZ, o);
    expect(t1.checkpoint?.status).toBe('finished'); expect(t1.checkpoint?.comparison?.level.change).toBe('up'); expect(t1.next?.position).toBe(28);
    const dash = await dashboard(mem.store, USER, TZ, profile(), { now: () => NOW });
    expect(dash.readiness.baseKind).toBe('checkpoint'); expect(dash.readiness.base).toBe(v.result!.overall); expect(dash.readiness.baseDate).toBe(TODAY);
    expect(dash.streak.todayDone).toBe(true);
    expect(dash.week.find(w => w.today)).toMatchObject({ status: 'done', score: v.result!.overall });

    // пересчёт без force ничего не меняет и программу второй раз не трогает
    const r = await rescore(ENV, mem.store, USER, TZ, profile(), false, o);
    expect(r.id).toBe(v.id); expect(r.programAdjusted).toBe(false);
    expect(mem.programDays.filter(x => x.status === 'planned' && x.dayDate > TODAY).map(x => x.id)).toEqual(planned.map(x => x.id)); // не пересобрано: ids те же
  });

  it('вне плана: без дня программы, программа не трогается; abandon закрывает срез, следующий start — новый', async () => {
    const mem = memoryStore(); fillBank(mem.items);
    mem.assessments.push(baseline());
    const o = { ...opts(), now: () => '2026-11-10T05:00:00.000Z' }; // вторник — занятие по плану
    seedProgram(mem.programDays);
    const t0 = await checkpointToday(mem.store, USER, TZ, o);
    expect(t0.scheduled).toBe(false); expect(t0.day).toBeNull(); expect(t0.next?.position).toBe(14);
    let v = await startOrResume(ENV, mem.store, USER, TZ, null, o);
    expect(v.day).toBeNull(); expect(v.programDayId).toBeNull();
    expect(mem.attempts[0].level).toBe('B1'); // уровень исходного среза
    expect(await abandon(mem.store, USER, o)).toBe(true);
    expect(await abandon(mem.store, USER, o)).toBe(false);
    expect((await checkpointToday(mem.store, USER, TZ, o)).checkpoint).toBeNull();
    const before = mem.programDays.map(d => d.id);
    v = await startOrResume(ENV, mem.store, USER, TZ, null, o);
    const key = (attId: string) => { const t = mem.attempts.find(x => x.id === attId)!; return mem.items.find(i => i.id === t.itemId)!; };
    while (v.status === 'active') {
      const cur = v.current!;
      v = await answer(ENV, mem.store, USER, cur.attemptId, cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? SHORT : key(cur.attemptId).answer, TZ, null, o);
    }
    expect(v.status).toBe('finished'); expect(v.programAdjusted).toBe(false);
    expect(mem.programDays.map(d => d.id)).toEqual(before);
    expect(mem.programDays.filter(d => d.format === 'checkpoint' && d.status === 'done')).toHaveLength(0);
    expect(v.comparison?.previous.kind).toBe('baseline');
  });

  it('без прошлого теста сравнения нет; активный тест уровня блокирует срез, а срез не прерывает тест', async () => {
    const mem = memoryStore(); fillBank(mem.items);
    const o = opts();
    const t = await startAssessment(ENV, mem.store, USER, DOMAIN, o);
    expect(t.kind).toBe('placement');
    await expect(startOrResume(ENV, mem.store, USER, TZ, null, o)).rejects.toMatchObject({ code: 'assessment_busy', reason: 'placement' });
    expect(await abandon(mem.store, USER, o)).toBe(false); // срезов нет — тест уровня не трогаем
    expect(await abandonAssessment(mem.store, USER, o)).toBe(true);
    let v = await startOrResume(ENV, mem.store, USER, TZ, null, o);
    expect(mem.attempts.filter(a => a.assessmentId === v.id)[0].level).toBe('B1'); // стартовый уровень без истории
    const key = (attId: string) => { const t = mem.attempts.find(x => x.id === attId)!; return mem.items.find(i => i.id === t.itemId)!; };
    while (v.status === 'active') {
      const cur = v.current!;
      v = await answer(ENV, mem.store, USER, cur.attemptId, cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? SHORT : key(cur.attemptId).answer, TZ, null, o);
    }
    expect(v.comparison).toBeNull();
  });
});

describe('местная дата ученика', () => {
  it('срез в 00:30 по Алматы (19:30 UTC накануне): «пройден сегодня» и срок карточек от местной даты, а не от UTC', async () => {
    const mem = memoryStore(); fillBank(mem.items);
    mem.assessments.push(baseline());
    const FINISH = '2026-11-12T19:30:00.000Z'; // 13 ноября 00:30 в Алматы, по UTC ещё 12-е
    const o = { ...opts(), now: () => FINISH };
    let v = await startOrResume(ENV, mem.store, USER, TZ, null, o);
    const key = (attId: string) => { const t = mem.attempts.find(x => x.id === attId)!; return mem.items.find(i => i.id === t.itemId)!; };
    let first = true;
    while (v.status === 'active') {
      const cur = v.current!;
      const right = cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? SHORT : key(cur.attemptId).answer;
      const wrong = cur.kind === 'mcq' ? (right === 'A' ? 'B' : 'A') : 'The turbine are broken.';
      v = await answer(ENV, mem.store, USER, cur.attemptId, first && (cur.kind === 'mcq' || cur.kind === 'correction') ? wrong : right, TZ, null, o);
      first = false;
    }
    expect(v.status).toBe('finished');
    expect(mem.cards.length).toBeGreaterThan(0);
    expect(mem.cards.every(c => c.due === addDays(TODAY, 1))).toBe(true); // завтра по Алматы — 14 ноября, а не 13-е от UTC
    const t = await checkpointToday(mem.store, USER, TZ, o);
    expect(t.today).toBe(TODAY);
    expect(t.finishedToday).toBe(true);
    expect((await checkpointToday(mem.store, USER, 'UTC', o)).finishedToday).toBe(true); // в UTC тоже «сегодня» — 12-е
    expect((await checkpointToday(mem.store, USER, TZ, { ...o, now: () => '2026-11-13T19:30:00.000Z' })).finishedToday).toBe(false); // местное 14-е
  });
});

describe('API среза', () => {
  async function login(prep: (mem: ReturnType<typeof memoryStore>) => void = () => {}) {
    const mem = memoryStore(); fillBank(mem.items); prep(mem);
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, ENV);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@x.kz' })).json();
    const r2 = await post('/auth/verify', { email: 'y@x.kz', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { mem, call: (p: string, init: RequestInit = {}) => call(p, { ...init, headers: { cookie, ...(init.headers as any) } }), post: (p: string, b: unknown) => post(p, b, { cookie }) };
  }

  it('без входа — 401 на всех маршрутах', async () => {
    const app = createApp('test', () => memoryStore().store);
    for (const [m, p] of [['GET', '/checkpoint'], ['POST', '/checkpoint/start'], ['POST', '/checkpoint/answer'], ['POST', '/checkpoint/score'], ['POST', '/checkpoint/abandon']]) {
      expect((await app.request(`https://offerly.test/api${p}`, { method: m }, ENV)).status).toBe(401);
    }
  });

  it('GET → start → answer ×10 → finished со сравнением; тест уровня в GET /api/assessment не меняется', async () => {
    const { mem, call, post } = await login();
    const me: any = await (await call('/me')).json();
    mem.assessments.push(baseline({ userId: me.user.id }));
    const g0: any = await (await call('/checkpoint')).json();
    expect(g0).toMatchObject({ ok: true, total: 10, adaptive: 8, significant: SIGNIFICANT_DELTA, scheduled: false, day: null, next: null, checkpoint: null });
    let r: any = await (await post('/checkpoint/start', {})).json();
    expect(r.ok).toBe(true); expect(r.checkpoint.kind).toBe('checkpoint'); expect(r.checkpoint.total).toBe(10); expect(r.checkpoint.current.position).toBe(1);
    expect(JSON.stringify(r.checkpoint)).not.toContain('"answer"');
    const stale = await post('/checkpoint/answer', { attemptId: 'x', answer: 'A' });
    expect(stale.status).toBe(409);
    const busy = await post('/assessment/start', {});
    expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({ error: 'assessment_busy', reason: 'checkpoint' });
    const a0: any = await (await call('/assessment')).json();
    expect(a0.assessment.kind).toBe('baseline');
    for (let i = 0; i < CHECKPOINT_TOTAL; i++) {
      const cur = r.checkpoint.current;
      const ans = cur.kind === 'mcq' ? 'C' : cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'correction' ? 'Wrong fix.' : SHORT;
      const res = await post('/checkpoint/answer', { attemptId: cur.attemptId, answer: ans });
      expect(res.status).toBe(200);
      r = await res.json();
    }
    expect(r.checkpoint.status).toBe('finished'); expect(r.checkpoint.comparison.previous.kind).toBe('baseline');
    expect(typeof r.checkpoint.comparison.verdict).toBe('string'); expect(r.checkpoint.programAdjusted).toBe(false);
    const g1: any = await (await call('/checkpoint')).json();
    expect(g1.checkpoint.id).toBe(r.checkpoint.id); expect(g1.checkpoint.status).toBe('finished');
    const sc = await post('/checkpoint/score', {});
    expect(sc.status).toBe(200);
    expect((await (await call('/assessment')).json() as any).assessment.kind).toBe('baseline');
    const dash: any = await (await call('/dashboard')).json();
    expect(dash.readiness.baseKind).toBe('checkpoint');
  });

  it('abandon: активный срез закрывается, повторный — false', async () => {
    const { post } = await login();
    await post('/checkpoint/start', {});
    expect(await (await post('/checkpoint/abandon', {})).json()).toEqual({ ok: true, abandoned: true });
    expect(await (await post('/checkpoint/abandon', {})).json()).toEqual({ ok: true, abandoned: false });
  });
});

describe('D1-хранилище теста (миграция 0016)', () => {
  it('create/update/active/latest по виду, previousFinished, adaptive_count и program_day_id ходят через SQL', async () => {
    const { freshDb, d1Of } = await import('./helpers/sqliteD1');
    const { d1AssessmentStore } = await import('../functions/_lib/assessment');
    const db = freshDb();
    db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'y@x.kz', '2026-10-29T00:00:00Z')").run();
    const store = d1AssessmentStore(d1Of(db));
    await store.createAssessment(baseline());
    const cp: Assessment = { ...baseline({ id: 'a-cp', kind: 'checkpoint', status: 'active', startedAt: NOW, finishedAt: null, level: null, axes: null, overall: null, scoredAt: null, scoringNote: null }), adaptiveCount: 8, programDayId: 'd14' };
    await store.createAssessment(cp);
    expect(await store.activeAssessment('u1', 'placement')).toBeNull();
    expect(await store.activeAssessment('u1', 'checkpoint')).toMatchObject({ id: 'a-cp', adaptiveCount: 8, programDayId: 'd14', currentLevel: 'B1' });
    expect((await store.activeAssessment('u1'))?.id).toBe('a-cp');
    expect((await store.latestAssessment('u1', 'baseline'))?.id).toBe('a-base');
    expect((await store.latestAssessment('u1'))?.id).toBe('a-cp');
    expect((await store.latestFinishedAssessment('u1'))?.id).toBe('a-base');
    await store.updateAssessment('a-cp', { status: 'finished', finishedAt: NOW, level: 'B2', axes: { grammar: 70, vocabulary: 60, coherence: 62, taskResponse: 58, fluency: null }, overall: 64, scoredAt: NOW, scoringNote: null, updatedAt: NOW });
    const fin = (await store.latestFinishedAssessment('u1'))!;
    expect(fin).toMatchObject({ id: 'a-cp', kind: 'checkpoint', level: 'B2', overall: 64, adaptiveCount: 8 });
    expect(fin.axes).toEqual({ grammar: 70, vocabulary: 60, coherence: 62, taskResponse: 58, fluency: null });
    expect((await store.previousFinishedAssessment('u1', NOW))?.id).toBe('a-base');
    expect(await store.previousFinishedAssessment('u1', '2026-10-29T03:00:00.000Z')).toBeNull();
    // старая строка без adaptive_count читается как тест на 12 заданий
    expect((await store.latestAssessment('u1', 'baseline'))?.adaptiveCount).toBe(12);
  });
});
