import { describe, it, expect } from 'vitest';
import {
  normalizeItem, normalizeBatch, answerLetter, fingerprintOf, judge, normalizeCheck, generateItems, generationPrompt, generationSchema,
  checkPrompt, parseGenerateBody, domainText, topicById, TOPICS, LEVELS, KINDS, type Check, type Topic,
} from '../functions/_lib/items';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';

const ARTICLES = topicById('articles')!;
const DOMAIN = { specialty: 'инженер-теплоэнергетик', industry: 'энергетика', targetRole: 'эксперт по оценке ответов ИИ', keywords: ['boiler efficiency', 'energy audit'] };
const CTX = { kind: 'mcq' as const, level: 'B1' as const, topic: 'articles', domain: domainText(DOMAIN) };

const MCQ = { prompt: 'We finished ___ energy audit of the boiler house last week.', options: ['a', 'an', 'the', '—'], answer: 'C', explanation: 'Аудит уже известен обеим сторонам — нужен определённый артикль.' };
const CORR = { prompt: 'The turbine have been inspected twice since the last overhaul.', answer: 'The turbine has been inspected twice since the last overhaul.', explanation: 'Подлежащее в единственном числе — has.' };
const PASSAGE = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} of the report says the boiler efficiency fell after the retrofit.`).join(' ');
const READING = {
  prompt: PASSAGE, explanation: 'Отчёт о падении КПД котла после реконструкции.',
  questions: [
    { question: 'What does the report mainly say?', options: ['Efficiency rose', 'Efficiency fell', 'Nothing changed', 'The boiler was replaced'], answer: 'B' },
    { question: 'What does the author imply about the retrofit?', options: ['It succeeded', 'It was free', 'It did not help', 'It was postponed'], answer: 'C' },
  ],
};
const MODEL_ANSWER = Array.from({ length: 9 }, () => 'The boiler efficiency test shows a small loss.').join(' '); // 72 слова
const WRITING = {
  prompt: 'Write a short reply to a reviewer who says your heat-loss calculation ignores stack losses. Explain your method in 60–80 words.',
  rubric: ['Отвечает на замечание прямо', 'Объясняет метод без лишних деталей', 'Нейтральный профессиональный тон'], answer: MODEL_ANSWER, explanation: 'Образец отвечает на замечание по существу.',
};

describe('нормализация заданий', () => {
  it('принимает корректный mcq и считает отпечаток по формулировке', () => {
    const n = normalizeItem(MCQ, CTX);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.item.answer).toBe('C');
    expect(n.item.options).toEqual(['a', 'an', 'the', '—']);
    expect(n.item.fingerprint).toBe(fingerprintOf(MCQ.prompt));
    expect(n.item.domain).toContain('инженер-теплоэнергетик');
  });
  it('ключ принимает букву с точкой или текст варианта', () => {
    expect(answerLetter('b)', ['x', 'y', 'z', 'w'])).toBe('B');
    expect(answerLetter('the', ['a', 'an', 'the', '—'])).toBe('C');
    expect(answerLetter('E', ['a', 'b', 'c', 'd'])).toBeNull();
    expect(normalizeItem({ ...MCQ, options: ['A. a', 'B. an', 'C. the', 'D. —'], answer: 'the' }, CTX)).toMatchObject({ ok: true, item: { answer: 'C' } });
  });
  it('отклоняет mcq без пропуска, с тремя вариантами, с повторами и без объяснения', () => {
    expect(normalizeItem({ ...MCQ, prompt: 'We finished the energy audit last week.' }, CTX)).toMatchObject({ ok: false, reason: expect.stringContaining('пропуска') });
    expect(normalizeItem({ ...MCQ, options: ['a', 'an', 'the'] }, CTX)).toMatchObject({ ok: false, reason: expect.stringContaining('четыре') });
    expect(normalizeItem({ ...MCQ, options: ['a', 'a', 'the', '—'] }, CTX)).toMatchObject({ ok: false });
    expect(normalizeItem({ ...MCQ, explanation: '' }, CTX)).toMatchObject({ ok: false, reason: 'нет объяснения' });
    expect(normalizeItem({ ...MCQ, explanation: 'The definite article is needed here.' }, CTX)).toMatchObject({ ok: false, reason: 'объяснение не по-русски' });
    expect(normalizeItem({ ...MCQ, prompt: 'Мы закончили ___ аудит.' }, CTX)).toMatchObject({ ok: false });
    expect(normalizeItem(null, CTX)).toMatchObject({ ok: false });
  });
  it('correction: исправление должно отличаться от исходного предложения', () => {
    const ctx = { ...CTX, kind: 'correction' as const };
    expect(normalizeItem(CORR, ctx)).toMatchObject({ ok: true, item: { answer: CORR.answer } });
    expect(normalizeItem({ ...CORR, answer: CORR.prompt }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('совпадает') });
    expect(normalizeItem({ ...CORR, prompt: 'Short one.' }, ctx)).toMatchObject({ ok: false });
  });
  it('reading: текст 60–220 слов и ровно два вопроса, ключ — две буквы', () => {
    const ctx = { ...CTX, kind: 'reading' as const };
    const n = normalizeItem(READING, ctx);
    expect(n).toMatchObject({ ok: true, item: { answer: 'B,C' } });
    expect(normalizeItem({ ...READING, prompt: 'Too short passage about boilers.' }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('слов') });
    expect(normalizeItem({ ...READING, questions: [READING.questions[0]] }, ctx)).toMatchObject({ ok: false, reason: 'нужно ровно два вопроса' });
    expect(normalizeItem({ ...READING, questions: [READING.questions[0], { ...READING.questions[1], answer: 'Z' }] }, ctx)).toMatchObject({ ok: false });
  });
  it('writing: рубрика 3–5 критериев по-русски, образец 50–100 слов', () => {
    const ctx = { ...CTX, kind: 'writing' as const };
    expect(normalizeItem(WRITING, ctx)).toMatchObject({ ok: true, item: { rubric: WRITING.rubric } });
    expect(normalizeItem({ ...WRITING, rubric: ['один', 'два'] }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('3–5') });
    expect(normalizeItem({ ...WRITING, rubric: ['Answers directly', 'Explains', 'Neutral tone'] }, ctx)).toMatchObject({ ok: false, reason: 'рубрика не по-русски' });
    expect(normalizeItem({ ...WRITING, answer: 'Too short.' }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('образец') });
  });
  it('normalizeBatch отбрасывает дубли внутри ответа и против банка', () => {
    const r = normalizeBatch({ items: [MCQ, { ...MCQ, prompt: MCQ.prompt.toUpperCase() }, { ...MCQ, prompt: 'They installed ___ new turbine in 2019.' }, { bad: true }] }, CTX, new Set([fingerprintOf('They installed ___ new turbine in 2019.')]));
    expect(r.items).toHaveLength(1);
    expect(r.rejected).toEqual(['дубль уже имеющегося задания', 'дубль уже имеющегося задания', 'формулировка пустая или не по-английски']);
  });
});

describe('второй прогон', () => {
  const mcq = (normalizeItem(MCQ, CTX) as any).item;
  const check = (c: Partial<Check>): Check => ({ answer: 'C', level: 'B1', issues: [], ...c });

  it('ключ совпал, уровень совпал — verified', () => {
    expect(judge(mcq, check({}))).toEqual({ status: 'verified', note: 'ключ и уровень подтверждены', checkedLevel: 'B1' });
  });
  it('уровень на одну ступень в сторону — verified с заметкой; на две — rejected', () => {
    expect(judge(mcq, check({ level: 'B2' }))).toMatchObject({ status: 'verified', note: 'экзаменатор видит уровень B2', checkedLevel: 'B2' });
    expect(judge(mcq, check({ level: 'C1' }))).toMatchObject({ status: 'rejected', note: expect.stringContaining('C1 при заявленном B1') });
  });
  it('экзаменатор выбрал другой вариант или нашёл изъян — rejected', () => {
    expect(judge(mcq, check({ answer: 'A' }))).toMatchObject({ status: 'rejected', note: 'ключ C не совпал с решением экзаменатора A' });
    expect(judge(mcq, check({ issues: ['options A and C are both acceptable'] }))).toMatchObject({ status: 'rejected', note: 'options A and C are both acceptable' });
    expect(judge(mcq, null)).toMatchObject({ status: 'rejected' });
  });
  it('reading сравнивает обе буквы; correction допускает иное исправление без изъянов', () => {
    const rd = (normalizeItem(READING, { ...CTX, kind: 'reading' }) as any).item;
    expect(judge(rd, check({ answer: 'B, C' }))).toMatchObject({ status: 'verified' });
    expect(judge(rd, check({ answer: 'B,D' }))).toMatchObject({ status: 'rejected', note: 'ключ BC не совпал с решением экзаменатора BD' });
    const cr = (normalizeItem(CORR, { ...CTX, kind: 'correction' }) as any).item;
    expect(judge(cr, check({ answer: 'The turbine has been inspected twice since the last overhaul' }))).toMatchObject({ status: 'verified', note: 'ключ и уровень подтверждены' });
    expect(judge(cr, check({ answer: 'The turbine was inspected twice.' }))).toMatchObject({ status: 'verified', note: expect.stringContaining('исправил иначе') });
    expect(judge(cr, check({ answer: 'x', issues: ['the sentence has two errors'] }))).toMatchObject({ status: 'rejected' });
  });
  it('normalizeCheck приводит уровень и список изъянов', () => {
    expect(normalizeCheck({ answer: 'c', level: 'b1 ', issues: ['', ' ok '] })).toEqual({ answer: 'c', level: 'B1', issues: ['ok'] });
    expect(normalizeCheck({ answer: 'c', level: 'native' })).toEqual({ answer: 'c', level: null, issues: [] });
    expect(normalizeCheck('nope')).toBeNull();
  });
  it('запросы к моделям: генератор без ключей в схеме лишнего, экзаменатор для mcq не видит ключ', () => {
    const gen = generationPrompt({ kind: 'mcq', level: 'B1', topic: ARTICLES, count: 4, domain: DOMAIN });
    expect(gen[0].content).toContain('инженер-теплоэнергетик');
    expect(gen[0].content).toContain('boiler efficiency');
    expect(gen[0].content).toContain('exactly 4 items');
    expect((generationSchema('reading') as any).properties.items.items.required).toEqual(['prompt', 'questions', 'explanation']);
    const chk = checkPrompt(mcq, ARTICLES)[1].content;
    expect(chk).toContain('C. the');
    expect(chk).not.toContain('"answer": "C"');
    expect(checkPrompt((normalizeItem(CORR, { ...CTX, kind: 'correction' }) as any).item, ARTICLES)[1].content).toContain('PROPOSED CORRECTION');
  });
});

describe('справочник и тело запроса', () => {
  it('темы, уровни и виды', () => {
    expect(LEVELS).toEqual(['A2', 'B1', 'B2', 'C1']);
    expect(KINDS).toEqual(['mcq', 'correction', 'reading', 'writing']);
    expect(TOPICS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TOPICS.map(t => t.id)).size).toBe(TOPICS.length);
    expect(domainText({ specialty: null, industry: null, targetRole: null, keywords: [] })).toContain('professional');
  });
  it('parseGenerateBody', () => {
    expect(parseGenerateBody({ kind: 'mcq', level: 'B1', topic: 'articles' })).toMatchObject({ ok: true, count: 4 });
    expect(parseGenerateBody({ kind: 'mcq', level: 'B1', topic: 'articles', count: '6' })).toMatchObject({ ok: true, count: 6 });
    expect(parseGenerateBody({ kind: 'mcq', level: 'B1', topic: 'articles', count: 7 })).toEqual({ ok: false, field: 'count' });
    expect(parseGenerateBody({ kind: 'essay', level: 'B1', topic: 'articles' })).toEqual({ ok: false, field: 'kind' });
    expect(parseGenerateBody({ kind: 'mcq', level: 'A1', topic: 'articles' })).toEqual({ ok: false, field: 'level' });
    expect(parseGenerateBody({ kind: 'mcq', level: 'B1', topic: 'cooking' })).toEqual({ ok: false, field: 'topic' });
  });
});

/** Подменная модель: первый вызов — генератор, остальные — экзаменатор. Ответы экзаменатора задаются по подстроке запроса. */
function fakeChat(generated: unknown, examiner: (userPrompt: string) => unknown) {
  const calls: string[] = [];
  const fn = async (_env: unknown, messages: { role: string; content: string }[]) => {
    const user = messages[messages.length - 1].content;
    calls.push(user);
    if (user.startsWith('Write ')) return JSON.stringify(generated);
    return JSON.stringify(examiner(user));
  };
  return { fn, calls };
}

describe('generateItems', () => {
  const env = {} as any;
  const req = { kind: 'mcq' as const, level: 'B1' as const, topic: ARTICLES, count: 3, domain: DOMAIN };
  const MCQ2 = { ...MCQ, prompt: 'She works as ___ engineer at a combined heat and power plant.', options: ['a', 'an', 'the', '—'], answer: 'B' };
  const MCQ3 = { ...MCQ, prompt: 'We measured ___ pressure in the main steam line.', options: ['a', 'an', 'the', '—'], answer: 'C' };

  it('проверяет каждое задание, пишет verified и rejected, дубли отбрасывает до проверки', async () => {
    const { store, items } = memoryStore();
    let n = 0;
    const { fn, calls } = fakeChat({ items: [MCQ, MCQ2, MCQ3, { ...MCQ, prompt: MCQ.prompt + ' ' }] }, (u) =>
      u.includes('She works as') ? { answer: 'A', level: 'B1', issues: [] } : { answer: 'C', level: 'B1', issues: [] });
    const r = await generateItems(env, store, req, { chatFn: fn as any, now: () => '2026-10-30T10:00:00Z', id: () => `id-${++n}` });
    expect(calls).toHaveLength(1 + 3); // генератор + три экзаменатора (дубль не проверялся)
    expect(r.dropped).toEqual(['дубль уже имеющегося задания']);
    expect(r.items.map(i => i.status)).toEqual(['verified', 'rejected', 'verified']);
    expect(r.items[1].checkNote).toBe('ключ B не совпал с решением экзаменатора A');
    expect(r.items[0]).toMatchObject({ id: 'id-1', verifiedAt: '2026-10-30T10:00:00Z', source: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', topic: 'articles' });
    expect(items).toHaveLength(3);
    expect(await store.bankStats()).toEqual(expect.arrayContaining([{ level: 'B1', kind: 'mcq', status: 'verified', count: 2 }, { level: 'B1', kind: 'mcq', status: 'rejected', count: 1 }]));

    // повторная генерация тех же заданий — всё дубли, экзаменатор не вызывается, в банк ничего не пишется
    const again = await generateItems(env, store, req, { chatFn: fn as any });
    expect(again.items).toHaveLength(0);
    expect(again.dropped).toEqual(['дубль уже имеющегося задания', 'дубль уже имеющегося задания', 'дубль уже имеющегося задания', 'дубль уже имеющегося задания']);
    expect(calls).toHaveLength(5);
  });
  it('сбой экзаменатора — задание отклоняется с причиной, остальное не падает', async () => {
    const { store } = memoryStore();
    let k = 0;
    const fn = async (_e: unknown, m: { content: string }[]) => {
      if (m[m.length - 1].content.startsWith('Write ')) return JSON.stringify({ items: [MCQ] });
      k++; throw new Error('AI 429');
    };
    const r = await generateItems(env, store, req, { chatFn: fn as any });
    expect(k).toBe(1);
    expect(r.items[0]).toMatchObject({ status: 'rejected', checkNote: 'проверка не выполнена: AI 429' });
  });
  it('генератор вернул не JSON — ошибка с началом ответа', async () => {
    const { store } = memoryStore();
    await expect(generateItems(env, store, req, { chatFn: (async () => 'Sure! Here are the items...') as any })).rejects.toThrow(/генератор не вернул JSON.*Sure!/);
  });
});

describe('API банка', () => {
  function makeApp(examiner: (u: string) => unknown = () => ({ answer: 'C', level: 'B1', issues: [] })) {
    const mem = memoryStore();
    const ai = { run: async (_m: string, input: any) => {
      const user = input.messages[input.messages.length - 1].content as string;
      if (user.startsWith('Write ')) return { response: JSON.stringify({ items: [MCQ] }) };
      if (user.startsWith('RÉSUMÉ')) return { response: JSON.stringify({ specialty: 'инженер', industry: 'энергетика', years: 15, keywords: ['boiler'], summary: 'Вы инженер.' }) };
      return { response: JSON.stringify(examiner(user)) };
    } };
    const env = { DB: null, AI: ai, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
      call(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { mem, call, send };
  }
  async function signIn(send: ReturnType<typeof makeApp>['send']) {
    const email = 'yuriy@example.com';
    const j1: any = await (await send('POST', '/auth/request', { email })).json();
    const r2 = await send('POST', '/auth/verify', { email, code: j1.code });
    return r2.headers.get('set-cookie')!.split(';')[0];
  }

  it('справочник открыт, остальное — только с сессией', async () => {
    const { call, send } = makeApp();
    const t: any = await (await call('/items/topics')).json();
    expect(t.levels).toEqual(['A2', 'B1', 'B2', 'C1']);
    expect(t.topics.find((x: Topic) => x.id === 'register')?.label).toBe('Регистр рецензента');
    expect(t.kinds).toContainEqual({ id: 'writing', label: 'письмо 60–80 слов' });
    expect((await call('/items/stats')).status).toBe(401);
    expect((await call('/items/bank')).status).toBe(401);
    expect((await send('POST', '/items/generate', { kind: 'mcq', level: 'B1', topic: 'articles' })).status).toBe(401);
  });
  it('генерация с проверкой, сводка и список с фильтрами', async () => {
    const { call, send } = makeApp();
    const cookie = await signIn(send);
    expect(await (await send('POST', '/items/generate', { kind: 'mcq', level: 'B1', topic: 'nope' }, { cookie })).json()).toEqual({ ok: false, error: 'items_invalid', field: 'topic' });

    const r: any = await (await send('POST', '/items/generate', { kind: 'mcq', level: 'B1', topic: 'articles', count: 1 }, { cookie })).json();
    expect(r).toMatchObject({ ok: true, requested: 1, verified: 1, rejected: 0, dropped: [] });
    expect(r.items[0]).toMatchObject({ status: 'verified', topicLabel: 'Артикли', answer: 'C', checkNote: 'ключ и уровень подтверждены' });
    expect(r.items[0].domain).toContain('professional'); // профиля ещё нет — общий домен

    const s: any = await (await call('/items/stats', { headers: { cookie } })).json();
    expect(s.stats).toEqual([{ level: 'B1', kind: 'mcq', status: 'verified', count: 1 }]);

    const list: any = await (await call('/items/bank?level=B1&status=verified', { headers: { cookie } })).json();
    expect(list.items).toHaveLength(1);
    const none: any = await (await call('/items/bank?level=C1', { headers: { cookie } })).json();
    expect(none.items).toHaveLength(0);
    expect((await call('/items/bank?level=A1', { headers: { cookie } })).status).toBe(400);
  });
  it('домен берётся из профиля резюме; отклонённые задания видны со статусом', async () => {
    const { call, send } = makeApp(() => ({ answer: 'A', level: 'B1', issues: [] }));
    const cookie = await signIn(send);
    await send('POST', '/resume', { text: 'x'.repeat(250) }, { cookie });
    const r: any = await (await send('POST', '/items/generate', { kind: 'mcq', level: 'B1', topic: 'articles', count: 1 }, { cookie })).json();
    expect(r).toMatchObject({ ok: true, verified: 0, rejected: 1 });
    expect(r.items[0].domain).toContain('инженер, энергетика');
    const list: any = await (await call('/items/bank?status=rejected', { headers: { cookie } })).json();
    expect(list.items[0].checkNote).toContain('не совпал');
  });
});
