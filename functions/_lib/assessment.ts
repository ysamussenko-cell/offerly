/** Адаптивный тест уровня: двенадцать заданий на грамматику и лексику с подстройкой сложности после каждого ответа,
 *  затем чтение с двумя вопросами и письмо 60–80 слов. Задания берутся из банка (status = verified) на уровне,
 *  к которому подошёл ученик; если на нужном уровне пусто — соседний уровень, а если пусто и там — модель пишет
 *  задание прямо сейчас через тот же конвейер генерации с проверкой. Каждое выданное задание сразу записывается
 *  в attempts без ответа — это точка продолжения: тест можно прервать и открыть снова с того же места.
 *  Проверка ответов — сравнением с эталоном из банка: буква варианта, буквы двух вопросов, исправленное предложение.
 *  После последнего ответа письмо оценивает модель по рубрике и образцу, считаются пять осей и уровень (scoring.ts). */
import type { Env as ProviderEnv } from './providers';
import {
  LEVELS, TOPICS, KIND_LABELS, WRITING_WORDS, generateItems, type Domain, type Item, type ItemStore, type Kind, type Level, type ReadingQuestion, type GenerateOpts,
} from './items';
import {
  AXES, AXIS_LABELS, LEVEL_THRESHOLD, BAND, computeAxes, errorExamples, evaluateWriting, nextStep, parseWritingEval,
  type Axes, type Axis, type ErrorExample, type WritingEval,
} from './scoring';

export const ADAPTIVE_COUNT = 12;
export const TOTAL = ADAPTIVE_COUNT + 2; // + чтение + письмо
export const START_LEVEL: Level = 'B1';
/** Сколько последних тем не повторять подряд. */
export const TOPIC_MEMORY = 3;
/** Границы письма при приёме ответа: короче — отказ, длиннее — отказ; цель 60–80 остаётся в задании. */
export const ANSWER_WORDS = { min: 30, max: 200 };
/** Минимум ответов на уровне, чтобы уровень засчитывался при оценке. */
export const MIN_AT_LEVEL = 2;

export const STATUSES = ['active', 'finished', 'abandoned'] as const;
export type AssessmentStatus = typeof STATUSES[number];

export const LEVEL_LABELS: Record<Level, string> = { A2: 'базовый', B1: 'средний', B2: 'выше среднего', C1: 'продвинутый' };

export interface Assessment {
  id: string;
  userId: string;
  kind: 'placement' | 'checkpoint';
  status: AssessmentStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Итоговый уровень — после завершения. */
  level: Level | null;
  /** Уровень, с которого берётся следующее адаптивное задание. */
  currentLevel: Level;
  updatedAt: string;
  /** Пять осей 0–100 после оценки; беглость речи до голоса — null. */
  axes: Axes | null;
  /** Сводный балл 0–100, из которого выведен уровень. */
  overall: number | null;
  scoredAt: string | null;
  /** Почему письмо не оценено (ошибка модели); null — оценка полная. */
  scoringNote: string | null;
}

export interface Attempt {
  id: string;
  userId: string;
  assessmentId: string;
  itemId: string;
  position: number;
  /** Фактический уровень выданного задания. */
  level: Level;
  answer: string | null;
  /** 1 — верно, 0 — неверно, null — ещё не отвечено или не проверяется сравнением (письмо). */
  correct: number | null;
  /** Проценты: mcq и исправление — 0/100, чтение — 0/50/100, письмо — null до оценки в 2.6. */
  score: number | null;
  feedback: string | null;
  /** JSON оценки письма моделью (WritingEval); у остальных заданий null. */
  detail: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export type AssessmentPatch = Partial<Pick<Assessment, 'status' | 'currentLevel' | 'level' | 'finishedAt' | 'updatedAt' | 'axes' | 'overall' | 'scoredAt' | 'scoringNote'>>;
export type AttemptPatch = Partial<Pick<Attempt, 'answer' | 'correct' | 'score' | 'feedback' | 'detail' | 'answeredAt'>>;

export interface AssessmentStore {
  createAssessment(a: Assessment): Promise<void>;
  updateAssessment(id: string, patch: AssessmentPatch): Promise<void>;
  activeAssessment(userId: string): Promise<Assessment | null>;
  latestAssessment(userId: string): Promise<Assessment | null>;
  insertAttempt(a: Attempt): Promise<void>;
  updateAttempt(id: string, patch: AttemptPatch): Promise<void>;
  /** Попытки теста по порядку позиций. */
  listAttempts(assessmentId: string): Promise<Attempt[]>;
  /** Все задания, которые пользователь когда-либо видел (любой тест) — не показывать снова. */
  usedItemIds(userId: string): Promise<Set<string>>;
}

export type Store = AssessmentStore & ItemStore;

// ---------- план и ход теста ----------

/** Вид задания по позиции: исправление ошибки на каждой третьей, иначе выбор варианта; затем чтение и письмо. */
export function kindAt(position: number): Kind {
  if (position <= ADAPTIVE_COUNT) return position % 3 === 0 ? 'correction' : 'mcq';
  return position === ADAPTIVE_COUNT + 1 ? 'reading' : 'writing';
}

const idx = (l: Level) => LEVELS.indexOf(l);
const clampLevel = (i: number): Level => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))];

/** Верно — ступень вверх, неверно — ступень вниз, в пределах A2–C1. */
export const nextLevel = (level: Level, correct: boolean): Level => clampLevel(idx(level) + (correct ? 1 : -1));

/** Порядок перебора уровней, когда на нужном пусто: сам уровень, ступень ниже, ступень выше, две ниже, две выше. */
export function levelFallbacks(level: Level): Level[] {
  const out: Level[] = [];
  for (const d of [0, -1, 1, -2, 2, -3, 3]) {
    const i = idx(level) + d;
    if (i >= 0 && i < LEVELS.length && !out.includes(LEVELS[i])) out.push(LEVELS[i]);
  }
  return out;
}

/** Предварительный уровень по адаптивной части: самый высокий уровень, где ученик ответил не меньше чем
 *  на MIN_AT_LEVEL заданий и верно не меньше половины из них. Ниже A2 не бывает. Пять осей считает 2.6. */
export function estimateLevel(attempts: Pick<Attempt, 'position' | 'level' | 'correct'>[]): Level {
  const perLevel = new Map<Level, { n: number; ok: number }>();
  for (const a of attempts) {
    if (a.position > ADAPTIVE_COUNT || a.correct == null) continue;
    const s = perLevel.get(a.level) ?? { n: 0, ok: 0 };
    s.n++; s.ok += a.correct ? 1 : 0;
    perLevel.set(a.level, s);
  }
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    const s = perLevel.get(LEVELS[i]);
    if (s && s.n >= MIN_AT_LEVEL && s.ok * 2 >= s.n) return LEVELS[i];
  }
  // Ни один уровень не набрал двух ответов с половиной верных: единственный верный ответ на A2 — A2, иначе тоже A2.
  return LEVELS[0];
}

// ---------- проверка ответа ----------

const LETTERS = ['A', 'B', 'C', 'D'];
const normLetters = (s: string) => s.toUpperCase().replace(/[^A-D]/g, '').split('');
const normSentence = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

export type Graded = { ok: true; answer: string; correct: number | null; score: number | null; feedback: string | null };
export type GradeRefusal = { ok: false; reason: 'empty' | 'format' | 'too_short' | 'too_long' };

/** Сравнение ответа с эталоном задания. Ответ не принимается, если он пустой или не того вида. */
export function grade(item: Item, raw: unknown): Graded | GradeRefusal {
  if (item.kind === 'mcq') {
    const s = typeof raw === 'string' ? raw.trim() : '';
    const l = normLetters(s);
    if (!s) return { ok: false, reason: 'empty' };
    if (l.length !== 1 || s.length > 2) return { ok: false, reason: 'format' };
    const correct = l[0] === item.answer ? 1 : 0;
    return { ok: true, answer: l[0], correct, score: correct * 100, feedback: item.explanation };
  }
  if (item.kind === 'reading') {
    const arr = Array.isArray(raw) ? raw.map(x => String(x)) : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
    const letters = arr.map(x => normLetters(x)[0]).filter(Boolean);
    if (!arr.length || arr.every(x => !x.trim())) return { ok: false, reason: 'empty' };
    const qs = item.options as ReadingQuestion[];
    if (letters.length !== qs.length) return { ok: false, reason: 'format' };
    const hits = qs.filter((q, i) => q.answer === letters[i]).length;
    return { ok: true, answer: letters.join(','), correct: hits === qs.length ? 1 : 0, score: Math.round(100 * hits / qs.length), feedback: item.explanation };
  }
  if (item.kind === 'correction') {
    const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!s) return { ok: false, reason: 'empty' };
    if (s.length < 5 || s.length > 600) return { ok: false, reason: 'format' };
    const correct = normSentence(s) === normSentence(item.answer) && normSentence(s) !== normSentence(item.prompt) ? 1 : 0;
    return { ok: true, answer: s, correct, score: correct * 100, feedback: item.explanation };
  }
  // writing — только приём текста в разумных границах; оценка по пяти осям — 2.6
  const s = typeof raw === 'string' ? raw.replace(/[ \t]+/g, ' ').trim() : '';
  if (!s) return { ok: false, reason: 'empty' };
  const w = countWords(s);
  if (w < ANSWER_WORDS.min) return { ok: false, reason: 'too_short' };
  if (w > ANSWER_WORDS.max) return { ok: false, reason: 'too_long' };
  return { ok: true, answer: s.slice(0, 4000), correct: null, score: null, feedback: null };
}

// ---------- что видит ученик ----------

/** Задание без ключа, объяснения, рубрики и уровня — ученику в тесте этого знать не нужно. */
export function testItem(i: Item, attemptId: string, position: number) {
  const base = { attemptId, itemId: i.id, position, kind: i.kind, kindLabel: KIND_LABELS[i.kind], prompt: i.prompt };
  if (i.kind === 'mcq') return { ...base, options: i.options as string[] };
  if (i.kind === 'reading') return { ...base, questions: (i.options as ReadingQuestion[]).map(q => ({ question: q.question, options: q.options })) };
  if (i.kind === 'writing') return { ...base, words: { min: WRITING_WORDS.target[0], max: WRITING_WORDS.target[1] } };
  return base;
}

export type TestItem = ReturnType<typeof testItem>;

export interface View {
  id: string;
  status: AssessmentStatus;
  total: number;
  /** Сколько заданий отвечено. */
  answered: number;
  /** Текущее задание без ответа; null, если тест завершён или задание ещё не выдано. */
  current: TestItem | null;
  startedAt: string;
  finishedAt: string | null;
  level: Level | null;
  levelLabel: string | null;
  /** После завершения: верные ответы адаптивной части, очки за чтение (0/50/100) и длина письма. */
  summary: { adaptiveTotal: number; adaptiveCorrect: number; readingScore: number | null; writingWords: number | null } | null;
  /** После завершения: пять осей, лестница и примеры ошибок; null — оценка ещё не считалась (тест 0.6.0). */
  result: Result | null;
}

export interface Result {
  axes: { id: Axis; label: string; score: number | null }[];
  overall: number;
  level: Level;
  /** Лестница: ступени с нижними порогами и следующая ступень с остатком баллов. */
  ladder: { steps: { level: Level; label: string; from: number }[]; next: { level: Level; points: number } | null };
  examples: ErrorExample[];
  writing: { level: Level; summary: string; rewrite: string | null; errors: number } | null;
  scoredAt: string | null;
  /** Почему письмо не оценено; null — всё посчитано. */
  scoringNote: string | null;
}


/** Задания теста по id — для сводки и примеров ошибок. */
async function itemsOf(store: Store, attempts: Attempt[]): Promise<Map<string, Item>> {
  const m = new Map<string, Item>();
  for (const a of attempts) { if (!m.has(a.itemId)) { const it = await store.getItem(a.itemId); if (it) m.set(a.itemId, it); } }
  return m;
}

export const ladderSteps = () => LEVELS.map((level, i) => ({ level, label: LEVEL_LABELS[level], from: i === 0 ? 0 : i * BAND + LEVEL_THRESHOLD }));

export function buildResult(a: Assessment, attempts: Attempt[], items: Map<string, Item>): Result | null {
  if (!a.axes || a.overall == null || !a.level) return null;
  const writingAttempt = attempts.find(x => x.position === ADAPTIVE_COUNT + 2);
  const writing = parseWritingEval(writingAttempt?.detail);
  return {
    axes: AXES.map(id => ({ id, label: AXIS_LABELS[id], score: a.axes![id] })),
    overall: a.overall, level: a.level,
    ladder: { steps: ladderSteps(), next: nextStep(a.overall) },
    examples: errorExamples(attempts, items, writing),
    writing: writing ? { level: writing.level, summary: writing.summary, rewrite: writing.rewrite, errors: writing.errors.length } : null,
    scoredAt: a.scoredAt, scoringNote: a.scoringNote,
  };
}

export async function view(store: Store, a: Assessment, attempts?: Attempt[]): Promise<View> {
  const list = attempts ?? await store.listAttempts(a.id);
  const pending = list.find(x => x.answeredAt == null) ?? null;
  const answered = list.filter(x => x.answeredAt != null).length;
  let current: TestItem | null = null;
  if (pending && a.status === 'active') {
    const item = await store.getItem(pending.itemId);
    if (item) current = testItem(item, pending.id, pending.position);
  }
  let summary: View['summary'] = null;
  let result: Result | null = null;
  if (a.status === 'finished') {
    const adaptive = list.filter(x => x.position <= ADAPTIVE_COUNT && x.correct != null);
    const reading = list.find(x => x.position === ADAPTIVE_COUNT + 1);
    const writing = list.find(x => x.position === ADAPTIVE_COUNT + 2);
    summary = { adaptiveTotal: adaptive.length, adaptiveCorrect: adaptive.filter(x => x.correct === 1).length, readingScore: reading?.score ?? null, writingWords: writing?.answer ? countWords(writing.answer) : null };
    result = buildResult(a, list, await itemsOf(store, list));
  }
  return {
    id: a.id, status: a.status, total: TOTAL, answered, current, startedAt: a.startedAt, finishedAt: a.finishedAt,
    level: a.level, levelLabel: a.level ? LEVEL_LABELS[a.level] : null, summary, result,
  };
}

// ---------- оркестрация ----------

export class AssessmentError extends Error {
  constructor(public code: 'assessment_none' | 'assessment_stale' | 'assessment_finished' | 'answer_invalid' | 'bank_empty', message?: string, public reason?: string) { super(message ?? code); }
}

export interface RunOpts extends GenerateOpts { rng?: () => number; now?: () => string; id?: () => string; /** Генерировать задание моделью, если в банке пусто (по умолчанию да). */ generate?: boolean }

const pickRandom = <T,>(arr: T[], rng: () => number): T => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

/** Выбор задания из банка: нужный уровень, затем соседние; темы последних заданий — в последнюю очередь. */
export async function pickItem(store: Store, kind: Kind, level: Level, used: Set<string>, recentTopics: string[], rng: () => number): Promise<Item | null> {
  for (const lvl of levelFallbacks(level)) {
    const cands = (await store.randomItems(kind, lvl, 80)).filter(i => !used.has(i.id));
    if (!cands.length) continue;
    const fresh = cands.filter(i => !recentTopics.includes(i.topic));
    return pickRandom(fresh.length ? fresh : cands, rng);
  }
  return null;
}

/** Банк пуст на всех уровнях: модель пишет задания по случайной теме (не из последних) и они проходят обычную проверку. */
export async function generateForTest(env: ProviderEnv, store: Store, kind: Kind, level: Level, domain: Domain, recentTopics: string[], opts: RunOpts): Promise<Item | null> {
  const rng = opts.rng ?? Math.random;
  const pool = TOPICS.filter(t => !recentTopics.includes(t.id));
  const topic = pickRandom(pool.length ? pool : TOPICS, rng);
  const count = kind === 'mcq' ? 3 : 2;
  const r = await generateItems(env, store, { kind, level, topic, count, domain }, opts);
  return r.items.find(i => i.status === 'verified') ?? null;
}

/** Выдаёт следующее задание и записывает попытку без ответа. */
async function serveNext(env: ProviderEnv, store: Store, a: Assessment, attempts: Attempt[], domain: Domain, opts: RunOpts): Promise<Attempt> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const rng = opts.rng ?? Math.random;
  const position = attempts.length + 1;
  const kind = kindAt(position);
  const level = position <= ADAPTIVE_COUNT ? a.currentLevel : estimateLevel(attempts);
  const used = await store.usedItemIds(a.userId);
  for (const x of attempts) used.add(x.itemId);
  const recent: string[] = [];
  for (const x of attempts.slice(-TOPIC_MEMORY)) { const it = await store.getItem(x.itemId); if (it) recent.push(it.topic); }
  let item = await pickItem(store, kind, level, used, recent, rng);
  if (!item && opts.generate !== false) {
    try { item = await generateForTest(env, store, kind, level, domain, recent, opts); }
    catch (e) { throw new AssessmentError('bank_empty', `в банке нет заданий «${KIND_LABELS[kind]}», а модель не смогла написать: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`); }
  }
  if (!item) throw new AssessmentError('bank_empty', `в банке нет принятых заданий вида «${KIND_LABELS[kind]}» ни на одном уровне`);
  const attempt: Attempt = {
    id: id(), userId: a.userId, assessmentId: a.id, itemId: item.id, position, level: item.level,
    answer: null, correct: null, score: null, feedback: null, detail: null, createdAt: now(), answeredAt: null,
  };
  await store.insertAttempt(attempt);
  return attempt;
}

/** Начать тест или продолжить начатый: активный тест с заданием без ответа возвращается как есть. */
export async function startOrResume(env: ProviderEnv, store: Store, userId: string, domain: Domain, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  let a = await store.activeAssessment(userId);
  if (!a) {
    const ts = now();
    a = { id: id(), userId, kind: 'placement', status: 'active', startedAt: ts, finishedAt: null, level: null, currentLevel: START_LEVEL, updatedAt: ts, axes: null, overall: null, scoredAt: null, scoringNote: null };
    await store.createAssessment(a);
  }
  const attempts = await store.listAttempts(a.id);
  if (!attempts.some(x => x.answeredAt == null)) {
    attempts.push(await serveNext(env, store, a, attempts, domain, opts));
    await store.updateAssessment(a.id, { updatedAt: now() });
  }
  return view(store, a, attempts);
}

/** Принять ответ на текущее задание, сдвинуть уровень и выдать следующее; после последнего — завершить тест. */
export async function answer(env: ProviderEnv, store: Store, userId: string, attemptId: unknown, raw: unknown, domain: Domain, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const a = await store.activeAssessment(userId);
  if (!a) throw new AssessmentError('assessment_none');
  const attempts = await store.listAttempts(a.id);
  const pending = attempts.find(x => x.answeredAt == null);
  if (!pending) throw new AssessmentError('assessment_stale', 'задание ещё не выдано');
  if (typeof attemptId !== 'string' || attemptId !== pending.id) throw new AssessmentError('assessment_stale', 'ответ относится не к текущему заданию');
  const item = await store.getItem(pending.itemId);
  if (!item) throw new AssessmentError('assessment_stale', 'задание не найдено');
  const g = grade(item, raw);
  if (!g.ok) throw new AssessmentError('answer_invalid', undefined, g.reason);
  const ts = now();
  const patch = { answer: g.answer, correct: g.correct, score: g.score, feedback: g.feedback, answeredAt: ts };
  await store.updateAttempt(pending.id, patch);
  Object.assign(pending, patch);

  if (pending.position <= ADAPTIVE_COUNT) {
    a.currentLevel = nextLevel(pending.level, g.correct === 1);
  }
  if (pending.position >= TOTAL) {
    // Сначала тест закрывается с предварительным уровнем по адаптивной части — если оценка письма упадёт, тест всё равно завершён.
    a.status = 'finished'; a.finishedAt = ts; a.level = estimateLevel(attempts); a.updatedAt = ts;
    await store.updateAssessment(a.id, { status: 'finished', finishedAt: ts, level: a.level, currentLevel: a.currentLevel, updatedAt: ts });
    await score(env, store, a, attempts, opts);
    return view(store, a, attempts);
  }
  await store.updateAssessment(a.id, { currentLevel: a.currentLevel, updatedAt: ts });
  attempts.push(await serveNext(env, store, a, attempts, domain, opts));
  return view(store, a, attempts);
}

/** Оценка завершённого теста: письмо — моделью по рубрике и образцу (если ещё не оценено или force), затем пять осей
 *  и уровень по сводному баллу. Ошибка модели не роняет тест: оси считаются по остальным заданиям, причина — в scoringNote. */
export async function score(env: ProviderEnv, store: Store, a: Assessment, attempts: Attempt[], opts: RunOpts = {}, force = false): Promise<Assessment> {
  const now = opts.now ?? (() => new Date().toISOString());
  const items = new Map<string, Item>();
  for (const x of attempts) { if (!items.has(x.itemId)) { const it = await store.getItem(x.itemId); if (it) items.set(x.itemId, it); } }
  const wa = attempts.find(x => x.position === ADAPTIVE_COUNT + 2 && x.answeredAt != null);
  let writing: WritingEval | null = force ? null : parseWritingEval(wa?.detail);
  let note: string | null = null;
  if (wa && !writing) {
    const item = items.get(wa.itemId);
    if (!item || !wa.answer) note = 'письмо не найдено';
    else {
      try {
        writing = await evaluateWriting(env, item, wa.answer, opts);
        const w = writing.axes;
        const wScore = Math.round((w.grammar + w.vocabulary + w.coherence + w.taskResponse) / 4);
        const patch: AttemptPatch = { detail: JSON.stringify(writing), score: wScore, feedback: writing.summary };
        await store.updateAttempt(wa.id, patch);
        Object.assign(wa, patch);
      } catch (e) {
        note = `письмо не оценено: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`;
      }
    }
  } else if (!wa) note = 'письмо не сдано';
  const s = computeAxes(attempts, items, writing, ADAPTIVE_COUNT);
  const ts = now();
  const patch: AssessmentPatch = { axes: s.axes, overall: s.overall, level: s.level, scoredAt: ts, scoringNote: note, updatedAt: ts };
  await store.updateAssessment(a.id, patch);
  Object.assign(a, patch);
  return a;
}

/** Пересчитать последний завершённый тест: письмо оценивается заново, если прошлая оценка не удалась (или force). */
export async function rescore(env: ProviderEnv, store: Store, userId: string, opts: RunOpts = {}, force = false): Promise<View> {
  const a = await store.latestAssessment(userId);
  if (!a || a.status !== 'finished') throw new AssessmentError('assessment_none', 'завершённого теста нет');
  const attempts = await store.listAttempts(a.id);
  await score(env, store, a, attempts, opts, force);
  return view(store, a, attempts);
}

/** Прервать тест насовсем: он помечается abandoned, следующий start начнёт новый. Виденные задания не повторяются. */
export async function abandon(store: Store, userId: string, opts: RunOpts = {}): Promise<boolean> {
  const now = opts.now ?? (() => new Date().toISOString());
  const a = await store.activeAssessment(userId);
  if (!a) return false;
  await store.updateAssessment(a.id, { status: 'abandoned', updatedAt: now() });
  return true;
}

/** Текущее состояние без побочных действий: активный тест (с текущим заданием, если оно выдано) или последний завершённый. */
export async function current(store: Store, userId: string): Promise<View | null> {
  const a = (await store.activeAssessment(userId)) ?? (await store.latestAssessment(userId));
  if (!a || a.status === 'abandoned') return null;
  return view(store, a);
}

// ---------- хранилище D1 ----------

export function d1AssessmentStore(db: D1Database): AssessmentStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const toA = (r: any): Assessment => ({
    id: r.id, userId: r.user_id, kind: r.kind, status: (STATUSES as readonly string[]).includes(r.status) ? r.status : 'active',
    startedAt: r.started_at, finishedAt: r.finished_at ?? null, level: r.level ?? null, currentLevel: r.current_level ?? START_LEVEL, updatedAt: r.updated_at ?? r.started_at,
    axes: r.scored_at ? { grammar: n(r.grammar), vocabulary: n(r.vocabulary), coherence: n(r.coherence), taskResponse: n(r.task_response), fluency: n(r.fluency) } : null,
    overall: n(r.overall), scoredAt: r.scored_at ?? null, scoringNote: r.scoring_note ?? null,
  });
  const toT = (r: any): Attempt => ({
    id: r.id, userId: r.user_id, assessmentId: r.assessment_id, itemId: r.item_id, position: Number(r.position), level: r.level,
    answer: r.answer ?? null, correct: r.correct == null ? null : Number(r.correct), score: r.score == null ? null : Number(r.score),
    feedback: r.feedback ?? null, detail: r.detail ?? null, createdAt: r.created_at, answeredAt: r.answered_at ?? null,
  });
  const COLS: Record<string, string> = {
    status: 'status', currentLevel: 'current_level', level: 'level', finishedAt: 'finished_at', updatedAt: 'updated_at', overall: 'overall', scoredAt: 'scored_at', scoringNote: 'scoring_note',
    grammar: 'grammar', vocabulary: 'vocabulary', coherence: 'coherence', taskResponse: 'task_response', fluency: 'fluency',
    answer: 'answer', correct: 'correct', score: 'score', feedback: 'feedback', detail: 'detail', answeredAt: 'answered_at',
  };
  const setClause = (patch: Record<string, unknown>) => {
    // Оси разворачиваются в отдельные колонки assessments.
    const flat: Record<string, unknown> = { ...patch };
    if (flat.axes && typeof flat.axes === 'object') { Object.assign(flat, flat.axes); delete flat.axes; }
    const keys = Object.keys(flat).filter(k => flat[k] !== undefined && COLS[k]);
    return { sql: keys.map(k => `${COLS[k]} = ?`).join(', '), args: keys.map(k => flat[k]) };
  };
  return {
    async createAssessment(a) {
      await db.prepare('INSERT INTO assessments (id, user_id, kind, status, started_at, finished_at, level, current_level, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(a.id, a.userId, a.kind, a.status, a.startedAt, a.finishedAt, a.level, a.currentLevel, a.updatedAt).run();
    },
    async updateAssessment(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE assessments SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async activeAssessment(userId) {
      const r = await db.prepare("SELECT * FROM assessments WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(userId).first();
      return r ? toA(r) : null;
    },
    async latestAssessment(userId) {
      const r = await db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').bind(userId).first();
      return r ? toA(r) : null;
    },
    async insertAttempt(t) {
      await db.prepare('INSERT INTO attempts (id, user_id, assessment_id, item_id, position, level, answer, correct, score, feedback, detail, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(t.id, t.userId, t.assessmentId, t.itemId, t.position, t.level, t.answer, t.correct, t.score, t.feedback, t.detail, t.createdAt, t.answeredAt).run();
    },
    async updateAttempt(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE attempts SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async listAttempts(assessmentId) {
      const rs = await db.prepare('SELECT * FROM attempts WHERE assessment_id = ? ORDER BY position').bind(assessmentId).all();
      return (rs.results as any[]).map(toT);
    },
    async usedItemIds(userId) {
      const rs = await db.prepare('SELECT DISTINCT item_id FROM attempts WHERE user_id = ? AND item_id IS NOT NULL').bind(userId).all();
      return new Set((rs.results as any[]).map(r => String(r.item_id)));
    },
  };
}
