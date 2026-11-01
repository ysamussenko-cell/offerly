import { describe, it, expect } from 'vitest';
import {
  kindAt, nextLevel, levelFallbacks, estimateLevel, grade, testItem, pickItem, startOrResume, answer, abandon, current,
  AssessmentError, TOTAL, ADAPTIVE_COUNT, ANSWER_WORDS,
} from '../functions/_lib/assessment';
import { LEVELS, TOPICS, type Item, type Kind, type Level } from '../functions/_lib/items';
import { createApp, type Env } from '../functions/_lib/app';
import { sqlStore } from './helpers/sqliteD1';

const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly' } as unknown as Env;
let seq = 0;
const PASSAGE = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} of the report says the boiler efficiency fell after the retrofit.`).join(' ');
const ESSAY = Array.from({ length: 14 }, () => 'The boiler efficiency test shows a small loss.').join(' '); // 112 слов — слишком длинно для 60–80, но в допуске приёма
const SHORT = Array.from({ length: 8 }, () => 'The boiler efficiency test shows a small loss.').join(' '); // 64 слова

/** Принятое задание банка нужного вида и уровня; тема — по кругу, чтобы проверять «не повторять тему подряд». */
export function makeItem(kind: Kind, level: Level, topic = TOPICS[seq % TOPICS.length].id, status: Item['status'] = 'verified'): Item {
  const n = ++seq;
  const base = { id: `it${n}`, kind, level, topic, domain: null, rubric: null, explanation: 'правило одной строкой', status, checkNote: null, checkedLevel: null, writingFormat: null, fingerprint: `fp${n}`, source: 'test', createdAt: `2026-10-30T00:00:${String(n % 60).padStart(2, '0')}Z`, verifiedAt: null };
  if (kind === 'mcq') return { ...base, prompt: `We finished ___ energy audit number ${n} last week.`, options: ['a', 'an', 'the', '—'], answer: 'C' };
  if (kind === 'correction') return { ...base, prompt: `The turbine have been inspected ${n} times since the overhaul.`, options: null, answer: `The turbine has been inspected ${n} times since the overhaul.` };
  if (kind === 'reading') return { ...base, prompt: PASSAGE, options: [
    { question: 'What does the report mainly say?', options: ['Efficiency rose', 'Efficiency fell', 'Nothing changed', 'The boiler was replaced'], answer: 'B' },
    { question: 'What does the author imply about the retrofit?', options: ['It succeeded', 'It was free', 'It did not help', 'It was postponed'], answer: 'C' },
  ], answer: 'B,C' };
  return { ...base, prompt: `Write a short reply to a reviewer about calculation ${n} in 60–80 words.`, options: null, rubric: ['Отвечает прямо', 'Объясняет метод', 'Нейтральный тон'], answer: SHORT };
}

/** Полный банк в базе: по три mcq и исправления на каждом уровне, по одному чтению и письму. Массив остаётся у теста — в нём эталоны. */
async function fillBank(mem: ReturnType<typeof sqlStore>) {
  const items: Item[] = [];
  for (const l of LEVELS) {
    for (let i = 0; i < 3; i++) { items.push(makeItem('mcq', l)); items.push(makeItem('correction', l)); }
    items.push(makeItem('reading', l)); items.push(makeItem('writing', l));
  }
  await mem.store.insertItems(items);
  return items;
}
/** Попытки в порядке записи — по всем тестам пользователя, в порядке вставки. */
const attemptRows = (mem: ReturnType<typeof sqlStore>) => mem.rows('SELECT id, item_id, level FROM attempts ORDER BY rowid');
/** Хранилище D1 с кандидатами в порядке записи: SQL отдаёт их ORDER BY RANDOM(), а тема задания влияет на оси и итоговый уровень,
 *  поэтому ход, где проверяется уровень, фиксирует порядок (выбор остаётся за rng из opts, как в pickItem). */
function ordered(mem: ReturnType<typeof sqlStore>): typeof mem.store {
  const seqOf = (i: Item) => Number(i.id.slice(2));
  return { ...mem.store, randomItems: async (kind, level, limit) => (await mem.store.randomItems(kind, level, 200)).sort((x, y) => seqOf(x) - seqOf(y)).slice(0, limit) };
}

const DOMAIN = { specialty: null, industry: null, targetRole: null, keywords: [] };
const rng = () => 0; // детерминированный выбор — первый кандидат

describe('план и подстройка', () => {
  it('двенадцать адаптивных заданий — исправление на каждой третьей позиции, затем чтение и письмо', () => {
    const kinds = Array.from({ length: TOTAL }, (_, i) => kindAt(i + 1));
    expect(kinds.filter(k => k === 'correction')).toHaveLength(4);
    expect(kinds.filter(k => k === 'mcq')).toHaveLength(8);
    expect(kinds[ADAPTIVE_COUNT]).toBe('reading');
    expect(kinds[TOTAL - 1]).toBe('writing');
  });
  it('уровень сдвигается на ступень и упирается в края', () => {
    expect(nextLevel('B1', true)).toBe('B2');
    expect(nextLevel('B1', false)).toBe('A2');
    expect(nextLevel('C1', true)).toBe('C1');
    expect(nextLevel('A2', false)).toBe('A2');
  });
  it('запасные уровни: сам, ниже, выше, дальше', () => {
    expect(levelFallbacks('B2')).toEqual(['B2', 'B1', 'C1', 'A2']);
    expect(levelFallbacks('A2')).toEqual(['A2', 'B1', 'B2', 'C1']);
  });
});

describe('оценка уровня', () => {
  const walk = (answers: boolean[]) => {
    let level: Level = 'B1';
    return answers.map((ok, i) => { const a = { position: i + 1, level, correct: ok ? 1 : 0 }; level = nextLevel(level, ok); return a; });
  };
  it('все верно — C1, все неверно — A2', () => {
    expect(estimateLevel(walk(Array(12).fill(true)))).toBe('C1');
    expect(estimateLevel(walk(Array(12).fill(false)))).toBe('A2');
  });
  it('учение, который держит B2 и проваливает C1, получает B2', () => {
    // B1✓ B2✓ C1✗ B2✓ C1✗ B2✓ C1✗ B2✗ B1✓ B2✓ C1✗ B2✓
    expect(estimateLevel(walk([true, true, false, true, false, true, false, false, true, true, false, true]))).toBe('B2');
  });
  it('один случайный верный ответ на новом уровне не поднимает оценку', () => {
    // B1✓ B2✗ ×5, затем B1✓ B2✓ — на B2 один верный из шести
    expect(estimateLevel(walk([true, false, true, false, true, false, true, false, true, false, true, true]))).toBe('B1');
  });
  it('письмо и чтение в оценку адаптивной части не входят', () => {
    const list = [...walk(Array(12).fill(false)), { position: 13, level: 'C1' as Level, correct: 1 }, { position: 14, level: 'C1' as Level, correct: null }];
    expect(estimateLevel(list)).toBe('A2');
  });
  it('без ответов — A2', () => { expect(estimateLevel([])).toBe('A2'); });
});

describe('проверка ответа сравнением с эталоном', () => {
  it('выбор варианта: буква в любом регистре, иное — отказ по формату', () => {
    const it_ = makeItem('mcq', 'B1');
    expect(grade(it_, 'c')).toMatchObject({ ok: true, answer: 'C', correct: 1, score: 100, feedback: 'правило одной строкой' });
    expect(grade(it_, 'A')).toMatchObject({ ok: true, correct: 0, score: 0 });
    expect(grade(it_, '')).toEqual({ ok: false, reason: 'empty' });
    expect(grade(it_, 'the')).toEqual({ ok: false, reason: 'format' });
    expect(grade(it_, 'AB')).toEqual({ ok: false, reason: 'format' });
  });
  it('чтение: две буквы, верно только при обоих совпадениях, очки за каждый вопрос', () => {
    const it_ = makeItem('reading', 'B2');
    expect(grade(it_, ['B', 'C'])).toMatchObject({ ok: true, answer: 'B,C', correct: 1, score: 100 });
    expect(grade(it_, 'B,A')).toMatchObject({ ok: true, correct: 0, score: 50 });
    expect(grade(it_, ['B'])).toEqual({ ok: false, reason: 'format' });
    expect(grade(it_, ['', ''])).toEqual({ ok: false, reason: 'empty' });
  });
  it('исправление: совпадение без учёта регистра и знаков; неизменённое предложение — неверно', () => {
    const it_ = makeItem('correction', 'B1');
    expect(grade(it_, it_.answer.toUpperCase() + '.')).toMatchObject({ ok: true, correct: 1 });
    expect(grade(it_, it_.prompt)).toMatchObject({ ok: true, correct: 0 });
    expect(grade(it_, 'x')).toEqual({ ok: false, reason: 'format' });
  });
  it('письмо: принимается в границах по словам, не проверяется', () => {
    const it_ = makeItem('writing', 'B2');
    expect(grade(it_, SHORT)).toMatchObject({ ok: true, correct: null, score: null, feedback: null });
    expect(grade(it_, ESSAY)).toMatchObject({ ok: true });
    expect(grade(it_, 'Too short.')).toEqual({ ok: false, reason: 'too_short' });
    expect(grade(it_, Array(ANSWER_WORDS.max + 1).fill('word').join(' '))).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('что видит ученик', () => {
  it('в задании нет ключа, объяснения, рубрики и уровня', () => {
    for (const k of ['mcq', 'correction', 'reading', 'writing'] as Kind[]) {
      const t: any = testItem(makeItem(k, 'B2'), 'att1', 3);
      expect(t.attemptId).toBe('att1');
      expect(t.position).toBe(3);
      expect(t).not.toHaveProperty('answer');
      expect(t).not.toHaveProperty('explanation');
      expect(t).not.toHaveProperty('rubric');
      expect(t).not.toHaveProperty('level');
      if (k === 'reading') { expect(t.questions).toHaveLength(2); expect(t.questions[0]).not.toHaveProperty('answer'); }
      if (k === 'writing') expect(t.words).toEqual({ min: 60, max: 80 });
      if (k === 'mcq') expect(t.options).toHaveLength(4);
    }
  });
});

describe('выбор задания из банка', () => {
  it('берёт нужный уровень, не повторяет виденное и избегает недавних тем; при пустом уровне — соседний', async () => {
    const mem = sqlStore();
    const a = makeItem('mcq', 'B2', 'articles'), b = makeItem('mcq', 'B2', 'tenses'), c = makeItem('mcq', 'B1', 'passive');
    await mem.store.insertItems([a, b, c, makeItem('mcq', 'B2', 'modals', 'rejected')]);
    const pick = (lvl: Level, used: string[], recent: string[]) => pickItem(mem.store, 'mcq', lvl, new Set(used), recent, rng).then(i => i?.id ?? null);
    expect(['it' + a.id.slice(2), b.id]).toContain(await pick('B2', [], []));
    expect(await pick('B2', [a.id], [])).toBe(b.id);
    expect(await pick('B2', [], ['articles'])).toBe(b.id);
    expect(await pick('B2', [a.id, b.id], [])).toBe(c.id); // на B2 пусто — ступень ниже
    expect(await pick('C1', [], [])).not.toBeNull();        // на C1 пусто — соседний
    expect(await pick('B2', [a.id, b.id, c.id], [])).toBeNull();
  });
});

describe('ход теста целиком', () => {
  it('14 заданий: уровень ходит за ответами, после последнего тест завершён с уровнем', async () => {
    const mem = sqlStore(); mem.addUser('u1'); const items = await fillBank(mem); const store = ordered(mem);
    const ids = (() => { let n = 0; return () => `id${++n}`; })();
    const opts = { rng, id: ids, now: () => '2026-10-30T10:00:00Z', generate: false };
    let v = await startOrResume(ENV, store, 'u1', DOMAIN, opts);
    expect(v.status).toBe('active'); expect(v.total).toBe(14); expect(v.answered).toBe(0);
    expect(v.current?.kind).toBe('mcq'); expect(v.current?.position).toBe(1);
    expect(attemptRows(mem)[0].level).toBe('B1');

    // первые два верно → B2, C1; третье (исправление) неверно → B2
    const key = (attId: string) => { const [t] = mem.rows('SELECT item_id FROM attempts WHERE id = ?', attId); return items.find(i => i.id === t.itemId)!; };
    v = await answer(ENV, store, 'u1', v.current!.attemptId, key(v.current!.attemptId).answer, DOMAIN, opts);
    expect(attemptRows(mem)[1].level).toBe('B2');
    v = await answer(ENV, store, 'u1', v.current!.attemptId, 'C', DOMAIN, opts);
    expect(attemptRows(mem)[2].level).toBe('C1'); expect(v.current?.kind).toBe('correction');
    v = await answer(ENV, store, 'u1', v.current!.attemptId, 'This answer is wrong on purpose.', DOMAIN, opts);
    expect(attemptRows(mem)[3].level).toBe('B2'); expect(v.answered).toBe(3);

    // остальные адаптивные — всё верно
    while (v.answered < ADAPTIVE_COUNT) v = await answer(ENV, store, 'u1', v.current!.attemptId, key(v.current!.attemptId).answer, DOMAIN, opts);
    expect(v.current?.kind).toBe('reading'); expect(attemptRows(mem)[12].level).toBe('C1');
    v = await answer(ENV, store, 'u1', v.current!.attemptId, ['B', 'A'], DOMAIN, opts);
    expect(v.current?.kind).toBe('writing'); expect(v.current && 'words' in v.current).toBe(true);
    v = await answer(ENV, store, 'u1', v.current!.attemptId, SHORT, DOMAIN, opts);
    expect(v.status).toBe('finished'); expect(v.current).toBeNull(); expect(v.level).toBe('C1'); expect(v.levelLabel).toBe('продвинутый');
    expect(v.summary).toEqual({ adaptiveTotal: 12, adaptiveCorrect: 11, readingScore: 50, writingWords: 64 });
    expect(new Set(attemptRows(mem).map(a => a.itemId)).size).toBe(14); // ни одного повтора

    // повторный старт — новый тест, задания прежнего не показываются
    const again = await startOrResume(ENV, store, 'u1', DOMAIN, opts);
    expect(again.id).not.toBe(v.id); expect(again.answered).toBe(0);
    const all = attemptRows(mem); expect(all).toHaveLength(15);
    expect(all.slice(0, 14).map(a => a.itemId)).not.toContain(all[14].itemId);
  });

  it('прерывание и продолжение: повторный start возвращает то же задание, ответ на чужой attemptId отклоняется', async () => {
    const mem = sqlStore(); mem.addUser('u1'); await fillBank(mem);
    const opts = { rng, generate: false };
    const v1 = await startOrResume(ENV, mem.store, 'u1', DOMAIN, opts);
    const v2 = await startOrResume(ENV, mem.store, 'u1', DOMAIN, opts);
    expect(v2.id).toBe(v1.id); expect(v2.current?.attemptId).toBe(v1.current?.attemptId);
    expect(mem.rows('SELECT id FROM attempts')).toHaveLength(1);
    const state = await current(mem.store, 'u1');
    expect(state?.current?.attemptId).toBe(v1.current?.attemptId);
    await expect(answer(ENV, mem.store, 'u1', 'nope', 'A', DOMAIN, opts)).rejects.toMatchObject({ code: 'assessment_stale' });
    await expect(answer(ENV, mem.store, 'u1', v1.current!.attemptId, '', DOMAIN, opts)).rejects.toMatchObject({ code: 'answer_invalid', reason: 'empty' });
    expect(await abandon(mem.store, 'u1')).toBe(true);
    expect(await current(mem.store, 'u1')).toBeNull();
    await expect(answer(ENV, mem.store, 'u1', v1.current!.attemptId, 'A', DOMAIN, opts)).rejects.toBeInstanceOf(AssessmentError);
  });

  it('пустой банк без генерации — bank_empty; с генерацией — модель пишет задание через конвейер проверки', async () => {
    const mem = sqlStore(); mem.addUser('u1');
    await expect(startOrResume(ENV, mem.store, 'u1', DOMAIN, { generate: false })).rejects.toMatchObject({ code: 'bank_empty' });
    // генератор отдаёт один mcq, экзаменатор подтверждает
    const chatFn = async (_env: unknown, msgs: { content: string }[]) => {
      const user = msgs[msgs.length - 1].content;
      if (user.startsWith('Write ')) return JSON.stringify({ items: [{ prompt: 'We finished ___ energy audit last week.', options: ['a', 'an', 'the', '—'], answer: 'C', explanation: 'Аудит известен обеим сторонам — определённый артикль.' }] });
      return JSON.stringify({ answer: 'C', level: 'B1', issues: [] });
    };
    const v = await startOrResume(ENV, mem.store, 'u1', DOMAIN, { chatFn: chatFn as any, rng });
    expect(v.current?.kind).toBe('mcq');
    expect(mem.rows("SELECT id FROM items WHERE status = 'verified'")).toHaveLength(1);
  });
});

describe('API теста', () => {
  async function login() {
    const mem = sqlStore(); await fillBank(mem);
    const env = { ...ENV, DB: mem.DB, DEV_ECHO_CODE: '1' } as Env;
    const app = createApp('test');
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@x.kz' })).json();
    const r2 = await post('/auth/verify', { email: 'y@x.kz', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { mem, call: (p: string, init: RequestInit = {}) => call(p, { ...init, headers: { cookie, ...(init.headers as any) } }), post: (p: string, b: unknown) => post(p, b, { cookie }) };
  }

  it('без входа — 401', async () => {
    const app = createApp('test');
    const env = { ...ENV, DB: sqlStore().DB } as Env;
    expect((await app.request('https://offerly.test/api/assessment', {}, env)).status).toBe(401);
    expect((await app.request('https://offerly.test/api/assessment/start', { method: 'POST' }, env)).status).toBe(401);
  });

  it('start → answer ×14 → finished; состояние по GET; ключи наружу не уходят', async () => {
    const { mem, call, post } = await login();
    expect(((await (await call('/assessment')).json()) as any).assessment).toBeNull();
    let r: any = await (await post('/assessment/start', {})).json();
    expect(r.ok).toBe(true); expect(r.assessment.current.position).toBe(1);
    expect(JSON.stringify(r.assessment)).not.toContain('"answer"');
    const g: any = await (await call('/assessment')).json();
    expect(g.total).toBe(14); expect(g.assessment.current.attemptId).toBe(r.assessment.current.attemptId);

    const bad = await post('/assessment/answer', { attemptId: 'x', answer: 'A' });
    expect(bad.status).toBe(409); expect(((await bad.json()) as any).error).toBe('assessment_stale');
    const empty = await post('/assessment/answer', { attemptId: r.assessment.current.attemptId, answer: '' });
    expect(empty.status).toBe(400); expect(await empty.json()).toMatchObject({ error: 'answer_invalid', reason: 'empty' });

    for (let i = 0; i < TOTAL; i++) {
      const cur = r.assessment.current;
      const ans = cur.kind === 'mcq' ? 'B' : cur.kind === 'reading' ? ['B', 'C'] : cur.kind === 'correction' ? 'Wrong fix.' : SHORT;
      const res = await post('/assessment/answer', { attemptId: cur.attemptId, answer: ans });
      expect(res.status).toBe(200);
      r = await res.json();
    }
    expect(r.assessment.status).toBe('finished'); expect(r.assessment.level).toBe('A2');
    expect(r.assessment.summary).toMatchObject({ adaptiveTotal: 12, adaptiveCorrect: 0, readingScore: 100 });
    const [uid] = mem.rows('SELECT id FROM users');
    expect(mem.rows('SELECT status FROM assessments WHERE user_id = ?', uid.id)).toEqual([{ status: 'finished' }]);
    const after = await post('/assessment/answer', { attemptId: 'x', answer: 'A' });
    expect(after.status).toBe(404);
    expect(((await (await call('/assessment')).json()) as any).assessment.level).toBe('A2');
  });

  it('abandon закрывает активный тест, повторный — false', async () => {
    const { post } = await login();
    await post('/assessment/start', {});
    expect(await (await post('/assessment/abandon', {})).json()).toEqual({ ok: true, abandoned: true });
    expect(await (await post('/assessment/abandon', {})).json()).toEqual({ ok: true, abandoned: false });
  });
});
