import { describe, it, expect } from 'vitest';
import {
  AXES, AXIS_WEIGHTS, bandStart, pointsFor, readingPoints, scoreToLevel, nextStep, blend, computeAxes, errorExamples,
  normalizeWritingEval, writingPrompt, evaluateWriting, WRITING_EVAL_SCHEMA, type WritingEval,
} from '../functions/_lib/scoring';
import { score, rescore, startOrResume, answer, ADAPTIVE_COUNT, type Assessment } from '../functions/_lib/assessment';
import type { Attempt } from '../functions/_lib/types';
import { createApp, type Env } from '../functions/_lib/app';
import { sqlStore } from './helpers/sqliteD1';
import { makeItem } from './assessment.test';
import { LEVELS, type Item, type Level } from '../functions/_lib/items';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly' } as unknown as Env;
const TEXT = 'Thank you for the review. I have checked the heat balance again and the losses is within the expected range. The boiler was tested at full load, and the flue gas temperature matched the design value. I agree that the insulation of the steam line should be inspected, and I will add this point to the report before the next meeting. Please tell me if you need the raw measurements.'; // 68 слов

const EVAL = { grammar: 55, vocabulary: 70, coherence: 65, task_response: 80, level: 'B2', summary: 'Текст отвечает на вопрос, но есть ошибка согласования.',
  errors: [
    { original: 'the losses is within', corrected: 'the losses are within', note: 'Подлежащее во множественном числе — глагол are.' },
    { original: 'not in the text at all', corrected: 'anything', note: 'Выдуманная ошибка.' },
    { original: 'Please tell me', corrected: 'Please let me know', note: 'Более естественная формула вежливости.' },
  ],
  rewrite: TEXT.replace('losses is', 'losses are').replace('Please tell me', 'Please let me know') };

describe('шкала ступеней', () => {
  it('ступени занимают по 25 баллов; верный ответ — верх ступени, неверный — низ', () => {
    expect(bandStart('A2')).toBe(0); expect(bandStart('C1')).toBe(75);
    expect(pointsFor('B1', true)).toBe(50); expect(pointsFor('B1', false)).toBe(25);
    expect(readingPoints('B2', 50)).toBe(62.5); expect(readingPoints('C1', 100)).toBe(100); expect(readingPoints('A2', 0)).toBe(0);
  });
  it('уровень по баллу — с запасом 10 от низа ступени', () => {
    expect(scoreToLevel(0)).toBe('A2'); expect(scoreToLevel(34)).toBe('A2'); expect(scoreToLevel(35)).toBe('B1');
    expect(scoreToLevel(59)).toBe('B1'); expect(scoreToLevel(60)).toBe('B2'); expect(scoreToLevel(84)).toBe('B2'); expect(scoreToLevel(85)).toBe('C1'); expect(scoreToLevel(100)).toBe('C1');
  });
  it('чередование «верно B1 / неверно B2» — это B1, а не B2', () => {
    expect(scoreToLevel((pointsFor('B1', true) + pointsFor('B2', false)) / 2)).toBe('B1');
    expect(scoreToLevel((pointsFor('B2', true) + pointsFor('C1', false)) / 2)).toBe('B2');
  });
  it('следующая ступень и остаток баллов; на C1 — null', () => {
    expect(nextStep(50)).toEqual({ level: 'B2', points: 10 });
    expect(nextStep(84)).toEqual({ level: 'C1', points: 1 });
    expect(nextStep(90)).toBeNull();
  });
  it('blend пропускает пустые части и перенормирует веса', () => {
    expect(blend([[80, 0.7], [null, 0.3]])).toBe(80);
    expect(blend([[100, 1], [0, 1]])).toBe(50);
    expect(blend([[null, 1]])).toBeNull();
    expect(Object.values(AXIS_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

/** Попытки адаптивной части: массив [уровень, верно], затем чтение и письмо. */
function attemptsOf(adaptive: [Level, boolean][], items: Map<string, Item>, reading: number | null, writingAnswer: string | null): Attempt[] {
  const out: Attempt[] = [];
  const mk = (position: number, item: Item, level: Level, correct: number | null, score: number | null, ans: string | null): Attempt => {
    items.set(item.id, item);
    return { id: `a${position}`, userId: 'u', assessmentId: 'as', itemId: item.id, position, level, answer: ans, correct, score, feedback: null, detail: null, createdAt: 't', answeredAt: 't' };
  };
  adaptive.forEach(([level, ok], i) => {
    const kind = (i + 1) % 3 === 0 ? 'correction' : 'mcq';
    const item = makeItem(kind, level, i % 4 === 1 ? 'vocabulary' : 'articles');
    out.push(mk(i + 1, item, level, ok ? 1 : 0, ok ? 100 : 0, kind === 'mcq' ? (ok ? item.answer : 'A') : (ok ? item.answer : 'Wrong fix here.')));
  });
  const tail: Level = adaptive.length ? adaptive[adaptive.length - 1][0] : 'B1'; // чтение и письмо — на уровне, к которому подошёл ученик
  if (reading != null) out.push(mk(ADAPTIVE_COUNT + 1, makeItem('reading', tail), tail, reading === 100 ? 1 : 0, reading, reading === 100 ? 'B,C' : reading === 50 ? 'B,A' : 'A,A'));
  if (writingAnswer != null) out.push(mk(ADAPTIVE_COUNT + 2, makeItem('writing', tail), tail, null, null, writingAnswer));
  return out;
}

describe('пять осей', () => {
  it('всё верно на C1 и письмо на C1 — все оси высокие, уровень C1; беглость речи пустая', () => {
    const items = new Map<string, Item>();
    const atts = attemptsOf(Array.from({ length: 12 }, () => ['C1', true]), items, 100, TEXT);
    const w: WritingEval = { axes: { grammar: 90, vocabulary: 92, coherence: 95, taskResponse: 90 }, level: 'C1', summary: 'ок', errors: [], rewrite: null, model: 'm', evaluatedAt: 't' };
    const s = computeAxes(atts, items, w, ADAPTIVE_COUNT);
    expect(s.level).toBe('C1'); expect(s.axes.fluency).toBeNull();
    expect(s.axes.grammar).toBe(97); // 0.7·100 + 0.3·90
    expect(s.axes.vocabulary).toBe(95); // 0.4·100 + 0.6·92 = 95.2
    expect(s.axes.coherence).toBe(97); expect(s.axes.taskResponse).toBe(93);
    expect(s.overall).toBeGreaterThanOrEqual(85);
  });
  it('всё неверно на A2 без письма — A2, оси письма считаются только по чтению', () => {
    const items = new Map<string, Item>();
    const atts = attemptsOf(Array.from({ length: 12 }, () => ['A2', false]), items, 0, null);
    const s = computeAxes(atts, items, null, ADAPTIVE_COUNT);
    expect(s).toMatchObject({ level: 'A2', overall: 0, axes: { grammar: 0, vocabulary: 0, coherence: 0, taskResponse: 0, fluency: null } });
  });
  it('без письма и чтения оси связности и ответа пустые, сводный балл — по остальным', () => {
    const items = new Map<string, Item>();
    const atts = attemptsOf(Array.from({ length: 12 }, (_, i) => ['B2', i % 2 === 0]), items, null, null);
    const s = computeAxes(atts, items, null, ADAPTIVE_COUNT);
    expect(s.axes.coherence).toBeNull(); expect(s.axes.taskResponse).toBeNull();
    // грамматика: 6 верных (75) и 3 неверных (50) на B2 → 66,7; словарь: три неверных на B2 → 50
    expect(s.axes.grammar).toBe(67); expect(s.axes.vocabulary).toBe(50);
    expect(s.overall).toBe(60); expect(s.level).toBe('B2'); // (0,3·67 + 0,2·50) / 0,5
  });
  it('ученик держит B2, проваливает C1, письмо B1+ — уровень B2, грамматика выше словаря', () => {
    const items = new Map<string, Item>();
    const adaptive: [Level, boolean][] = [['B1', true], ['B2', true], ['C1', false], ['B2', true], ['C1', false], ['B2', true], ['C1', false], ['B2', true], ['C1', false], ['B2', true], ['C1', false], ['B2', true]];
    const atts = attemptsOf(adaptive, items, 50, TEXT);
    const w: WritingEval = { axes: { grammar: 45, vocabulary: 40, coherence: 55, taskResponse: 60 }, level: 'B1', summary: 'ок', errors: [], rewrite: null, model: 'm', evaluatedAt: 't' };
    const s = computeAxes(atts, items, w, ADAPTIVE_COUNT);
    expect(s.level).toBe('B2');
    expect(s.axes.grammar!).toBeGreaterThan(s.axes.vocabulary!);
    for (const k of AXES) if (k !== 'fluency') { expect(s.axes[k]).toBeGreaterThanOrEqual(0); expect(s.axes[k]).toBeLessThanOrEqual(100); }
  });
});

describe('оценка письма моделью', () => {
  it('запрос содержит задание, рубрику, образец и текст ученика; ключи ответа — в схеме', () => {
    const item = makeItem('writing', 'B2');
    const msgs = writingPrompt(item, TEXT);
    expect(msgs[1].content).toContain(item.prompt); expect(msgs[1].content).toContain(item.rubric![0]); expect(msgs[1].content).toContain(item.answer); expect(msgs[1].content).toContain(TEXT);
    expect(WRITING_EVAL_SCHEMA.required).toContain('task_response');
  });
  it('нормализация: оси в границах, выдуманные ошибки отбрасываются, переписанный вариант принимается', () => {
    const n = normalizeWritingEval(EVAL, TEXT)!;
    expect(n.axes).toEqual({ grammar: 55, vocabulary: 70, coherence: 65, taskResponse: 80 });
    expect(n.level).toBe('B2');
    expect(n.errors.map(e => e.original)).toEqual(['the losses is within', 'Please tell me']);
    expect(n.rewrite).toContain('losses are');
    expect(normalizeWritingEval({ ...EVAL, grammar: 140, task_response: '-5', level: 'zz' }, TEXT)!.axes.grammar).toBe(100);
    expect(normalizeWritingEval({ ...EVAL, level: 'zz' }, TEXT)!.level).toBe('B2'); // по среднему осей
    expect(normalizeWritingEval({ ...EVAL, rewrite: 'Too short.' }, TEXT)!.rewrite).toBeNull();
    expect(normalizeWritingEval({ grammar: 50 }, TEXT)).toBeNull();
    expect(normalizeWritingEval('nope', TEXT)).toBeNull();
  });
  it('evaluateWriting: одна повторная попытка при неразборчивом ответе, затем ошибка', async () => {
    let calls = 0;
    const flaky = async () => (++calls === 1 ? 'Sure! Here is my assessment.' : JSON.stringify(EVAL));
    const r = await evaluateWriting(ENV, makeItem('writing', 'B2'), TEXT, { chatFn: flaky as any, now: () => 'T' });
    expect(calls).toBe(2); expect(r.axes.grammar).toBe(55); expect(r.evaluatedAt).toBe('T'); expect(r.model).toContain('llama');
    await expect(evaluateWriting(ENV, makeItem('writing', 'B2'), TEXT, { chatFn: (async () => 'no') as any })).rejects.toThrow(/не вернул оценку/);
  });
});

describe('три примера ошибок', () => {
  it('сначала письмо (до двух), затем исправление и выбор варианта; не больше трёх', () => {
    const items = new Map<string, Item>();
    const adaptive: [Level, boolean][] = [['B1', false], ['A2', false], ['B1', false], ['A2', true], ['B1', true], ['B2', true], ['C1', true], ['C1', true], ['C1', true], ['C1', true], ['C1', true], ['C1', true]];
    const atts = attemptsOf(adaptive, items, 50, TEXT);
    const w = { ...normalizeWritingEval(EVAL, TEXT)!, model: 'm', evaluatedAt: 't' };
    const ex = errorExamples(atts, items, w);
    expect(ex).toHaveLength(3);
    expect(ex.map(e => e.source)).toEqual(['writing', 'writing', 'correction']);
    expect(ex[2].quote).toBe('Wrong fix here.'); expect(ex[2].correction).toContain('has been inspected'); expect(ex[2].note).toBe('правило одной строкой');
    const noWriting = errorExamples(atts, items, null);
    expect(noWriting.map(e => e.source)).toEqual(['correction', 'mcq', 'mcq']);
    expect(noWriting[1].quote).toContain(' a energy audit'); expect(noWriting[1].correction).toContain(' the energy audit');
    expect(noWriting[1].topicLabel).toBe('Артикли');
  });
  it('без ошибок — пустой список; неверное чтение попадает в примеры последним', () => {
    const items = new Map<string, Item>();
    const clean = attemptsOf(Array.from({ length: 12 }, () => ['B2', true]), items, 100, TEXT);
    expect(errorExamples(clean, items, null)).toEqual([]);
    const items2 = new Map<string, Item>();
    const rd = attemptsOf(Array.from({ length: 12 }, () => ['B2', true]), items2, 50, TEXT);
    const ex = errorExamples(rd, items2, null);
    expect(ex).toHaveLength(1); expect(ex[0].source).toBe('reading'); expect(ex[0].quote).toContain('imply'); expect(ex[0].correction).toBe('It did not help');
  });
});

describe('оценка в ходе теста', () => {
  /** Банк заданий в базе; массив остаётся у теста — в нём эталоны для верных ответов. */
  async function bank(mem: ReturnType<typeof sqlStore>) {
    const items: Item[] = [];
    for (const l of LEVELS) { for (let i = 0; i < 3; i++) { items.push(makeItem('mcq', l)); items.push(makeItem('correction', l)); } items.push(makeItem('reading', l)); items.push(makeItem('writing', l)); }
    await mem.store.insertItems(items);
    return items;
  }
  const DOMAIN = { specialty: null, industry: null, targetRole: null, keywords: [] };
  const key = (mem: ReturnType<typeof sqlStore>, items: Item[], attId: string) => { const [t] = mem.rows('SELECT item_id FROM attempts WHERE id = ?', attId); return items.find(i => i.id === t.itemId)!; };

  async function runTest(mem: ReturnType<typeof sqlStore>, items: Item[], chatFn: any) {
    const opts = { rng: () => 0, generate: false, chatFn, now: () => '2026-10-30T12:00:00Z' };
    let v = await startOrResume(ENV, mem.store, 'u1', DOMAIN, opts);
    while (v.status === 'active') {
      const cur = v.current!;
      const ans = cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? TEXT : key(mem, items, cur.attemptId).answer;
      v = await answer(ENV, mem.store, 'u1', cur.attemptId, ans, DOMAIN, opts);
    }
    return v;
  }

  it('после письма модель оценивает его, тест получает пять осей, уровень и примеры; письмо получает балл и JSON оценки', async () => {
    const mem = sqlStore(); mem.addUser('u1'); const items = await bank(mem);
    const v = await runTest(mem, items, async () => JSON.stringify(EVAL));
    expect(v.status).toBe('finished'); expect(v.result).not.toBeNull();
    const r = v.result!;
    expect(r.axes.map(a => a.id)).toEqual([...AXES]);
    expect(r.axes.find(a => a.id === 'fluency')!.score).toBeNull();
    expect(r.axes.find(a => a.id === 'grammar')!.score).toBeGreaterThan(70); // все адаптивные верно, письмо 55 по грамматике
    expect(r.level).toBe(v.level); expect(r.scoringNote).toBeNull(); expect(r.scoredAt).toBe('2026-10-30T12:00:00Z');
    expect(r.ladder.steps.map(s => s.from)).toEqual([0, 35, 60, 85]);
    expect(r.writing).toMatchObject({ level: 'B2', errors: 2 }); expect(r.writing!.rewrite).toContain('losses are');
    expect(r.examples.length).toBeGreaterThanOrEqual(2); expect(r.examples[0].source).toBe('writing');
    const a = (await mem.store.latestAssessment('u1'))!;
    const wa = (await mem.store.listAttempts(a.id)).find(t => t.position === ADAPTIVE_COUNT + 2)!;
    expect(wa.score).toBe(68); expect(wa.feedback).toBe(EVAL.summary); expect(JSON.parse(wa.detail!).axes.grammar).toBe(55);
    expect(a.axes!.grammar).toBe(r.axes[0].score); expect(a.overall).toBe(r.overall);
  });

  it('модель молчит — тест всё равно завершён, оси по остальным заданиям, причина в scoringNote; rescore с работающей моделью дооценивает', async () => {
    const mem = sqlStore(); mem.addUser('u1'); const items = await bank(mem);
    const v = await runTest(mem, items, async () => 'Sorry, I cannot.');
    expect(v.status).toBe('finished'); expect(v.result!.scoringNote).toMatch(/письмо не оценено/);
    expect(v.result!.writing).toBeNull(); expect(v.result!.axes.find(a => a.id === 'grammar')!.score).not.toBeNull();
    const again = await rescore(ENV, mem.store, 'u1', { chatFn: (async () => JSON.stringify(EVAL)) as any });
    expect(again.result!.scoringNote).toBeNull(); expect(again.result!.writing!.level).toBe('B2');
    // повторный rescore без force не зовёт модель
    let calls = 0;
    await rescore(ENV, mem.store, 'u1', { chatFn: (async () => { calls++; return JSON.stringify(EVAL); }) as any });
    expect(calls).toBe(0);
    await rescore(ENV, mem.store, 'u1', { chatFn: (async () => { calls++; return JSON.stringify(EVAL); }) as any }, true);
    expect(calls).toBe(1);
  });

  it('score для теста 0.6.0 без оценки: оси появляются; без завершённого теста rescore — assessment_none', async () => {
    const mem = sqlStore(); mem.addUser('u1'); const items = await bank(mem);
    await expect(rescore(ENV, mem.store, 'u1')).rejects.toMatchObject({ code: 'assessment_none' });
    const v = await runTest(mem, items, async () => JSON.stringify(EVAL));
    const id = (await mem.store.latestAssessment('u1'))!.id;
    await mem.store.updateAssessment(id, { overall: null, scoredAt: null } as Partial<Assessment>); // как будто тест пройден до 2.6: без scored_at осей нет
    const a = (await mem.store.latestAssessment('u1'))!;
    expect(a.axes).toBeNull(); expect(a.overall).toBeNull();
    const atts = await mem.store.listAttempts(a.id);
    await score(ENV, mem.store, a, atts, { chatFn: (async () => JSON.stringify(EVAL)) as any });
    expect(a.axes).not.toBeNull(); expect(a.level).toBe(v.level);
    const stored = (await mem.store.latestAssessment('u1'))!;
    expect(stored.axes).not.toBeNull(); expect(stored.level).toBe(v.level);
  });

  it('API: POST /assessment/score без теста — 404, после теста — result с осями', async () => {
    const mem = sqlStore(); const items = await bank(mem);
    const env = { ...ENV, DB: mem.DB, DEV_ECHO_CODE: '1', AI: { run: async () => ({ response: JSON.stringify(EVAL) }) } } as unknown as Env;
    const app = createApp('test');
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const r1: any = await (await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@x.kz' }) })).json();
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@x.kz', code: r1.code }) });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const post = (p: string, b: unknown) => call(p, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b) });
    expect((await post('/assessment/score', {})).status).toBe(404);
    let r: any = await (await post('/assessment/start', {})).json();
    while (r.assessment.status === 'active') {
      const cur = r.assessment.current;
      const ans = cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'writing' ? TEXT : key(mem, items, cur.attemptId).answer;
      r = await (await post('/assessment/answer', { attemptId: cur.attemptId, answer: ans })).json();
    }
    expect(r.assessment.result.axes).toHaveLength(5); expect(r.assessment.result.scoringNote).toBeNull();
    const s: any = await (await post('/assessment/score', {})).json();
    expect(s.ok).toBe(true); expect(s.assessment.result.level).toBe(r.assessment.result.level);
    expect(JSON.stringify(s.assessment.result)).not.toContain('"answer"'); // ключи заданий наружу не уходят
  });
});
