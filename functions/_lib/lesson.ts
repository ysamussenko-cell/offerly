/** Дневное занятие (концепт §2): три части по дню программы — разминка из пяти заданий темы дня, одно письмо
 *  формата дня (отзыв рецензента или объяснение неспециалисту; речь — 4.2), повтор карточек журнала, у которых
 *  наступил срок. Проверка мгновенная: разминка и карточки — сравнением с эталоном (верно/неверно, одна строка
 *  объяснения, правильный вариант — клиент подсвечивает изменения), письмо — модель-экзаменатор по рубрике
 *  и образцу из банка, с резюме, реальными ошибками и переписанным вариантом (scoring.ts, те же правила, что в тесте).
 *  Каждый выданный шаг сразу записывается в lesson_steps без ответа — занятие можно прервать и продолжить.
 *  Задания берутся из банка на уровне последнего теста или среза (две последние позиции разминки — ступенью выше,
 *  растяжка); если в банке пусто — модель пишет задание через обычный конвейер с проверкой. Задания, уже виденные
 *  в тестах и занятиях, не повторяются. После последнего шага день программы отмечается пройденным с баллом. */
import type { Env as ProviderEnv } from './providers';
import { KIND_LABELS, LEVELS, WRITING_WORDS, generateItems, topicById, type Domain, type Item, type ItemStore, type Kind, type Level, type GenerateOpts } from './items';
import { grade, levelFallbacks, type AssessmentStore } from './assessment';
import { evaluateWriting, parseWritingEval, type WritingEval } from './scoring';
import { dueForReview, cardTopicById, type CardStore, type ErrorCard } from './cards';
import { addDays, programTopicById, publicDay, MIXED_TOPIC, WRITING_LABELS, type ProgramDay, type ProgramStore, type PublicDay, type WritingFormat } from './program';
import { todayIn } from './onboarding';

export const WARMUP_COUNT = 5;
/** Позиции разминки с исправлением ошибки; остальные — выбор варианта. */
export const CORRECTION_POSITIONS = [3, 5];
/** Позиции разминки ступенью выше уровня ученика — растяжка. */
export const STRETCH_POSITIONS = [4, 5];
/** Сколько карточек журнала повторяется за занятие. */
export const REVIEW_MAX = 5;
export const DEFAULT_LEVEL: Level = 'B1';
/** Простой интервал до FSRS (3.3): верно — через три дня, неверно — завтра. */
export const REVIEW_INTERVAL = { correct: 3, wrong: 1 };

export const PARTS = ['warmup', 'writing', 'review'] as const;
export type Part = typeof PARTS[number];
export const PART_LABELS: Record<Part, string> = { warmup: 'разминка', writing: 'письмо', review: 'повтор карточек' };

export const LESSON_STATUSES = ['active', 'finished'] as const;
export type LessonStatus = typeof LESSON_STATUSES[number];

export interface Lesson {
  id: string;
  userId: string;
  programDayId: string | null;
  dayDate: string;
  topic: string;
  writing: WritingFormat | null;
  level: Level;
  status: LessonStatus;
  warmupCount: number;
  reviewCount: number;
  score: number | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string | null;
}

export interface LessonStep {
  id: string;
  lessonId: string;
  userId: string;
  position: number;
  part: Part;
  itemId: string | null;
  cardId: string | null;
  level: Level | null;
  answer: string | null;
  correct: number | null;
  score: number | null;
  feedback: string | null;
  /** JSON оценки письма (WritingEval); у остальных шагов null. */
  detail: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export type LessonPatch = Partial<Pick<Lesson, 'status' | 'reviewCount' | 'score' | 'finishedAt' | 'updatedAt'>>;
export type StepPatch = Partial<Pick<LessonStep, 'answer' | 'correct' | 'score' | 'feedback' | 'detail' | 'answeredAt'>>;

export interface LessonStore {
  createLesson(l: Lesson): Promise<void>;
  updateLesson(id: string, patch: LessonPatch): Promise<void>;
  /** Последнее занятие пользователя за дату (активное или завершённое). */
  lessonForDay(userId: string, dayDate: string): Promise<Lesson | null>;
  insertStep(s: LessonStep): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  listSteps(lessonId: string): Promise<LessonStep[]>;
  /** Задания, выданные пользователю в занятиях, — не показывать снова. */
  usedLessonItemIds(userId: string): Promise<Set<string>>;
}

export type Store = LessonStore & ItemStore & CardStore & ProgramStore & Pick<AssessmentStore, 'latestFinishedAssessment' | 'usedItemIds'>;

export class LessonError extends Error {
  constructor(public code: 'lesson_no_day' | 'lesson_unavailable' | 'lesson_none' | 'lesson_stale' | 'answer_invalid' | 'bank_empty' | 'lesson_eval_failed', message?: string, public reason?: string) { super(message ?? code); }
}

export interface RunOpts extends GenerateOpts { rng?: () => number; now?: () => string; id?: () => string; generate?: boolean }

const idx = (l: Level) => LEVELS.indexOf(l);
const upLevel = (l: Level): Level => LEVELS[Math.min(LEVELS.length - 1, idx(l) + 1)];
const pickRandom = <T,>(arr: T[], rng: () => number): T => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
const normSentence = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
const round = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ---------- план занятия ----------

/** Вид задания разминки по позиции. */
export const warmupKind = (position: number): Kind => CORRECTION_POSITIONS.includes(position) ? 'correction' : 'mcq';
/** Уровень задания разминки: растяжка на последних позициях. */
export const warmupLevel = (position: number, level: Level): Level => STRETCH_POSITIONS.includes(position) ? upLevel(level) : level;

/** Часть занятия по позиции. */
export function partAt(position: number, l: Pick<Lesson, 'warmupCount'>): Part {
  if (position <= l.warmupCount) return 'warmup';
  if (position === l.warmupCount + 1) return 'writing';
  return 'review';
}

export const totalSteps = (l: Pick<Lesson, 'warmupCount' | 'reviewCount'>) => l.warmupCount + 1 + l.reviewCount;

/** Темы разминки для дня: тема дня; для смешанного повторения — темы занятий той же недели программы и темы
 *  активных карточек, по кругу (без «mixed» и без «ответа на вопрос задания», которого в банке нет). */
export function warmupTopics(day: ProgramDay, weekDays: ProgramDay[], cards: ErrorCard[]): string[] {
  if (day.topic !== MIXED_TOPIC.id) return topicById(day.topic) ? [day.topic] : [];
  const out: string[] = [];
  for (const d of weekDays) if (d.format === 'lesson' && d.dayDate < day.dayDate && topicById(d.topic) && !out.includes(d.topic)) out.push(d.topic);
  for (const c of cards) if (!c.retired && topicById(c.topic) && !out.includes(c.topic)) out.push(c.topic);
  return out.length ? out : ['spelling'];
}

/** Карточки к повтору на сегодня: срок наступил или не назначен, есть пример и исправление; раньше — с более ранним сроком. */
export function reviewCards(cards: ErrorCard[], today: string, limit = REVIEW_MAX): ErrorCard[] {
  return cards.filter(c => dueForReview(c, today)).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
}

/** Проверка исправления карточки: совпало с «как надо» и отличается от «как написано». */
export function gradeCard(card: ErrorCard, raw: unknown): { ok: true; answer: string; correct: number } | { ok: false; reason: 'empty' | 'format' } {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length < 3 || s.length > 600) return { ok: false, reason: 'format' };
  const correct = normSentence(s) === normSentence(card.correction ?? '') && normSentence(s) !== normSentence(card.example ?? '') ? 1 : 0;
  return { ok: true, answer: s, correct };
}

/** Итог занятия: среднее баллов отвеченных шагов, 0–100. */
export function lessonScore(steps: LessonStep[]): number | null {
  const m = mean(steps.filter(s => s.answeredAt != null && s.score != null).map(s => s.score as number));
  return m == null ? null : round(m);
}

// ---------- что видит ученик ----------

const LETTERS = ['A', 'B', 'C', 'D'];

export interface CurrentStep {
  stepId: string; position: number; part: Part; partLabel: string; kind: Kind | 'card'; kindLabel: string; level: Level | null;
  topicLabel: string | null; prompt: string; options?: string[]; words?: { min: number; max: number };
}

export interface DoneStep {
  stepId: string; position: number; part: Part; partLabel: string; kind: Kind | 'card'; topicLabel: string | null;
  prompt: string; answer: string | null; correct: number | null; score: number | null;
  /** Одна строка объяснения: правило задания, правило карточки, резюме письма. */
  feedback: string | null;
  /** Как написал ученик — для выбора варианта предложение с выбранным словом. */
  written: string | null;
  /** Как надо: предложение с верным словом, исправленное предложение, «как надо» карточки, переписанное письмо. */
  correction: string | null;
  writing: { level: Level; summary: string; rewrite: string | null; errors: WritingEval['errors']; axes: WritingEval['axes'] } | null;
}

export interface View {
  id: string; status: LessonStatus; date: string; day: PublicDay | null;
  topic: string; topicLabel: string; writing: WritingFormat | null; writingLabel: string | null; level: Level; minutes: number | null;
  total: number; answered: number;
  parts: { warmup: { total: number; done: number; correct: number }; writing: { done: boolean; score: number | null }; review: { total: number; done: number; correct: number } };
  current: CurrentStep | null;
  /** Отвеченные шаги с результатом — для разбора по ходу и итога. */
  steps: DoneStep[];
  /** Только что отвеченный шаг (в ответе на /answer). */
  last: DoneStep | null;
  score: number | null; startedAt: string; finishedAt: string | null;
}

/** Задание дня без занятия: что сегодня по программе и почему занятие недоступно (репетиция и срез — 4.1 и 4.3). */
export interface DayInfo { day: PublicDay | null; available: boolean; reason: 'no_program' | 'no_day' | 'rehearsal' | 'checkpoint' | null }

const topicLabelOf = (item: Item | null | undefined, card: ErrorCard | null | undefined) =>
  item ? (topicById(item.topic)?.label ?? item.topic) : card ? (cardTopicById(card.topic)?.label ?? card.topic) : null;

export function currentStep(s: LessonStep, item: Item | null, card: ErrorCard | null): CurrentStep | null {
  const base = { stepId: s.id, position: s.position, part: s.part, partLabel: PART_LABELS[s.part], level: s.level, topicLabel: topicLabelOf(item, card) };
  if (s.part === 'review') {
    if (!card?.example) return null;
    return { ...base, kind: 'card', kindLabel: 'карточка журнала', prompt: card.example };
  }
  if (!item) return null;
  const b = { ...base, kind: item.kind, kindLabel: KIND_LABELS[item.kind], prompt: item.prompt };
  if (item.kind === 'mcq') return { ...b, options: item.options as string[] };
  if (item.kind === 'writing') return { ...b, words: { min: WRITING_WORDS.target[0], max: WRITING_WORDS.target[1] } };
  return b;
}

export function doneStep(s: LessonStep, item: Item | null, card: ErrorCard | null): DoneStep {
  const base = { stepId: s.id, position: s.position, part: s.part, partLabel: PART_LABELS[s.part], topicLabel: topicLabelOf(item, card), answer: s.answer, correct: s.correct, score: s.score, feedback: s.feedback, writing: null as DoneStep['writing'] };
  if (s.part === 'review') return { ...base, kind: 'card', prompt: card?.example ?? '', written: s.answer, correction: card?.correction ?? null };
  if (!item) return { ...base, kind: 'mcq', prompt: '', written: s.answer, correction: null };
  if (item.kind === 'mcq') {
    const opts = item.options as string[];
    const chosen = opts[LETTERS.indexOf(s.answer ?? '')] ?? s.answer ?? '';
    const right = opts[LETTERS.indexOf(item.answer)] ?? item.answer;
    return { ...base, kind: 'mcq', prompt: item.prompt, written: item.prompt.replace('___', chosen), correction: item.prompt.replace('___', right) };
  }
  if (item.kind === 'writing') {
    const w = parseWritingEval(s.detail);
    return { ...base, kind: 'writing', prompt: item.prompt, written: s.answer, correction: w?.rewrite ?? null, writing: w ? { level: w.level, summary: w.summary, rewrite: w.rewrite, errors: w.errors, axes: w.axes } : null };
  }
  return { ...base, kind: item.kind, prompt: item.prompt, written: s.answer, correction: item.answer };
}

async function loadRefs(store: Store, steps: LessonStep[]) {
  const items = new Map<string, Item>(), cards = new Map<string, ErrorCard>();
  for (const s of steps) {
    if (s.itemId && !items.has(s.itemId)) { const it = await store.getItem(s.itemId); if (it) items.set(s.itemId, it); }
    if (s.cardId && !cards.has(s.cardId)) { const c = await store.getCard(s.cardId); if (c) cards.set(s.cardId, c); }
  }
  return { items, cards };
}

export async function view(store: Store, l: Lesson, steps: LessonStep[], day: ProgramDay | null, today: string, lastId: string | null = null): Promise<View> {
  const { items, cards } = await loadRefs(store, steps);
  const ref = (s: LessonStep) => [s.itemId ? items.get(s.itemId) ?? null : null, s.cardId ? cards.get(s.cardId) ?? null : null] as const;
  const pending = steps.find(s => s.answeredAt == null) ?? null;
  const done = steps.filter(s => s.answeredAt != null);
  const dones = done.map(s => doneStep(s, ...ref(s)));
  const part = (p: Part) => done.filter(s => s.part === p);
  const w = part('writing')[0];
  return {
    id: l.id, status: l.status, date: l.dayDate, day: day ? publicDay(day, today) : null,
    topic: l.topic, topicLabel: programTopicById(l.topic)?.label ?? l.topic, writing: l.writing, writingLabel: l.writing ? WRITING_LABELS[l.writing] : null,
    level: l.level, minutes: day?.minutes ?? null, total: totalSteps(l), answered: done.length,
    parts: {
      warmup: { total: l.warmupCount, done: part('warmup').length, correct: part('warmup').filter(s => s.correct === 1).length },
      writing: { done: !!w, score: w?.score ?? null },
      review: { total: l.reviewCount, done: part('review').length, correct: part('review').filter(s => s.correct === 1).length },
    },
    current: pending && l.status === 'active' ? currentStep(pending, ...ref(pending)) : null,
    steps: dones, last: lastId ? dones.find(d => d.stepId === lastId) ?? null : null,
    score: l.score, startedAt: l.startedAt, finishedAt: l.finishedAt,
  };
}

// ---------- оркестрация ----------

async function dayOf(store: Store, userId: string, today: string): Promise<{ day: ProgramDay | null; week: ProgramDay[]; info: DayInfo }> {
  const all = await store.listProgramDays(userId);
  const day = all.filter(d => d.dayDate === today).sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0))[0] ?? null;
  if (!day) return { day: null, week: [], info: { day: null, available: false, reason: all.length ? 'no_day' : 'no_program' } };
  const week = all.filter(d => d.week === day.week && d.generatedAt === day.generatedAt);
  const pd = publicDay(day, today);
  if (day.format !== 'lesson') return { day, week, info: { day: pd, available: false, reason: day.format } };
  return { day, week, info: { day: pd, available: true, reason: null } };
}

/** Что сегодня: день программы и занятие по нему (активное или завершённое), без побочных действий. */
export async function today(store: Store, userId: string, tz: string, opts: RunOpts = {}): Promise<{ today: string; info: DayInfo; lesson: View | null }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const { day, info } = await dayOf(store, userId, t);
  const l = await store.lessonForDay(userId, t);
  return { today: t, info, lesson: l ? await view(store, l, await store.listSteps(l.id), day, t) : null };
}

async function usedIds(store: Store, userId: string, steps: LessonStep[]) {
  const used = await store.usedItemIds(userId);
  for (const id of await store.usedLessonItemIds(userId)) used.add(id);
  for (const s of steps) if (s.itemId) used.add(s.itemId);
  return used;
}

/** Задание из банка: нужный уровень, затем соседние; темы — по списку, первая подходящая. */
export async function pickWarmup(store: Store, kind: Kind, level: Level, topics: string[], used: Set<string>, rng: () => number): Promise<Item | null> {
  for (const lvl of levelFallbacks(level)) {
    const cands = (await store.randomItems(kind, lvl, 120)).filter(i => !used.has(i.id) && topics.includes(i.topic));
    if (!cands.length) continue;
    for (const t of topics) { const byTopic = cands.filter(i => i.topic === t); if (byTopic.length) return pickRandom(byTopic, rng); }
  }
  return null;
}

/** Письменное задание формата дня из банка на уровне ученика (затем соседние). */
export async function pickWriting(store: Store, level: Level, format: WritingFormat | null, used: Set<string>, rng: () => number): Promise<Item | null> {
  for (const lvl of levelFallbacks(level)) {
    const cands = (await store.randomItems('writing', lvl, 120)).filter(i => !used.has(i.id) && (!format || i.writingFormat === format));
    if (cands.length) return pickRandom(cands, rng);
  }
  return null;
}

/** Выдаёт следующий шаг и записывает его без ответа. Банк пуст — модель пишет задание (проверка как в банке);
 *  карточки закончились раньше плана — занятие укорачивается. */
async function serveNext(env: ProviderEnv, store: Store, l: Lesson, steps: LessonStep[], day: ProgramDay, week: ProgramDay[], domain: Domain, opts: RunOpts): Promise<LessonStep | null> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const rng = opts.rng ?? Math.random;
  const position = steps.length + 1;
  const part = partAt(position, l);
  const base = { id: id(), lessonId: l.id, userId: l.userId, position, part, answer: null, correct: null, score: null, feedback: null, detail: null, createdAt: now(), answeredAt: null };
  let step: LessonStep;
  if (part === 'review') {
    const seen = new Set(steps.map(s => s.cardId).filter(Boolean));
    const card = reviewCards(await store.listCards(l.userId), l.dayDate, REVIEW_MAX + seen.size).find(c => !seen.has(c.id));
    if (!card) return null;
    step = { ...base, itemId: null, cardId: card.id, level: null };
  } else {
    const used = await usedIds(store, l.userId, steps);
    const cards = await store.listCards(l.userId);
    const topics = part === 'warmup' ? warmupTopics(day, week, cards) : [topicById(day.topic) ? day.topic : 'register'];
    const kind: Kind = part === 'warmup' ? warmupKind(position) : 'writing';
    const level = part === 'warmup' ? warmupLevel(position, l.level) : l.level;
    let item = part === 'warmup' ? await pickWarmup(store, kind, level, topics, used, rng) : await pickWriting(store, level, l.writing, used, rng);
    if (!item && opts.generate !== false) {
      const topic = topicById(topics[(position - 1) % topics.length]) ?? topicById('spelling')!;
      try {
        const r = await generateItems(env, store, { kind, level, topic, count: kind === 'mcq' ? 3 : 2, domain, format: kind === 'writing' ? l.writing : null }, opts);
        item = r.items.find(i => i.status === 'verified') ?? null;
      } catch (e) {
        throw new LessonError('bank_empty', `в банке нет заданий «${KIND_LABELS[kind]}» по теме, а модель не смогла написать: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
      }
    }
    if (!item) throw new LessonError('bank_empty', `в банке нет принятых заданий вида «${KIND_LABELS[kind]}» по теме дня ни на одном уровне`);
    step = { ...base, itemId: item.id, cardId: null, level: item.level };
  }
  await store.insertStep(step);
  return step;
}

async function finish(store: Store, l: Lesson, steps: LessonStep[], day: ProgramDay | null, ts: string) {
  const score = lessonScore(steps);
  const patch: LessonPatch = { status: 'finished', score, finishedAt: ts, updatedAt: ts, reviewCount: steps.filter(s => s.part === 'review').length };
  await store.updateLesson(l.id, patch);
  Object.assign(l, patch);
  if (day && day.status !== 'done') {
    await store.updateProgramDay(day.id, { status: 'done', score, completedAt: ts, updatedAt: ts });
    day.status = 'done'; day.score = score; day.completedAt = ts;
  }
}

/** Начать занятие дня или продолжить начатое: активное занятие с шагом без ответа возвращается как есть. */
export async function startOrResume(env: ProviderEnv, store: Store, userId: string, tz: string, domain: Domain, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const t = todayIn(tz, new Date(now()));
  const { day, week, info } = await dayOf(store, userId, t);
  if (!day) throw new LessonError('lesson_no_day', 'на сегодня нет дня программы — составьте программу', info.reason ?? undefined);
  if (day.format !== 'lesson') throw new LessonError('lesson_unavailable', day.format === 'rehearsal' ? 'сегодня репетиция интервью — она появится в 4.1' : 'сегодня контрольный срез — он появится в 4.3', day.format);
  let l = await store.lessonForDay(userId, t);
  if (!l) {
    const a = await store.latestFinishedAssessment(userId);
    const ts = now();
    const due = reviewCards(await store.listCards(userId), t).length;
    l = { id: id(), userId, programDayId: day.id, dayDate: t, topic: day.topic, writing: day.writing, level: a?.level ?? DEFAULT_LEVEL, status: 'active', warmupCount: WARMUP_COUNT, reviewCount: due, score: null, startedAt: ts, finishedAt: null, updatedAt: ts };
    await store.createLesson(l);
  }
  const steps = await store.listSteps(l.id);
  if (l.status === 'active' && !steps.some(s => s.answeredAt == null)) {
    const next = await serveNext(env, store, l, steps, day, week, domain, opts);
    if (next) { steps.push(next); await store.updateLesson(l.id, { updatedAt: now() }); }
    else await finish(store, l, steps, day, now());
  }
  return view(store, l, steps, day, t);
}

/** Принять ответ на текущий шаг и выдать следующий; после последнего — закрыть занятие и отметить день программы. */
export async function answer(env: ProviderEnv, store: Store, userId: string, stepId: unknown, raw: unknown, tz: string, domain: Domain, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const l = await store.lessonForDay(userId, t);
  if (!l || l.status !== 'active') throw new LessonError('lesson_none', 'активного занятия на сегодня нет');
  const steps = await store.listSteps(l.id);
  const pending = steps.find(s => s.answeredAt == null);
  if (!pending) throw new LessonError('lesson_stale', 'шаг ещё не выдан');
  if (typeof stepId !== 'string' || stepId !== pending.id) throw new LessonError('lesson_stale', 'ответ относится не к текущему шагу');
  const { day, week } = await dayOf(store, userId, t);
  const ts = now();
  let patch: StepPatch;
  if (pending.part === 'review') {
    const card = pending.cardId ? await store.getCard(pending.cardId) : null;
    if (!card) throw new LessonError('lesson_stale', 'карточка не найдена');
    const g = gradeCard(card, raw);
    if (!g.ok) throw new LessonError('answer_invalid', undefined, g.reason);
    patch = { answer: g.answer, correct: g.correct, score: g.correct * 100, feedback: card.rule, answeredAt: ts };
    await store.updateCard(card.id, g.correct ? { reps: card.reps + 1, due: addDays(t, REVIEW_INTERVAL.correct) } : { lapses: card.lapses + 1, due: addDays(t, REVIEW_INTERVAL.wrong) });
  } else {
    const item = pending.itemId ? await store.getItem(pending.itemId) : null;
    if (!item) throw new LessonError('lesson_stale', 'задание не найдено');
    const g = grade(item, raw);
    if (!g.ok) throw new LessonError('answer_invalid', undefined, g.reason);
    if (item.kind === 'writing') {
      let w: WritingEval;
      try { w = await evaluateWriting(env, item, g.answer, opts); }
      catch (e) { throw new LessonError('lesson_eval_failed', `экзаменатор не оценил письмо: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`); }
      const score = round((w.axes.grammar + w.axes.vocabulary + w.axes.coherence + w.axes.taskResponse) / 4);
      patch = { answer: g.answer, correct: null, score, feedback: w.summary, detail: JSON.stringify(w), answeredAt: ts };
    } else {
      patch = { answer: g.answer, correct: g.correct, score: g.score, feedback: g.feedback, answeredAt: ts };
    }
  }
  await store.updateStep(pending.id, patch);
  Object.assign(pending, patch);
  if (pending.position >= totalSteps(l)) {
    await finish(store, l, steps, day, ts);
  } else {
    const next = day ? await serveNext(env, store, l, steps, day, week, domain, opts) : null;
    if (next) { steps.push(next); await store.updateLesson(l.id, { updatedAt: ts }); }
    else await finish(store, l, steps, day, ts);
  }
  return view(store, l, steps, day, t, pending.id);
}

// ---------- хранилище D1 ----------

export function d1LessonStore(db: D1Database): LessonStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const toL = (r: any): Lesson => ({
    id: r.id, userId: r.user_id, programDayId: r.program_day_id ?? null, dayDate: r.day_date, topic: r.topic, writing: r.writing ?? null,
    level: (LEVELS as readonly string[]).includes(r.level) ? r.level : DEFAULT_LEVEL, status: (LESSON_STATUSES as readonly string[]).includes(r.status) ? r.status : 'active',
    warmupCount: Number(r.warmup_count ?? WARMUP_COUNT), reviewCount: Number(r.review_count ?? 0), score: n(r.score),
    startedAt: r.started_at, finishedAt: r.finished_at ?? null, updatedAt: r.updated_at ?? null,
  });
  const toS = (r: any): LessonStep => ({
    id: r.id, lessonId: r.lesson_id, userId: r.user_id, position: Number(r.position), part: (PARTS as readonly string[]).includes(r.part) ? r.part : 'warmup',
    itemId: r.item_id ?? null, cardId: r.card_id ?? null, level: r.level ?? null, answer: r.answer ?? null, correct: n(r.correct), score: n(r.score),
    feedback: r.feedback ?? null, detail: r.detail ?? null, createdAt: r.created_at, answeredAt: r.answered_at ?? null,
  });
  const COLS: Record<string, string> = {
    status: 'status', reviewCount: 'review_count', score: 'score', finishedAt: 'finished_at', updatedAt: 'updated_at',
    answer: 'answer', correct: 'correct', feedback: 'feedback', detail: 'detail', answeredAt: 'answered_at',
  };
  const setClause = (patch: Record<string, unknown>) => {
    const keys = Object.keys(patch).filter(k => patch[k] !== undefined && COLS[k]);
    return { sql: keys.map(k => `${COLS[k]} = ?`).join(', '), args: keys.map(k => patch[k]) };
  };
  return {
    async createLesson(l) {
      await db.prepare('INSERT INTO lessons (id, user_id, program_day_id, day_date, topic, writing, level, status, warmup_count, review_count, score, started_at, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(l.id, l.userId, l.programDayId, l.dayDate, l.topic, l.writing, l.level, l.status, l.warmupCount, l.reviewCount, l.score, l.startedAt, l.finishedAt, l.updatedAt).run();
    },
    async updateLesson(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE lessons SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async lessonForDay(userId, dayDate) {
      const r = await db.prepare('SELECT * FROM lessons WHERE user_id = ? AND day_date = ? ORDER BY started_at DESC LIMIT 1').bind(userId, dayDate).first();
      return r ? toL(r) : null;
    },
    async insertStep(s) {
      await db.prepare('INSERT INTO lesson_steps (id, lesson_id, user_id, position, part, item_id, card_id, level, answer, correct, score, feedback, detail, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(s.id, s.lessonId, s.userId, s.position, s.part, s.itemId, s.cardId, s.level, s.answer, s.correct, s.score, s.feedback, s.detail, s.createdAt, s.answeredAt).run();
    },
    async updateStep(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE lesson_steps SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async listSteps(lessonId) {
      const rs = await db.prepare('SELECT * FROM lesson_steps WHERE lesson_id = ? ORDER BY position').bind(lessonId).all();
      return (rs.results as any[]).map(toS);
    },
    async usedLessonItemIds(userId) {
      const rs = await db.prepare('SELECT DISTINCT item_id FROM lesson_steps WHERE user_id = ? AND item_id IS NOT NULL').bind(userId).all();
      return new Set((rs.results as any[]).map(r => String(r.item_id)));
    },
  };
}
