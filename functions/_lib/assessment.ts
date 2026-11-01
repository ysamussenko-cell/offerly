/** Адаптивный тест уровня: двенадцать заданий на грамматику и лексику с подстройкой сложности после каждого ответа,
 *  затем чтение с двумя вопросами и письмо 60–80 слов. Задания берутся из банка (status = verified) на уровне,
 *  к которому подошёл ученик; если на нужном уровне пусто — соседний уровень, а если пусто и там — модель пишет
 *  задание прямо сейчас через тот же конвейер генерации с проверкой. Каждое выданное задание сразу записывается
 *  в attempts без ответа — это точка продолжения: тест можно прервать и открыть снова с того же места.
 *  Проверка ответов — сравнением с эталоном из банка: буква варианта, буквы двух вопросов, исправленное предложение.
 *  После последнего ответа письмо оценивает модель по рубрике и образцу, считаются пять осей и уровень (scoring.ts);
 *  неверные исправления и выборы варианта и ошибки письма становятся карточками журнала (cards.ts), если хранилище
 *  карточек подключено — повторный пересчёт карточки не дублирует (ключ источника — попытка).
 *  Контрольный срез (4.3) — тот же тест короче: восемь адаптивных заданий вместо двенадцати, старт с уровня последнего
 *  завершённого теста, вид kind=checkpoint; после оценки результат сравнивается с предыдущим завершённым тестом или
 *  срезом по сводному баллу, уровню и осям (comparison). Привязку к дню программы делает checkpoint.ts. */
import type { Env as ProviderEnv } from './providers';
import {
  LEVELS, TOPICS, KIND_LABELS, WRITING_WORDS, generateItems, type Domain, type Item, type ItemStore, type Kind, type Level, type ReadingQuestion, type GenerateOpts,
} from './items';
import {
  AXES, AXIS_LABELS, LEVEL_THRESHOLD, BAND, computeAxes, errorExamples, evaluateWriting, nextStep, parseWritingEval,
  type Axes, type Axis, type ErrorExample, type WritingEval,
} from './scoring';
import { createCards, draftFromItem, draftsFromWriting, type CardStore } from './cards';
import { DomainError } from './errors';
import { longDateRu } from './dates';
import type { Attempt } from './types';

export const ADAPTIVE_COUNT = 12;
export const TOTAL = ADAPTIVE_COUNT + 2; // + чтение + письмо
/** Контрольный срез короче: восемь адаптивных заданий (исправление на 3 и 6), затем чтение и письмо — десять шагов. */
export const CHECKPOINT_ADAPTIVE = 8;
export const CHECKPOINT_TOTAL = CHECKPOINT_ADAPTIVE + 2;
export const START_LEVEL: Level = 'B1';
/** Разница в баллах, которую короткий тест различает; меньше — «в пределах погрешности». */
export const SIGNIFICANT_DELTA = 5;
/** Сколько последних тем не повторять подряд. */
export const TOPIC_MEMORY = 3;
/** Границы письма при приёме ответа: короче — отказ, длиннее — отказ; цель 60–80 остаётся в задании. */
export const ANSWER_WORDS = { min: 30, max: 200 };
/** Минимум ответов на уровне, чтобы уровень засчитывался при оценке. */
export const MIN_AT_LEVEL = 2;

export const STATUSES = ['active', 'finished', 'abandoned'] as const;
export type AssessmentStatus = typeof STATUSES[number];
export const KINDS_OF_ASSESSMENT = ['placement', 'checkpoint', 'baseline'] as const;
export type AssessmentKind = typeof KINDS_OF_ASSESSMENT[number];

export const LEVEL_LABELS: Record<Level, string> = { A2: 'базовый', B1: 'средний', B2: 'выше среднего', C1: 'продвинутый' };

export interface Assessment {
  id: string;
  userId: string;
  /** placement — тест уровня в приложении; checkpoint — контрольный срез (4.3); baseline — исходный срез вне приложения (seed 2.7). */
  kind: AssessmentKind;
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
  /** Сколько первых позиций адаптивные: 12 у теста уровня, 8 у среза. */
  adaptiveCount: number;
  /** День программы (format=checkpoint), по которому пройден срез; null — тест уровня или срез вне плана. */
  programDayId: string | null;
}

/** Длина адаптивной части и всего теста по виду. */
export const planFor = (kind: AssessmentKind) => kind === 'checkpoint' ? { adaptive: CHECKPOINT_ADAPTIVE, total: CHECKPOINT_TOTAL } : { adaptive: ADAPTIVE_COUNT, total: TOTAL };
export const totalOf = (a: Pick<Assessment, 'adaptiveCount'>) => a.adaptiveCount + 2;

export type AssessmentPatch = Partial<Pick<Assessment, 'status' | 'currentLevel' | 'level' | 'finishedAt' | 'updatedAt' | 'axes' | 'overall' | 'scoredAt' | 'scoringNote'>>;
export type AttemptPatch = Partial<Pick<Attempt, 'answer' | 'correct' | 'score' | 'feedback' | 'detail' | 'answeredAt'>>;

export interface AssessmentStore {
  createAssessment(a: Assessment): Promise<void>;
  updateAssessment(id: string, patch: AssessmentPatch): Promise<void>;
  /** Активный тест; с kind — только этого вида (тест уровня и срез не мешают друг другу). */
  activeAssessment(userId: string, kind?: AssessmentKind): Promise<Assessment | null>;
  latestAssessment(userId: string, kind?: AssessmentKind): Promise<Assessment | null>;
  /** Последний завершённый тест или срез — точка отсчёта для программы (3.1) и контрольного среза (4.3). */
  latestFinishedAssessment(userId: string): Promise<Assessment | null>;
  /** Завершённый тест или срез, начатый раньше указанного момента, — с ним сравнивается результат. */
  previousFinishedAssessment(userId: string, beforeStartedAt: string): Promise<Assessment | null>;
  insertAttempt(a: Attempt): Promise<void>;
  updateAttempt(id: string, patch: AttemptPatch): Promise<void>;
  /** Попытки теста по порядку позиций. */
  listAttempts(assessmentId: string): Promise<Attempt[]>;
  /** Все задания, которые пользователь когда-либо видел (любой тест) — не показывать снова. */
  usedItemIds(userId: string): Promise<Set<string>>;
}

export type Store = AssessmentStore & ItemStore & Partial<CardStore>;

/** Источник карточек, заведённых из ошибок теста. */
export const CARD_SOURCE = 'assessment';
/** Ключ источника карточки из попытки теста (письмо — с номером ошибки, см. cards.ts). */
export const attemptOrigin = (attemptId: string) => `attempt:${attemptId}`;

// ---------- план и ход теста ----------

/** Вид задания по позиции: исправление ошибки на каждой третьей, иначе выбор варианта; затем чтение и письмо. */
export function kindAt(position: number, adaptive = ADAPTIVE_COUNT): Kind {
  if (position <= adaptive) return position % 3 === 0 ? 'correction' : 'mcq';
  return position === adaptive + 1 ? 'reading' : 'writing';
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
export function estimateLevel(attempts: Pick<Attempt, 'position' | 'level' | 'correct'>[], adaptive = ADAPTIVE_COUNT): Level {
  const perLevel = new Map<Level, { n: number; ok: number }>();
  for (const a of attempts) {
    if (a.position > adaptive || a.correct == null) continue;
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
  kind: AssessmentKind;
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
  /** После завершения: верные ответы адаптивной части, очки за чтение (0/50/100) и длина письма; у исходного среза null. */
  summary: { adaptiveTotal: number; adaptiveCorrect: number; readingScore: number | null; writingWords: number | null } | null;
  /** После завершения: пять осей, лестница и примеры ошибок; null — оценка ещё не считалась (тест 0.6.0). */
  result: Result | null;
  /** Сравнение с предыдущим завершённым тестом или срезом; null — сравнивать не с чем или оценки ещё нет. */
  comparison: Comparison | null;
  /** Срез по дню программы: id дня; null — тест уровня или срез вне плана. */
  programDayId: string | null;
}

export type LevelChange = 'up' | 'same' | 'down';

/** Сравнение двух оценок: сводный балл, уровень и оси; вывод — честной строкой. */
export interface Comparison {
  previous: { id: string; kind: AssessmentKind; kindLabel: string; finishedAt: string | null; level: Level; overall: number };
  overall: { before: number; after: number; delta: number };
  level: { before: Level; after: Level; change: LevelChange };
  axes: { id: Axis; label: string; before: number | null; after: number | null; delta: number | null }[];
  /** Оси, выросшие или просевшие не меньше чем на SIGNIFICANT_DELTA. */
  improved: Axis[];
  declined: Axis[];
  verdict: string;
}

export const KIND_LABELS_RU: Record<AssessmentKind, string> = { placement: 'тест уровня', checkpoint: 'контрольный срез', baseline: 'исходный срез' };
/** Те же подписи в дательном падеже: «к тесту уровня». */
export const KIND_LABELS_DAT: Record<AssessmentKind, string> = { placement: 'тесту уровня', checkpoint: 'контрольному срезу', baseline: 'исходному срезу' };

export interface Result {
  axes: { id: Axis; label: string; score: number | null }[];
  overall: number;
  level: Level;
  /** Лестница: ступени с нижними порогами и следующая ступень с остатком баллов. */
  ladder: { steps: { level: Level; label: string; from: number }[]; next: { level: Level; points: number } | null };
  examples: ErrorExample[];
  writing: { level: Level; summary: string; rewrite: string | null; errors: number } | null;
  scoredAt: string | null;
  /** Почему письмо не оценено; у исходного среза — как он получен; null — всё посчитано. */
  scoringNote: string | null;
}


/** Задания теста по id — для сводки и примеров ошибок. */
async function itemsOf(store: Store, attempts: Attempt[]): Promise<Map<string, Item>> {
  const m = new Map<string, Item>();
  for (const a of attempts) { if (!m.has(a.itemId)) { const it = await store.getItem(a.itemId); if (it) m.set(a.itemId, it); } }
  return m;
}

export const ladderSteps = () => LEVELS.map((level, i) => ({ level, label: LEVEL_LABELS[level], from: i === 0 ? 0 : i * BAND + LEVEL_THRESHOLD }));

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const idxOf = (l: Level) => LEVELS.indexOf(l);

/** Сравнение завершённой оценки с предыдущей: уровень вырос / не изменился / снизился, сводный балл и оси.
 *  Разница меньше SIGNIFICANT_DELTA называется погрешностью — короткий тест точнее не различает. */
export function compare(a: Pick<Assessment, 'axes' | 'overall' | 'level'>, prev: Pick<Assessment, 'id' | 'kind' | 'finishedAt' | 'axes' | 'overall' | 'level'>): Comparison | null {
  if (!a.axes || a.overall == null || !a.level || !prev.axes || prev.overall == null || !prev.level) return null;
  const delta = a.overall - prev.overall;
  const change: LevelChange = idxOf(a.level) > idxOf(prev.level) ? 'up' : idxOf(a.level) < idxOf(prev.level) ? 'down' : 'same';
  const axes = AXES.map(id => {
    const before = prev.axes![id], after = a.axes![id];
    return { id, label: AXIS_LABELS[id], before, after, delta: before != null && after != null ? after - before : null };
  });
  const improved = axes.filter(x => x.delta != null && x.delta >= SIGNIFICANT_DELTA).map(x => x.id);
  const declined = axes.filter(x => x.delta != null && x.delta <= -SIGNIFICANT_DELTA).map(x => x.id);
  const since = prev.finishedAt ? ` от ${longDateRu(prev.finishedAt)}` : '';
  const vs = `${KIND_LABELS_DAT[prev.kind]}${since}`;
  let verdict: string;
  if (change === 'up') verdict = `Уровень вырос: ${prev.level} → ${a.level}, сводный балл ${signed(delta)} к ${vs} (${prev.overall} → ${a.overall}).`;
  else if (change === 'down') verdict = `Уровень снизился: ${prev.level} → ${a.level}, сводный балл ${signed(delta)} к ${vs} (${prev.overall} → ${a.overall}). Один короткий срез — не приговор, но тему просевших осей стоит повторить.`;
  else if (Math.abs(delta) < SIGNIFICANT_DELTA) verdict = `Уровень не изменился — ${a.level}; сводный балл ${signed(delta)} к ${vs} — в пределах погрешности короткого теста.`;
  else if (delta > 0) {
    const n = nextStep(a.overall);
    verdict = `Уровень тот же — ${a.level}, но сводный балл вырос на ${delta} к ${vs} (${prev.overall} → ${a.overall})${n ? `; до ${n.level} осталось ${n.points}` : ''}.`;
  } else verdict = `Уровень тот же — ${a.level}, но сводный балл снизился на ${-delta} к ${vs} (${prev.overall} → ${a.overall}).`;
  return {
    previous: { id: prev.id, kind: prev.kind, kindLabel: KIND_LABELS_RU[prev.kind], finishedAt: prev.finishedAt, level: prev.level, overall: prev.overall },
    overall: { before: prev.overall, after: a.overall, delta },
    level: { before: prev.level, after: a.level, change },
    axes, improved, declined, verdict,
  };
}

export function buildResult(a: Assessment, attempts: Attempt[], items: Map<string, Item>): Result | null {
  if (!a.axes || a.overall == null || !a.level) return null;
  const writingAttempt = attempts.find(x => x.position === a.adaptiveCount + 2);
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
  let comparison: Comparison | null = null;
  if (a.status === 'finished' && a.kind === 'baseline') {
    // Исходный срез: попыток в приложении нет, оси записаны seed — лестница и радар по ним, примеров ошибок нет (они в журнале).
    result = buildResult(a, [], new Map());
  } else if (a.status === 'finished') {
    const n = a.adaptiveCount;
    const adaptive = list.filter(x => x.position <= n && x.correct != null);
    const reading = list.find(x => x.position === n + 1);
    const writing = list.find(x => x.position === n + 2);
    summary = { adaptiveTotal: adaptive.length, adaptiveCorrect: adaptive.filter(x => x.correct === 1).length, readingScore: reading?.score ?? null, writingWords: writing?.answer ? countWords(writing.answer) : null };
    result = buildResult(a, list, await itemsOf(store, list));
    if (result) {
      const prev = await store.previousFinishedAssessment(a.userId, a.startedAt);
      if (prev) comparison = compare(a, prev);
    }
  }
  return {
    id: a.id, kind: a.kind, status: a.status, total: totalOf(a), answered, current, startedAt: a.startedAt, finishedAt: a.finishedAt,
    level: a.level, levelLabel: a.level ? LEVEL_LABELS[a.level] : null, summary, result, comparison, programDayId: a.programDayId,
  };
}

// ---------- оркестрация ----------

export type AssessmentErrorCode = 'assessment_none' | 'assessment_stale' | 'assessment_finished' | 'assessment_busy' | 'answer_invalid' | 'bank_empty';
const ASSESSMENT_STATUS: Record<AssessmentErrorCode, number> = { assessment_none: 404, assessment_stale: 409, assessment_finished: 409, assessment_busy: 409, answer_invalid: 400, bank_empty: 502 };
export class AssessmentError extends DomainError {
  declare code: AssessmentErrorCode;
  constructor(code: AssessmentErrorCode, message?: string, reason?: string) { super(code, ASSESSMENT_STATUS[code], message, reason); }
}

export interface RunOpts extends GenerateOpts {
  rng?: () => number; now?: () => string; id?: () => string;
  /** Генерировать задание моделью, если в банке пусто (по умолчанию да). */
  generate?: boolean;
  /** Вид теста: placement (по умолчанию) или checkpoint — короче и стартует с уровня последнего завершённого теста. */
  kind?: Exclude<AssessmentKind, 'baseline'>;
  /** День программы, к которому привязан срез (checkpoint.ts). */
  programDayId?: string | null;
}

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
  const kind = kindAt(position, a.adaptiveCount);
  const level = position <= a.adaptiveCount ? a.currentLevel : estimateLevel(attempts, a.adaptiveCount);
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

/** Активный тест нужного вида; если идёт тест другого вида — assessment_busy: два теста сразу не ведутся. */
async function activeOf(store: Store, userId: string, kind: AssessmentKind): Promise<Assessment | null> {
  const a = await store.activeAssessment(userId);
  if (a && a.kind !== kind) throw new AssessmentError('assessment_busy', `сейчас идёт ${KIND_LABELS_RU[a.kind]} — завершите или прервите его`, a.kind);
  return a;
}

/** Начать тест или продолжить начатый: активный тест с заданием без ответа возвращается как есть.
 *  Срез (opts.kind = checkpoint) стартует с уровня последнего завершённого теста или среза. */
export async function startOrResume(env: ProviderEnv, store: Store, userId: string, domain: Domain, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const kind = opts.kind ?? 'placement';
  let a = await activeOf(store, userId, kind);
  if (!a) {
    const ts = now();
    const plan = planFor(kind);
    const prev = kind === 'checkpoint' ? await store.latestFinishedAssessment(userId) : null;
    a = {
      id: id(), userId, kind, status: 'active', startedAt: ts, finishedAt: null, level: null, currentLevel: prev?.level ?? START_LEVEL, updatedAt: ts,
      axes: null, overall: null, scoredAt: null, scoringNote: null, adaptiveCount: plan.adaptive, programDayId: kind === 'checkpoint' ? opts.programDayId ?? null : null,
    };
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
  const a = await activeOf(store, userId, opts.kind ?? 'placement');
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

  if (pending.position <= a.adaptiveCount) {
    a.currentLevel = nextLevel(pending.level, g.correct === 1);
  }
  if (pending.position >= totalOf(a)) {
    // Сначала тест закрывается с предварительным уровнем по адаптивной части — если оценка письма упадёт, тест всё равно завершён.
    a.status = 'finished'; a.finishedAt = ts; a.level = estimateLevel(attempts, a.adaptiveCount); a.updatedAt = ts;
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
  const wa = attempts.find(x => x.position === a.adaptiveCount + 2 && x.answeredAt != null);
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
  const s = computeAxes(attempts, items, writing, a.adaptiveCount);
  const ts = now();
  const patch: AssessmentPatch = { axes: s.axes, overall: s.overall, level: s.level, scoredAt: ts, scoringNote: note, updatedAt: ts };
  await store.updateAssessment(a.id, patch);
  Object.assign(a, patch);
  if (store.insertCards && store.listCards && store.updateCard) await cardsFromAttempts(store as Store & CardStore, a.userId, attempts, items, writing, wa ?? null, ts.slice(0, 10), opts);
  return a;
}

/** Карточки журнала из ошибок теста: неверные исправления и выборы варианта, до трёх ошибок письма (тема — от экзаменатора). */
export async function cardsFromAttempts(store: CardStore, userId: string, attempts: Attempt[], items: Map<string, Item>, writing: WritingEval | null, wa: Attempt | null, today: string, opts: RunOpts = {}) {
  const drafts = [];
  for (const x of attempts) {
    if (x.answeredAt == null || x.correct !== 0) continue;
    const item = items.get(x.itemId);
    const d = item ? draftFromItem(item, x.answer, attemptOrigin(x.id)) : null;
    if (d) drafts.push(d);
  }
  if (writing && wa) drafts.push(...draftsFromWriting(writing.errors, attemptOrigin(wa.id), null));
  return createCards(store, userId, drafts, today, CARD_SOURCE, opts);
}

/** Пересчитать последний завершённый тест: письмо оценивается заново, если прошлая оценка не удалась (или force). */
/** Виды, которые показывает карточка «Тест уровня»: тест в приложении и исходный срез; контрольные срезы — своя карточка. */
const KINDS_OF = (kind: AssessmentKind): AssessmentKind[] => kind === 'placement' ? ['placement', 'baseline'] : [kind];

/** Самый поздний тест одного из видов. */
async function latestOf(store: Store, userId: string, kinds: AssessmentKind[]): Promise<Assessment | null> {
  let best: Assessment | null = null;
  for (const k of kinds) {
    const a = await store.latestAssessment(userId, k);
    if (a && (!best || a.startedAt > best.startedAt)) best = a;
  }
  return best;
}

export async function rescore(env: ProviderEnv, store: Store, userId: string, opts: RunOpts = {}, force = false): Promise<View> {
  const a = await latestOf(store, userId, KINDS_OF(opts.kind ?? 'placement'));
  if (!a || a.status !== 'finished') throw new AssessmentError('assessment_none', 'завершённого теста нет');
  if (a.kind === 'baseline') throw new AssessmentError('assessment_none', 'исходный срез получен вне приложения и не пересчитывается — пройдите тест уровня');
  const attempts = await store.listAttempts(a.id);
  await score(env, store, a, attempts, opts, force);
  return view(store, a, attempts);
}

/** Прервать тест насовсем: он помечается abandoned, следующий start начнёт новый. Виденные задания не повторяются. */
export async function abandon(store: Store, userId: string, opts: RunOpts = {}): Promise<boolean> {
  const now = opts.now ?? (() => new Date().toISOString());
  const a = await store.activeAssessment(userId, opts.kind ?? 'placement');
  if (!a) return false;
  await store.updateAssessment(a.id, { status: 'abandoned', updatedAt: now() });
  return true;
}

/** Текущее состояние без побочных действий: активный тест этого вида (с текущим заданием, если оно выдано)
 *  или последний завершённый; для теста уровня — и исходный срез, пока теста в приложении нет. */
export async function current(store: Store, userId: string, kind: Exclude<AssessmentKind, 'baseline'> = 'placement'): Promise<View | null> {
  const a = (await store.activeAssessment(userId, kind)) ?? (await latestOf(store, userId, KINDS_OF(kind)));
  if (!a || a.status === 'abandoned') return null;
  return view(store, a);
}

// ---------- хранилище D1 ----------

export function d1AssessmentStore(db: D1Database): AssessmentStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const toA = (r: any): Assessment => ({
    id: r.id, userId: r.user_id, kind: (KINDS_OF_ASSESSMENT as readonly string[]).includes(r.kind) ? r.kind : 'placement', status: (STATUSES as readonly string[]).includes(r.status) ? r.status : 'active',
    startedAt: r.started_at, finishedAt: r.finished_at ?? null, level: r.level ?? null, currentLevel: r.current_level ?? START_LEVEL, updatedAt: r.updated_at ?? r.started_at,
    axes: r.scored_at ? { grammar: n(r.grammar), vocabulary: n(r.vocabulary), coherence: n(r.coherence), taskResponse: n(r.task_response), fluency: n(r.fluency) } : null,
    overall: n(r.overall), scoredAt: r.scored_at ?? null, scoringNote: r.scoring_note ?? null,
    adaptiveCount: r.adaptive_count == null ? ADAPTIVE_COUNT : Number(r.adaptive_count), programDayId: r.program_day_id ?? null,
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
      await db.prepare('INSERT INTO assessments (id, user_id, kind, status, started_at, finished_at, level, current_level, updated_at, adaptive_count, program_day_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(a.id, a.userId, a.kind, a.status, a.startedAt, a.finishedAt, a.level, a.currentLevel, a.updatedAt, a.adaptiveCount, a.programDayId).run();
    },
    async updateAssessment(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE assessments SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async activeAssessment(userId, kind) {
      const r = kind
        ? await db.prepare("SELECT * FROM assessments WHERE user_id = ? AND kind = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(userId, kind).first()
        : await db.prepare("SELECT * FROM assessments WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(userId).first();
      return r ? toA(r) : null;
    },
    async latestAssessment(userId, kind) {
      const r = kind
        ? await db.prepare('SELECT * FROM assessments WHERE user_id = ? AND kind = ? ORDER BY started_at DESC LIMIT 1').bind(userId, kind).first()
        : await db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').bind(userId).first();
      return r ? toA(r) : null;
    },
    async latestFinishedAssessment(userId) {
      const r = await db.prepare("SELECT * FROM assessments WHERE user_id = ? AND status = 'finished' ORDER BY started_at DESC LIMIT 1").bind(userId).first();
      return r ? toA(r) : null;
    },
    async previousFinishedAssessment(userId, before) {
      const r = await db.prepare("SELECT * FROM assessments WHERE user_id = ? AND status = 'finished' AND started_at < ? ORDER BY started_at DESC LIMIT 1").bind(userId, before).first();
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
