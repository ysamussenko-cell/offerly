import { describe, it, expect } from 'vitest';
import {
  CARD_TOPICS, WRITING_CARDS_MAX, draftFromItem, draftsFromWriting, createCards, reviewPatch, publicCard, dueForReview, d1CardStore, type ErrorCard,
} from '../functions/_lib/cards';
import { RETIRE_AFTER, MIN_INTERVAL } from '../functions/_lib/fsrs';
import { normalizeWritingEval, WRITING_EVAL_SCHEMA, writingPrompt } from '../functions/_lib/scoring';
import { score, startOrResume, answer, rescore, attemptOrigin, CARD_SOURCE as TEST_SOURCE, type Assessment } from '../functions/_lib/assessment';
import { createApp, type Env } from '../functions/_lib/app';
import { LEVELS, type Item } from '../functions/_lib/items';
import { memoryStore } from './helpers/memoryStore';
import { freshDb, d1Of } from './helpers/sqliteD1';
import { makeItem } from './assessment.test';

const USER = 'u1';
const TODAY = '2026-11-02';
const NOW = '2026-11-02T03:00:00.000Z';
const ENV = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly' } as unknown as Env;
let seq = 0;
const nextId = () => `card${++seq}`;
const opts = { now: () => NOW, id: nextId };

const card = (over: Partial<ErrorCard> = {}): ErrorCard => ({
  id: `c${++seq}`, userId: USER, topic: 'tenses', rule: 'правило', example: 'We have measured it yesterday.', correction: 'We measured it yesterday.', source: 'seed', origin: null,
  stability: 1, difficulty: 5, due: TODAY, reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired: false, createdAt: NOW, ...over,
});
const mcq = (over: Partial<Item> = {}): Item => ({ ...makeItem('mcq', 'B1', 'articles'), ...over });
const correction = (over: Partial<Item> = {}): Item => ({ ...makeItem('correction', 'B1', 'tenses'), ...over });

describe('заготовки карточек из ошибок', () => {
  it('выбор варианта: предложение с выбранным словом и с верным; верный или нечитаемый ответ — нет карточки', () => {
    const it = mcq();
    const d = draftFromItem(it, 'A', 'attempt:a1')!;
    expect(d).toMatchObject({ topic: 'articles', rule: 'правило одной строкой', origin: 'attempt:a1' });
    expect(d.example).toContain(' a energy audit'); expect(d.correction).toContain(' the energy audit');
    expect(draftFromItem(it, 'C', 'x')).toBeNull(); // выбран верный
    expect(draftFromItem(it, null, 'x')).toBeNull();
    expect(draftFromItem(it, 'Z', 'x')).toBeNull();
    expect(draftFromItem(mcq({ prompt: 'no blank here' }), 'A', 'x')).toBeNull();
  });
  it('исправление: карточка — исходное предложение с ошибкой и эталон, что бы ни написал ученик; чтение и письмо — нет', () => {
    const it = correction();
    expect(draftFromItem(it, 'garbage answer', 'step:s1')).toEqual({ topic: 'tenses', rule: 'правило одной строкой', example: it.prompt, correction: it.answer, origin: 'step:s1' });
    expect(draftFromItem(makeItem('reading', 'B1'), 'A,B', 'x')).toBeNull();
    expect(draftFromItem(makeItem('writing', 'B1'), 'text', 'x')).toBeNull();
    expect(draftFromItem(correction({ topic: 'task-response' }), 'a', 'x')).toBeNull(); // не тема банка
  });
  it('письмо: тема от экзаменатора, без неё — тема занятия, без обеих — пропуск; не больше WRITING_CARDS_MAX; ключи с номером ошибки', () => {
    const errors = [
      { original: 'the losses is', corrected: 'the losses are', note: 'Согласование', topic: 'tenses' },
      { original: 'Please tell me', corrected: 'Please let me know', note: 'Формула вежливости', topic: null },
      { original: 'in the report', corrected: 'on the report', note: 'Предлог', topic: 'nonsense' },
      { original: 'x y', corrected: 'y x', note: 'Четвёртая', topic: 'spelling' },
    ];
    const d = draftsFromWriting(errors, 'step:s7', 'register');
    expect(d).toHaveLength(WRITING_CARDS_MAX);
    expect(d.map(x => x.topic)).toEqual(['tenses', 'register', 'register']);
    expect(d.map(x => x.origin)).toEqual(['step:s7:w1', 'step:s7:w2', 'step:s7:w3']);
    expect(d[0]).toMatchObject({ rule: 'Согласование', example: 'the losses is', correction: 'the losses are' });
    expect(draftsFromWriting(errors, 'a', null).map(x => x.origin)).toEqual(['a:w1', 'a:w4']); // без темы занятия остаются только ошибки с темой
    expect(draftsFromWriting(errors, 'a', 'mixed')).toHaveLength(2); // «смешанное повторение» — не тема карточек
  });
  it('экзаменатор получает справочник тем и возвращает тему ошибки; незнакомая тема — null', () => {
    const item = makeItem('writing', 'B1');
    const sys = writingPrompt(item, 'text').find(m => m.role === 'system')!.content;
    for (const t of CARD_TOPICS) expect(sys).toContain(t.id);
    const errSchema = (WRITING_EVAL_SCHEMA.properties.errors.items as any);
    expect(errSchema.properties.topic.enum).toEqual(CARD_TOPICS.map(t => t.id));
    expect(errSchema.required).toContain('topic');
    const text = 'The losses is high and the pump are old.';
    const n = normalizeWritingEval({ grammar: 40, vocabulary: 40, coherence: 40, task_response: 40, level: 'B1', summary: 's', rewrite: '', errors: [
      { original: 'losses is', corrected: 'losses are', note: 'n', topic: 'Tenses' }, { original: 'pump are', corrected: 'pumps are', note: 'n', topic: 'whatever' },
    ] }, text)!;
    expect(n.errors.map(e => e.topic)).toEqual(['tenses', null]);
  });
});

describe('создание карточек', () => {
  it('новые карточки со сроком на завтра; та же ошибка у активной карточки — пропуск; у погашенной — возврат в оборот; повторный источник — пропуск', async () => {
    const mem = memoryStore();
    mem.cards.push(card({ id: 'active', example: 'Less boilers were inspected.', correction: 'Fewer boilers were inspected.' }));
    mem.cards.push(card({ id: 'gone', example: 'I suggest to replace the burner.', correction: 'I suggest replacing the burner.', retired: true, streak: 3, reps: 3, due: null }));
    const drafts = [
      { topic: 'quantifiers', rule: 'r1', example: 'LESS boilers were inspected!', correction: 'Fewer boilers were inspected.', origin: 'step:1' },
      { topic: 'verb-patterns', rule: 'r2', example: 'I suggest to replace the burner', correction: 'I suggest replacing the burner.', origin: 'step:2' },
      { topic: 'articles', rule: 'r3', example: 'Efficiency of boiler was low.', correction: 'The efficiency of the boiler was low.', origin: 'step:3' },
      { topic: 'articles', rule: 'r3', example: 'efficiency of boiler was low', correction: 'The efficiency of the boiler was low.', origin: 'step:4' }, // дубль по тексту внутри одной партии
      { topic: 'spelling', rule: 'r4', example: 'Same text.', correction: 'Same text.', origin: 'step:5' }, // как написано = как надо
    ];
    const r = await createCards(mem.store, USER, drafts, TODAY, 'lesson', opts);
    expect(r.created.map(c => c.origin)).toEqual(['step:3']);
    expect(r.revived.map(c => c.id)).toEqual(['gone']);
    expect(r.skipped).toBe(3);
    expect(mem.cards).toHaveLength(3);
    expect(mem.cards.find(c => c.id === 'gone')).toMatchObject({ retired: false, streak: 0, lapses: 1, reps: 3, due: '2026-11-03' });
    const made = mem.cards.find(c => c.origin === 'step:3')!;
    expect(made).toMatchObject({ userId: USER, topic: 'articles', rule: 'r3', source: 'lesson', stability: 1, difficulty: 5, reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired: false, due: '2026-11-03', createdAt: NOW });
    expect(dueForReview(made, TODAY)).toBe(false); expect(dueForReview(made, '2026-11-03')).toBe(true);
    // тот же источник второй раз (пересчёт) — ничего не добавляет
    const again = await createCards(mem.store, USER, [drafts[2]], TODAY, 'lesson', opts);
    expect(again).toMatchObject({ created: [], revived: [], skipped: 1 });
    expect(await createCards(mem.store, USER, [], TODAY, 'lesson', opts)).toEqual({ created: [], revived: [], skipped: 0 });
  });
  it('итог повтора и публичная карточка: сколько верных осталось до гашения', () => {
    const c = card();
    const p = reviewPatch(c, true, TODAY);
    expect(p).toMatchObject({ reps: 1, streak: 1, reviewedAt: TODAY, retired: false, due: '2026-11-06' });
    expect(publicCard({ ...c, ...p } as ErrorCard)).toMatchObject({ streak: 1, left: RETIRE_AFTER - 1, retired: false, reviewedAt: TODAY });
    expect(publicCard(card({ retired: true, streak: 3 })).left).toBe(0);
    expect(reviewPatch(c, false, TODAY)).toMatchObject({ lapses: 1, streak: 0, due: `2026-11-0${2 + MIN_INTERVAL}` });
  });
});

describe('карточки из ошибок теста', () => {
  const DOMAIN = { specialty: null, industry: null, targetRole: null, keywords: [] };
  const TEXT = Array.from({ length: 8 }, () => 'The boiler efficiency test shows a small loss.').join(' ');
  const EVAL = { grammar: 55, vocabulary: 60, coherence: 60, task_response: 60, level: 'B2', summary: 'Коротко.', errors: [
    { original: 'shows a small loss', corrected: 'showed a small loss', note: 'Прошедшее время', topic: 'tenses' },
    { original: 'The boiler efficiency test', corrected: 'The boiler-efficiency test', note: 'Дефис', topic: null },
  ], rewrite: TEXT.replace(/shows/g, 'showed') };
  function bank(mem: ReturnType<typeof memoryStore>) {
    for (const l of LEVELS) { for (let i = 0; i < 3; i++) { mem.items.push(makeItem('mcq', l, 'articles')); mem.items.push(makeItem('correction', l, 'tenses')); } mem.items.push(makeItem('reading', l)); mem.items.push(makeItem('writing', l)); }
  }
  const key = (mem: ReturnType<typeof memoryStore>, attId: string) => { const t = mem.attempts.find(x => x.id === attId)!; return mem.items.find(i => i.id === t.itemId)!; };

  it('после теста неверные ответы и ошибки письма с темой становятся карточками; пересчёт не дублирует', async () => {
    const mem = memoryStore(); bank(mem);
    const o = { rng: () => 0, generate: false, chatFn: (async () => JSON.stringify(EVAL)) as any, now: () => NOW, id: nextId };
    let v = await startOrResume(ENV, mem.store, USER, DOMAIN, o);
    let wrong = 0;
    while (v.status === 'active') {
      const cur = v.current!;
      // первое исправление и первый выбор варианта — неверно, чтение — неверно, остальное верно
      let ans: unknown;
      if (cur.kind === 'reading') ans = ['A', 'A'];
      else if (cur.kind === 'writing') ans = TEXT;
      else if (wrong < 2 && (cur.position === 1 || cur.position === 3)) { wrong++; ans = cur.kind === 'mcq' ? 'A' : 'This answer is wrong on purpose.'; }
      else ans = key(mem, cur.attemptId).answer;
      v = await answer(ENV, mem.store, USER, cur.attemptId, ans, DOMAIN, o);
    }
    expect(v.status).toBe('finished');
    const cards = mem.cards.filter(c => c.userId === USER);
    expect(cards).toHaveLength(3); // mcq, исправление, одна ошибка письма с темой (чтение карточек не даёт)
    expect(cards.map(c => c.source)).toEqual([TEST_SOURCE, TEST_SOURCE, TEST_SOURCE]);
    const m = cards.find(c => c.topic === 'articles')!, cr = cards.find(c => c.topic === 'tenses' && c.origin!.indexOf(':w') < 0)!, w = cards.find(c => c.origin!.endsWith(':w1'))!;
    expect(m.origin).toBe(attemptOrigin(mem.attempts[0].id)); expect(m.example).toContain(' a energy audit');
    expect(cr.example).toBe(mem.items.find(i => i.id === mem.attempts[2].itemId)!.prompt);
    expect(w).toMatchObject({ topic: 'tenses', example: 'shows a small loss', correction: 'showed a small loss', rule: 'Прошедшее время', due: '2026-11-03' });
    // пересчёт письма заново — те же источники, карточек не прибавилось
    await rescore(ENV, mem.store, USER, o, true);
    expect(mem.cards).toHaveLength(3);
  });
  it('score без хранилища карточек работает как раньше', async () => {
    const mem = memoryStore();
    const a: Assessment = { id: 'a1', userId: USER, kind: 'placement', status: 'finished', startedAt: NOW, finishedAt: NOW, level: 'B1', currentLevel: 'B1', updatedAt: NOW, axes: null, overall: null, scoredAt: null, scoringNote: null };
    mem.assessments.push(a);
    const { insertCards, ...rest } = mem.store;
    const r = await score(ENV, rest as any, a, [], { now: () => NOW });
    expect(r.scoringNote).toBe('письмо не сдано'); expect(mem.cards).toHaveLength(0);
  });
});

describe('хранилище D1 карточек (node:sqlite с миграциями)', () => {
  it('вставка с пропуском дублей по id и источнику, новые колонки читаются и пишутся', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email) VALUES ('${USER}', 'a@b.cc')`);
    const store = d1CardStore(d1Of(db));
    const c1 = card({ id: 'k1', origin: 'step:1' }), c2 = card({ id: 'k2', origin: 'step:2', example: 'Other sentence here.', correction: 'Another sentence here.' });
    expect(await store.insertCards([c1, c2])).toBe(2);
    expect(await store.insertCards([{ ...c1, id: 'k3' }, { ...c2 }, card({ id: 'k4', origin: null })])).toBe(1); // тот же источник, тот же id — пропуск; без источника — вставка
    expect(await store.insertCards([])).toBe(0);
    const got = await store.getCard('k1');
    expect(got).toEqual(c1);
    await store.updateCard('k1', reviewPatch(got!, true, TODAY));
    expect(await store.getCard('k1')).toMatchObject({ reps: 1, streak: 1, reviewedAt: TODAY, due: '2026-11-06', retired: false });
    await store.updateCard('k1', { retired: true, due: null, streak: 3 });
    const list = await store.listCards(USER);
    expect(list.map(c => c.id)).toEqual(['k2', 'k4', 'k1']); // погашенная — в конце
    expect(list[2]).toMatchObject({ retired: true, due: null, streak: 3 });
    // карточки seed до 3.3 читаются с нулевой серией и без даты повтора
    db.exec(`INSERT INTO error_cards (id, user_id, topic, example, correction, due, created_at) VALUES ('old', '${USER}', 'tenses', 'ex', 'fix', '2026-11-01', '${NOW}')`);
    expect(await store.getCard('old')).toMatchObject({ streak: 0, reviewedAt: null, origin: null, stability: 1, difficulty: 5 });
  });
  it('GET /api/cards отдаёт серию и остаток до гашения', async () => {
    const mem = memoryStore();
    const app = createApp('test', () => mem.store);
    const env = { DB: null, DEV_ECHO_CODE: '1', APP_NAME: 'Offerly' } as unknown as Env;
    const r1 = await app.request('https://offerly.test/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc' }) }, env);
    const code = ((await r1.json()) as any).code;
    const r2 = await app.request('https://offerly.test/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc', code }) }, env);
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    mem.cards.push(card({ userId: mem.users[0].id, streak: 2, reviewedAt: TODAY }));
    const j: any = await (await app.request('https://offerly.test/api/cards', { headers: { cookie } }, env)).json();
    expect(j.cards[0]).toMatchObject({ streak: 2, left: 1, reviewedAt: TODAY, retired: false });
  });
});
