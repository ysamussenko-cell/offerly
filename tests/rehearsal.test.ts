import { describe, it, expect } from 'vitest';
import * as rehearsalModule from '../functions/_lib/rehearsal';
import * as prompts from '../functions/_lib/rehearsal-prompts';
import { CARD_TOPICS } from '../functions/_lib/cards';
import { LEVELS } from '../functions/_lib/items';
import {
  QUESTION_KINDS, REPLACEMENTS, scriptPrompt, defaultScript, reviewPrompt,
} from '../functions/_lib/rehearsal-prompts';
import {
  QUESTION_COUNT, ANSWER_WORDS, CARD_SOURCE, KIND_LABELS,
  normalizeScript, writeScript, validateAnswer, normalizeReview, reviewRehearsal, rehearsalAxes,
  draftsFromReplacements, replacementOrigin, today as rehearsalToday, startOrResume, answer, rescore, abandon, d1RehearsalStore, RehearsalError,
  type Rehearsal, type Turn,
} from '../functions/_lib/rehearsal';
import { dashboard, rehearsalAsLesson } from '../functions/_lib/dashboard';
import type { Assessment } from '../functions/_lib/assessment';
import type { Profile } from '../functions/_lib/profile';
import type { ProgramDay } from '../functions/_lib/program';
import { createApp, type Env } from '../functions/_lib/app';
import { todayIn } from '../functions/_lib/dates';
import { freshDb, d1Of, sqlStore } from './helpers/sqliteD1';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
const USER = 'u1';
const TZ = 'Asia/Almaty';
const NOW = '2026-11-01T05:00:00.000Z'; // воскресенье 1 ноября 2026 в Алматы — репетиция по программе
const TODAY = '2026-11-01';
const DOMAIN = { specialty: 'инженер-теплоэнергетик', industry: 'энергетика', targetRole: 'OpenTrain AI', keywords: ['boiler efficiency', 'heat balance'] };
let seq = 0;
const nextId = () => `id${++seq}`;

const profile = (over: Partial<Profile> = {}): Profile => ({
  userId: USER, specialty: DOMAIN.specialty, industry: DOMAIN.industry, years: 15, targetRole: 'OpenTrain AI', keywords: DOMAIN.keywords, summary: null, resumeText: null, resumeName: null, resumeAt: null,
  interviewDate: null, interviewFormat: null, minutesPerDay: 25, nativeLanguage: 'русский', onboardedAt: NOW, targetLevel: 'C1', weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: NOW, ...over,
});
const assessment = (): Assessment => ({
  id: 'a1', userId: USER, kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level: 'B2', currentLevel: 'B2',
  updatedAt: NOW, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: NOW, scoringNote: null, adaptiveCount: 12, programDayId: null,
});
const day = (over: Partial<ProgramDay> = {}): ProgramDay => ({
  id: `d${++seq}`, userId: USER, dayDate: TODAY, position: 7, week: 1, format: 'rehearsal', topic: 'task-response', writing: null, reason: 'сценарий по целевой позиции: OpenTrain AI', status: 'planned', minutes: 25, score: null, completedAt: null, generatedAt: NOW, updatedAt: null, ...over,
});

const SCRIPT = {
  questions: [
    { kind: 'experience', question: 'Tell me about the boiler efficiency projects you have led. What was the scale and what did they deliver?', rubric: ['Проекты и роль', 'Масштаб и результат', 'Времена'] },
    { kind: 'mistake', question: 'A colleague reported a 92% boiler efficiency after a test, but the heat balance did not close. What went wrong, why, and how would you prevent it?', rubric: ['Ошибка и причина', 'Факт, причина, вывод', 'Связки'] },
    { kind: 'explain', question: 'Explain heat balance to a plant manager without an engineering background. Why does it matter for the budget?', rubric: ['Без жаргона', 'Почему важно', 'Простые предложения'] },
    { kind: 'star', question: 'Tell me about a time you had to disagree with a senior engineer about a measurement. What was the situation, your task, your actions and the result?', rubric: ['STAR целиком', 'Свои действия', 'Результат'] },
    { kind: 'role', question: 'Why OpenTrain AI, and what would you focus on in your first three months?', rubric: ['Связь опыта', 'План', 'Будущие формы'] },
  ],
};
/** Ответы ученика: пять ответов по 40+ слов, с фразами, которые экзаменатор потом «заменит». */
const ANSWERS = [
  'I have led three boiler efficiency projects at a combined heat and power plant since 2018. We measured flue gas losses, rebuilt the air preheater control and in the end efficiency grew from 88 to 91 percent. I was responsible for the test program and for the final report to the management.',
  'The heat balance did not close because the colleague used the design fuel composition instead of the actual one. We make such a mistake when we are in a hurry. I would prevent it by a checklist before the test and by comparing the balance error with the five percent limit before reporting any number.',
  'Heat balance is a simple accounting: the energy that comes in with fuel must equal the useful heat plus all losses. If the sum does not match, some measurement is wrong. For the budget it matters because every percent of unexplained loss is money that we are burning without knowing where it goes.',
  'Last year a senior engineer insisted that the stack temperature sensor was fine. My task was to confirm the efficiency figure. I compared it with a portable analyzer, found a twelve degree offset and showed him the data. In the result we recalibrated the sensor and the report was corrected before it went to the client.',
  'I want to join OpenTrain AI because it combines my engineering background with modern software for energy. In the first three months I would learn the product, talk with the first customers and build a library of typical boiler cases, so that the models are checked against real plant data.',
];
const REVIEW = {
  grammar: 62, vocabulary: 58, coherence: 60, task_response: 66, level: 'B2',
  summary: 'Разговор держится на фактах и цифрах. Первым исправьте кальки с русского в связках.',
  strengths: ['Цифры и факты в каждом ответе: «from 88 to 91 percent»', 'STAR выдержан: ситуация, задача, действия, результат'],
  turns: [{ position: 1, score: 70, note: 'Хороший ответ, добавьте итог для бизнеса.' }, { position: 2, score: 60, note: 'Причина названа, вывод размыт.' }, { position: 3, score: 65, note: 'Понятно неспециалисту.' }, { position: 4, score: 68, note: 'Результат назван явно.' }, { position: 5, score: 58, note: 'План конкретный, мотивация общая.' }],
  replacements: [
    { original: 'In the result we recalibrated', better: 'As a result, we recalibrated', note: 'Калька с русского «в результате»: as a result.', topic: 'conjunctions' },
    { original: 'We make such a mistake when we are in a hurry', better: 'Such mistakes happen when we are in a hurry', note: 'Обобщение без «we make».', topic: 'register' },
    { original: 'efficiency grew from 88 to 91 percent', better: 'efficiency rose from 88 to 91 percent', note: 'Для показателей — rise/increase.', topic: 'vocabulary' },
    { original: 'this phrase is not in the transcript', better: 'anything', note: 'выдумано', topic: 'tenses' },
  ],
};
const scriptChat = async () => JSON.stringify(SCRIPT);
const reviewChat = async () => JSON.stringify(REVIEW);
/** Один chatFn на оба вызова: сценарий — по системной подсказке интервьюера, разбор — по подсказке экзаменатора. */
const bothChat = async (_env: unknown, msgs: { role: string; content: string }[]) => msgs[0].content.startsWith('You are an experienced hiring manager') ? JSON.stringify(SCRIPT) : JSON.stringify(REVIEW);
const failChat = async () => { throw new Error('AI 429'); };
const opts = (chatFn: any) => ({ chatFn, now: () => NOW, id: nextId });

type Mem = ReturnType<typeof sqlStore>;
async function seeded(withDay = true) {
  const mem = sqlStore(); mem.addUser(USER);
  await mem.putAssessment(assessment());
  mem.putProfile(profile());
  if (withDay) await mem.store.replacePlannedDays(USER, TODAY, [day()]);
  return mem;
}
const profileOf = async (mem: Mem) => (await mem.store.getProfile(USER))!;
const firstDay = async (mem: Mem, userId = USER) => (await mem.store.listProgramDays(userId))[0];
const rehearsalsOf = (mem: Mem) => mem.store.listRehearsals(USER);
const cardsOf = (mem: Mem) => mem.rows('SELECT * FROM error_cards WHERE user_id = ?', USER);

async function runAll(mem: Mem, chatFn: any = bothChat) {
  let v = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(chatFn));
  for (const a of ANSWERS) v = await answer(ENV, mem.store, USER, v.current!.turnId, a, TZ, await profileOf(mem), opts(chatFn));
  return v;
}

describe('сценарий', () => {
  it('подсказка: пять видов вопросов по порядку, домен, позиция и термины резюме', () => {
    const [sys, user] = scriptPrompt(DOMAIN, 'OpenTrain AI', 'B2');
    for (const k of QUESTION_KINDS) expect(sys.content).toContain(`"${k}"`);
    expect(sys.content).toContain('CEFR B2');
    expect(user.content).toContain('инженер-теплоэнергетик, энергетика');
    expect(user.content).toContain('Target role: OpenTrain AI');
    expect(user.content).toContain('boiler efficiency, heat balance');
    expect(scriptPrompt({ ...DOMAIN, keywords: [] }, null, 'B1')[1].content).toContain('No résumé terms');
  });
  it('нормализация: пять видов по одному в нашем порядке; лишнее отбрасывается, неполное — null', () => {
    const qs = normalizeScript(SCRIPT)!;
    expect(qs.map(q => q.kind)).toEqual([...QUESTION_KINDS]);
    const shuffled = { questions: [...SCRIPT.questions].reverse().concat([{ kind: 'star', question: 'Duplicate star question that should be ignored', rubric: ['x'] }]) };
    expect(normalizeScript(shuffled)!.map(q => q.kind)).toEqual([...QUESTION_KINDS]);
    expect(normalizeScript(shuffled)![3].question).toBe(SCRIPT.questions[3].question);
    expect(normalizeScript({ questions: SCRIPT.questions.slice(0, 4) })).toBeNull();
    expect(normalizeScript({ questions: SCRIPT.questions.map(q => ({ ...q, rubric: [] })) })).toBeNull();
    expect(normalizeScript({ questions: SCRIPT.questions.map(q => ({ ...q, question: 'short' })) })).toBeNull();
    expect(normalizeScript(null)).toBeNull();
    expect(normalizeScript({})).toBeNull();
  });
  it('встроенный сценарий подставляет позицию и покрывает все виды; без позиции — «this role»', () => {
    const d = defaultScript('OpenTrain AI');
    expect(d).toHaveLength(QUESTION_COUNT);
    expect(d.map(q => q.kind)).toEqual([...QUESTION_KINDS]);
    expect(d[0].question).toContain('the role of OpenTrain AI');
    expect(defaultScript(null)[4].question).toContain('this role');
    for (const q of d) expect(q.rubric.length).toBeGreaterThanOrEqual(3);
  });
  it('writeScript: модель → сценарий с именем модели; сбой или мусор дважды → встроенный с причиной', async () => {
    const ok = await writeScript(ENV, DOMAIN, 'OpenTrain AI', 'B2', { chatFn: scriptChat });
    expect(ok.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(ok.note).toBeNull();
    expect(ok.questions[1].question).toContain('heat balance');
    const bad = await writeScript(ENV, DOMAIN, 'OpenTrain AI', 'B2', { chatFn: async () => 'not json at all' });
    expect(bad.model).toBeNull();
    expect(bad.note).toContain('не вернула сценарий');
    expect(bad.questions[0].question).toContain('OpenTrain AI');
    let calls = 0;
    const retry = await writeScript(ENV, DOMAIN, null, 'B1', { chatFn: async () => { calls++; if (calls === 1) throw new Error('AI 429'); return JSON.stringify(SCRIPT); } });
    expect(calls).toBe(2);
    expect(retry.model).not.toBeNull();
    const fail = await writeScript(ENV, DOMAIN, null, 'B1', { chatFn: failChat });
    expect(fail.note).toContain('AI 429');
  });
});

describe('ответ и разбор', () => {
  it('ответ: пусто, короче 15 слов, длиннее 400 — отказ; иначе принимается с нормализованными пробелами', () => {
    expect(validateAnswer('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateAnswer(42)).toEqual({ ok: false, reason: 'empty' });
    expect(validateAnswer('I led three projects.')).toEqual({ ok: false, reason: 'too_short' });
    expect(validateAnswer(Array.from({ length: ANSWER_WORDS.max + 1 }, () => 'word').join(' '))).toEqual({ ok: false, reason: 'too_long' });
    const r = validateAnswer('  ' + ANSWERS[0].replace(/ /g, '   ') + '  ');
    expect(r).toMatchObject({ ok: true, answer: ANSWERS[0] });
  });
  it('подсказка экзаменатору: все вопросы с рубриками и ответами, позиция и уровень', () => {
    const turns: Turn[] = SCRIPT.questions.map((q, i) => ({ id: `t${i}`, rehearsalId: 'r', userId: USER, position: i + 1, kind: q.kind as Turn['kind'], question: q.question, rubric: q.rubric, answer: ANSWERS[i], score: null, feedback: null, speechId: null, createdAt: NOW, answeredAt: NOW }));
    const [sys, user] = reviewPrompt({ targetRole: 'OpenTrain AI', level: 'B2' }, turns, DOMAIN);
    expect(sys.content).toContain(`exactly ${REPLACEMENTS} phrases`);
    expect(user.content).toContain('QUESTION 5 (role)');
    expect(user.content).toContain('- Проекты и роль');
    expect(user.content).toContain(ANSWERS[2]);
    expect(user.content).toContain('Target level: B2');
  });
  it('нормализация разбора: фразы только из ответов, не больше трёх, баллы по позициям; без осей — null', () => {
    const turns: Turn[] = SCRIPT.questions.map((q, i) => ({ id: `t${i}`, rehearsalId: 'r', userId: USER, position: i + 1, kind: q.kind as Turn['kind'], question: q.question, rubric: q.rubric, answer: ANSWERS[i], score: null, feedback: null, speechId: null, createdAt: NOW, answeredAt: NOW }));
    const n = normalizeReview(REVIEW, turns)!;
    expect(n.axes).toEqual({ grammar: 62, vocabulary: 58, coherence: 60, taskResponse: 66 });
    expect(n.level).toBe('B2');
    expect(n.replacements).toHaveLength(3);
    expect(n.replacements.map(r => r.topic)).toEqual(['conjunctions', 'register', 'vocabulary']);
    expect(n.replacements.some(r => r.original.includes('not in the transcript'))).toBe(false);
    expect(n.turns.map(t => t.score)).toEqual([70, 60, 65, 68, 58]);
    expect(n.strengths).toHaveLength(2);
    // позиция вне сценария и повтор позиции отбрасываются; неизвестная тема → null; «лучше» = «как сказано» → пропуск
    const odd = normalizeReview({ ...REVIEW, turns: [{ position: 9, score: 50, note: 'x' }, { position: 1, score: 70, note: 'a' }, { position: 1, score: 10, note: 'b' }], replacements: [{ original: 'heat balance', better: 'heat balance', note: 'same', topic: 'tenses' }, { original: 'Heat balance is a simple accounting', better: 'Heat balance is simple bookkeeping', note: 'n', topic: 'nope' }] }, turns)!;
    expect(odd.turns).toEqual([{ position: 1, score: 70, note: 'a' }]);
    expect(odd.replacements).toEqual([{ original: 'Heat balance is a simple accounting', better: 'Heat balance is simple bookkeeping', note: 'n', topic: null }]);
    expect(normalizeReview({ grammar: 50 }, turns)).toBeNull();
    expect(normalizeReview('x', turns)).toBeNull();
  });
  it('reviewRehearsal: повторная попытка при мусоре, затем ошибка с хвостом ответа', async () => {
    const turns: Turn[] = SCRIPT.questions.map((q, i) => ({ id: `t${i}`, rehearsalId: 'r', userId: USER, position: i + 1, kind: q.kind as Turn['kind'], question: q.question, rubric: q.rubric, answer: ANSWERS[i], score: null, feedback: null, speechId: null, createdAt: NOW, answeredAt: NOW }));
    let calls = 0;
    const r = await reviewRehearsal(ENV, { targetRole: null, level: 'B2' }, turns, DOMAIN, { chatFn: async () => { calls++; return calls === 1 ? 'hmm' : JSON.stringify(REVIEW); }, now: () => NOW });
    expect(calls).toBe(2);
    expect(r.reviewedAt).toBe(NOW);
    await expect(reviewRehearsal(ENV, { targetRole: null, level: 'B2' }, turns, DOMAIN, { chatFn: async () => 'garbage' })).rejects.toThrow(/не вернул разбор.*garbage/);
  });
  it('оси: четыре от экзаменатора, беглость null, сводный — по весам без беглости; карточки из фраз с темой по умолчанию', () => {
    const s = rehearsalAxes({ axes: { grammar: 62, vocabulary: 58, coherence: 60, taskResponse: 66 } });
    expect(s.axes.fluency).toBeNull();
    // (62·0,3 + 58·0,2 + 60·0,2 + 66·0,2) / 0,9 = 61,5…
    expect(s.overall).toBe(62);
    expect(s.level).toBe('B2');
    const drafts = draftsFromReplacements([{ original: 'a b c', better: 'a b d', note: 'n', topic: 'tenses' }, { original: 'x y z', better: 'x y w', note: '', topic: null }], 'R1');
    expect(drafts).toEqual([
      { topic: 'tenses', rule: 'n', example: 'a b c', correction: 'a b d', origin: 'rehearsal:R1:r1' },
      { topic: 'task-response', rule: null, example: 'x y z', correction: 'x y w', origin: replacementOrigin('R1', 1) },
    ]);
  });
});

describe('репетиция целиком', () => {
  it('start: сценарий от модели, пять вопросов, привязка к дню программы; повторный start возвращает ту же', async () => {
    const mem = await seeded();
    const v = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(scriptChat));
    expect(v).toMatchObject({ status: 'active', date: TODAY, targetRole: 'OpenTrain AI', level: 'B2', scripted: true, total: 5, answered: 0 });
    expect(v.current).toMatchObject({ position: 1, kind: 'experience', kindLabel: KIND_LABELS.experience, words: { min: 40, max: 150 } });
    expect(v.current!.question).toContain('boiler efficiency');
    expect(v.day?.format).toBe('rehearsal');
    expect(v.turns.map(t => t.kind)).toEqual([...QUESTION_KINDS]);
    expect((await rehearsalsOf(mem))[0].programDayId).toBe((await firstDay(mem)).id);
    const again = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(failChat));
    expect(again.id).toBe(v.id);
    expect(await rehearsalsOf(mem)).toHaveLength(1);
  });
  it('start без дня программы и без теста: вне плана, уровень B1 по умолчанию; модель молчит — встроенный сценарий с пометкой', async () => {
    const mem = sqlStore(); mem.addUser(USER);
    const v = await startOrResume(ENV, mem.store, USER, TZ, null, opts(failChat));
    expect(v).toMatchObject({ level: 'B1', scripted: false, targetRole: null, day: null });
    expect(v.current!.question).toContain('this role');
    expect(v.reviewNote).toContain('сценарий встроенный');
    const t = await rehearsalToday(mem.store, USER, TZ, { now: () => NOW });
    expect(t).toMatchObject({ today: TODAY, scheduled: false, day: null, last: null });
    expect(t.rehearsal?.id).toBe(v.id);
  });
  it('пять ответов → разбор: оси, баллы вопросов, три фразы, карточки в журнале, день программы пройден', async () => {
    const mem = await seeded();
    const v = await runAll(mem);
    expect(v.status).toBe('finished');
    expect(v.current).toBeNull();
    expect(v.answered).toBe(5);
    expect(v.result).toMatchObject({ overall: 62, level: 'B2', newCards: 3 });
    expect(v.result!.axes.map(a => a.score)).toEqual([62, 58, 60, 66, null]);
    expect(v.result!.replacements.map(r => r.topicLabel)).toEqual(['Союзы и инверсия', 'Регистр рецензента', 'Профессиональная лексика']);
    expect(v.result!.strengths).toHaveLength(2);
    expect(v.turns.map(t => t.score)).toEqual([70, 60, 65, 68, 58]);
    expect(v.turns[0].feedback).toContain('добавьте итог');
    expect(v.turns.every(t => t.answered && t.words! >= 40)).toBe(true);
    expect(v.reviewNote).toBeNull();
    const cards = mem.rows('SELECT * FROM error_cards WHERE user_id = ? AND source = ? ORDER BY created_at, origin', USER, CARD_SOURCE);
    expect(cards).toHaveLength(3);
    expect(cards.map(c => c.origin)).toEqual(['rehearsal:' + v.id + ':r1', 'rehearsal:' + v.id + ':r2', 'rehearsal:' + v.id + ':r3']);
    expect(cards[0]).toMatchObject({ topic: 'conjunctions', example: 'In the result we recalibrated', correction: 'As a result, we recalibrated', due: '2026-11-02' });
    expect(await firstDay(mem)).toMatchObject({ status: 'done', score: 62 });
    expect((await rehearsalsOf(mem))[0]).toMatchObject({ status: 'finished', overall: 62, axes: { grammar: 62, fluency: null } });
    // главный экран: репетиция считается как занятие — день в серии, вклад в готовность, минуты недели
    const d = await dashboard(mem.store, USER, TZ, await profileOf(mem), { now: () => NOW });
    expect(d.streak).toMatchObject({ current: 1, todayDone: true });
    expect(d.readiness).toMatchObject({ lessons: 1, gained: 1.2, value: 54 });
    expect(d.week.find(w => w.today)).toMatchObject({ status: 'done', score: 62 });
    expect(rehearsalAsLesson((await rehearsalsOf(mem))[0])).toEqual({ dayDate: TODAY, score: 62, status: 'finished', finishedAt: NOW, bonus: null });
  });
  it('ответы: чужой или старый вопрос — stale, короткий — answer_invalid, после завершения — finished; без репетиции — none', async () => {
    const mem = await seeded();
    await expect(answer(ENV, mem.store, USER, 'x', ANSWERS[0], TZ, null, opts(bothChat))).rejects.toMatchObject({ code: 'rehearsal_none' });
    const v = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(scriptChat));
    await expect(answer(ENV, mem.store, USER, 'nope', ANSWERS[0], TZ, null, opts(bothChat))).rejects.toMatchObject({ code: 'rehearsal_stale' });
    await expect(answer(ENV, mem.store, USER, v.current!.turnId, 'too short', TZ, null, opts(bothChat))).rejects.toMatchObject({ code: 'answer_invalid', reason: 'too_short' });
    expect(mem.rows('SELECT answered_at FROM rehearsal_turns WHERE rehearsal_id = ? ORDER BY position LIMIT 1', v.id)).toEqual([{ answeredAt: null }]);
    const done = await runAll(mem);
    await expect(answer(ENV, mem.store, USER, done.turns[0].turnId, ANSWERS[0], TZ, null, opts(bothChat))).rejects.toMatchObject({ code: 'rehearsal_finished' });
  });
  it('сбой экзаменатора: репетиция закрыта с причиной, день отмечен без балла; review повторяет разбор, force — заново без дублей карточек', async () => {
    const mem = await seeded();
    const scriptOnly = async (_e: unknown, msgs: { content: string }[]) => { if (msgs[0].content.startsWith('You are an experienced hiring manager')) return JSON.stringify(SCRIPT); throw new Error('AI 500'); };
    const v = await runAll(mem, scriptOnly);
    expect(v.status).toBe('finished');
    expect(v.result).toBeNull();
    expect(v.reviewNote).toContain('AI 500');
    expect(await firstDay(mem)).toMatchObject({ status: 'done', score: null });
    expect(cardsOf(mem)).toHaveLength(0);
    await expect(rescore(ENV, mem.store, USER, TZ, await profileOf(mem), false, opts(failChat))).rejects.toMatchObject({ code: 'rehearsal_eval_failed' });
    const ok = await rescore(ENV, mem.store, USER, TZ, await profileOf(mem), false, opts(reviewChat));
    expect(ok.result?.overall).toBe(62);
    expect((await firstDay(mem)).score).toBe(62);
    expect(cardsOf(mem)).toHaveLength(3);
    // разбор есть — без force возвращается как есть (модель не зовётся); с force — заново, карточки те же
    const same = await rescore(ENV, mem.store, USER, TZ, await profileOf(mem), false, opts(failChat));
    expect(same.result?.reviewedAt).toBe(ok.result?.reviewedAt);
    const forced = await rescore(ENV, mem.store, USER, TZ, await profileOf(mem), true, opts(reviewChat));
    expect(forced.result?.overall).toBe(62);
    expect(cardsOf(mem)).toHaveLength(3);
    const empty = sqlStore(); empty.addUser(USER);
    await expect(rescore(ENV, empty.store, USER, TZ, null, false, opts(reviewChat))).rejects.toMatchObject({ code: 'rehearsal_none' });
  });
  it('abandon: начатая бросается, следующий start пишет новый сценарий; завершённую бросить нельзя', async () => {
    const mem = await seeded(false);
    const v = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(scriptChat));
    expect(await abandon(mem.store, USER, TZ, { now: () => NOW })).toBe(true);
    expect((await rehearsalToday(mem.store, USER, TZ, { now: () => NOW })).rehearsal).toBeNull();
    const v2 = await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(scriptChat));
    expect(v2.id).not.toBe(v.id);
    expect(await rehearsalsOf(mem)).toHaveLength(2);
    await runAll(mem);
    expect(await abandon(mem.store, USER, TZ, { now: () => NOW })).toBe(false);
  });
  it('today: сегодняшняя репетиция и последняя прежняя; в день программы — scheduled', async () => {
    const mem = await seeded();
    const past: Rehearsal = { id: 'old', userId: USER, programDayId: null, dayDate: '2026-10-25', targetRole: 'X', level: 'B1', status: 'finished', questionCount: 5, scriptModel: null, axes: { grammar: 40, vocabulary: 40, coherence: 40, taskResponse: 40, fluency: null }, overall: 40, review: JSON.stringify({ axes: { grammar: 40, vocabulary: 40, coherence: 40, taskResponse: 40 }, level: 'B1', summary: 's', strengths: [], replacements: [], turns: [], model: 'm', reviewedAt: NOW }), reviewNote: null, startedAt: '2026-10-25T05:00:00.000Z', finishedAt: '2026-10-25T05:20:00.000Z', updatedAt: null };
    await mem.store.createRehearsal(past, []);
    const t0 = await rehearsalToday(mem.store, USER, TZ, { now: () => NOW });
    expect(t0).toMatchObject({ scheduled: true, rehearsal: null });
    expect(t0.day?.format).toBe('rehearsal');
    expect(t0.last).toMatchObject({ id: 'old', result: { overall: 40, level: 'B1' } });
    await startOrResume(ENV, mem.store, USER, TZ, await profileOf(mem), opts(scriptChat));
    const t1 = await rehearsalToday(mem.store, USER, TZ, { now: () => NOW });
    expect(t1.rehearsal?.status).toBe('active');
    expect(t1.last?.id).toBe('old');
  });
});

describe('хранилище D1 (node:sqlite)', () => {
  it('создаёт репетицию с вопросами, обновляет оси и разбор, читает обратно', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'a@b.cc')`);
    const store = d1RehearsalStore(d1Of(db));
    const r: Rehearsal = { id: 'r1', userId: USER, programDayId: 'd1', dayDate: TODAY, targetRole: 'OpenTrain AI', level: 'B2', status: 'active', questionCount: 5, scriptModel: 'm', axes: null, overall: null, review: null, reviewNote: null, startedAt: NOW, finishedAt: null, updatedAt: NOW };
    const turns: Turn[] = SCRIPT.questions.map((q, i) => ({ id: `t${i}`, rehearsalId: 'r1', userId: USER, position: i + 1, kind: q.kind as Turn['kind'], question: q.question, rubric: q.rubric, answer: null, score: null, feedback: null, speechId: null, createdAt: NOW, answeredAt: null }));
    await store.createRehearsal(r, turns);
    expect(await store.rehearsalForDay(USER, TODAY)).toEqual(r);
    expect(await store.rehearsalForDay(USER, '2026-10-31')).toBeNull();
    const back = await store.listTurns('r1');
    expect(back).toEqual(turns);
    await store.updateTurn('t0', { answer: ANSWERS[0], answeredAt: NOW });
    await store.updateTurn('t0', { score: 70, feedback: 'ok' });
    expect((await store.listTurns('r1'))[0]).toMatchObject({ answer: ANSWERS[0], answeredAt: NOW, score: 70, feedback: 'ok' });
    await store.updateRehearsal('r1', { status: 'finished', finishedAt: NOW, axes: { grammar: 62, vocabulary: 58, coherence: 60, taskResponse: 66, fluency: null }, overall: 62, review: '{"axes":{}}', reviewNote: null });
    const fin = (await store.listRehearsals(USER))[0];
    expect(fin).toMatchObject({ status: 'finished', overall: 62, axes: { grammar: 62, vocabulary: 58, coherence: 60, taskResponse: 66, fluency: null }, review: '{"axes":{}}' });
    await store.updateRehearsal('r1', {});
    expect(await store.listRehearsals('nobody')).toEqual([]);
  });
});

describe('маршруты /api/rehearsal', () => {
  async function session() {
    const mem = sqlStore();
    const ai = { run: async (_m: string, input: any) => ({ response: input.messages[0].content.startsWith('You are an experienced hiring manager') ? JSON.stringify(SCRIPT) : JSON.stringify(REVIEW) }) };
    const env = { DB: mem.DB, AI: ai, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
    const app = createApp('test');
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const r1 = await post('/auth/request', { email: 'y@example.com' });
    const { code } = await r1.json() as any;
    const r2 = await post('/auth/verify', { email: 'y@example.com', code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const [u] = mem.rows<{ id: string }>('SELECT id FROM users');
    // данные теста (как в seeded) — на вошедшего пользователя
    await mem.putAssessment({ ...assessment(), userId: u.id });
    mem.putProfile(profile({ userId: u.id }));
    await mem.store.replacePlannedDays(u.id, todayIn(TZ), [day({ userId: u.id, dayDate: todayIn(TZ) })]); // маршруты живут по настоящим часам
    mem.db.prepare('UPDATE users SET tz = ? WHERE id = ?').run(TZ, u.id);
    return { mem, call, post, cookie, h: { cookie }, userId: u.id };
  }
  it('без входа — 401; GET отдаёт мету и состояние; start → answer ×5 → разбор; review без разбора — как есть; abandon завершённой — false', async () => {
    const { call, post, cookie, h, mem, userId } = await session();
    expect((await call('/rehearsal')).status).toBe(401);
    expect((await post('/rehearsal/start', {})).status).toBe(401);
    const g0 = await (await call('/rehearsal', { headers: h })).json() as any;
    expect(g0).toMatchObject({ ok: true, questions: 5, replacements: 3, words: { min: 15, max: 400 }, rehearsal: null, last: null });
    expect(g0.scheduled).toBe(true);
    const s = await (await post('/rehearsal/start', {}, h)).json() as any;
    expect(s.ok).toBe(true);
    expect(s.rehearsal.current.position).toBe(1);
    const bad = await post('/rehearsal/answer', { turnId: s.rehearsal.current.turnId, answer: 'short' }, h);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: 'answer_invalid', reason: 'too_short' });
    const stale = await post('/rehearsal/answer', { turnId: 'zzz', answer: ANSWERS[0] }, h);
    expect(stale.status).toBe(409);
    let cur = s.rehearsal;
    for (const a of ANSWERS) {
      const r = await post('/rehearsal/answer', { turnId: cur.current.turnId, answer: a }, h);
      expect(r.status).toBe(200);
      const j = await r.json() as any;
      expect(Array.isArray(j.unlocked)).toBe(true);
      cur = j.rehearsal;
    }
    expect(cur.status).toBe('finished');
    expect(cur.result).toMatchObject({ overall: 62, level: 'B2', newCards: 3 });
    expect(cur.result.replacements).toHaveLength(3);
    const g1 = await (await call('/rehearsal', { headers: h })).json() as any;
    expect(g1.rehearsal.status).toBe('finished');
    expect((await firstDay(mem, userId)).status).toBe('done');
    const rv = await post('/rehearsal/review', {}, h);
    expect(rv.status).toBe(200);
    expect(((await rv.json()) as any).rehearsal.result.overall).toBe(62);
    expect(await (await post('/rehearsal/abandon', {}, h)).json()).toEqual({ ok: true, abandoned: false });
    const fin = await post('/rehearsal/answer', { turnId: cur.turns[0].turnId, answer: ANSWERS[0] }, h);
    expect(fin.status).toBe(409);
    expect(await fin.json()).toMatchObject({ error: 'rehearsal_finished' });
    expect(cookie).toContain('offerly_session=');
  });
  it('review без завершённой репетиции — 404 rehearsal_none', async () => {
    const { post, h } = await session();
    const r = await post('/rehearsal/review', {}, h);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, error: 'rehearsal_none' });
    expect(new RehearsalError('rehearsal_none').message).toBe('rehearsal_none');
  });
});

describe('подсказки модели в rehearsal-prompts.ts', () => {
  it('rehearsal.ts реэкспортирует те же объекты, а не копии', () => {
    for (const k of ['QUESTION_KINDS', 'REPLACEMENTS', 'SCRIPT_SCHEMA', 'REVIEW_SCHEMA', 'scriptPrompt', 'defaultScript', 'reviewPrompt'] as const) {
      expect(rehearsalModule[k], k).toBe(prompts[k]);
    }
  });

  it('схемы ответа модели перечисляют те же виды вопросов, уровни и все темы карточек', () => {
    const kinds = (prompts.SCRIPT_SCHEMA.properties.questions.items.properties.kind as { enum: string[] }).enum;
    expect(kinds).toEqual([...prompts.QUESTION_KINDS]);
    expect(prompts.REVIEW_SCHEMA.properties.level.enum).toEqual([...LEVELS]);
    const topics = (prompts.REVIEW_SCHEMA.properties.replacements.items.properties.topic as { enum: string[] }).enum;
    expect(topics).toEqual(CARD_TOPICS.map(t => t.id));
    expect(reviewPrompt({ targetRole: null, level: 'B1' }, [], { specialty: null, industry: null, targetRole: null, keywords: [] })[1].content).toContain('Target role: not specified');
  });

  it('подсказка экзаменатора принимает ход репетиции как есть: голосовой ответ помечен, пустой — «(no answer)»', () => {
    const turns: prompts.PromptTurn[] = [
      { position: 1, kind: 'experience', question: 'Tell me about your experience.', rubric: ['Конкретика'], answer: 'I built forecasting models for retail chains.', speechId: 'sp1' },
      { position: 2, kind: 'mistake', question: 'What went wrong?', rubric: ['Причина'], answer: null, speechId: null },
    ];
    const user = reviewPrompt({ targetRole: 'Analyst', level: 'B2' }, turns, { specialty: 'data', industry: null, targetRole: null, keywords: [] })[1].content;
    expect(user).toContain('(spoken; automatic transcript');
    expect(user).toContain('QUESTION 2 (mistake): What went wrong?');
    expect(user).toContain('(no answer)');
  });
});
