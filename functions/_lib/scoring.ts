/** Оценка теста уровня по пяти осям концепта: точность грамматики, словарь, связность, ответ на вопрос задания,
 *  беглость речи. Всё, что проверяется сравнением с эталоном (выбор варианта, исправление, чтение), переводится
 *  в баллы 0–100 по единой шкале ступеней: A2 занимает 0–25, B1 — 25–50, B2 — 50–75, C1 — 75–100. Верный ответ
 *  засчитывает верх ступени своего задания, неверный — низ; чтение даёт долю ступени по числу верных вопросов.
 *  Письмо оценивает модель-экзаменатор по рубрике и образцу из банка (эталон задания), по тем же четырём осям
 *  в той же шкале, и возвращает реальные ошибки из текста ученика — они проверяются на присутствие в тексте.
 *  Беглость речи до голосовой реплики (4.2) не оценивается и остаётся пустой; сводный балл считается
 *  по имеющимся осям. Уровень CEFR — ступень, в которую попал сводный балл, с запасом LEVEL_THRESHOLD
 *  от нижней границы: один-два случайных верных ответа на ступени выше уровень не поднимают. */
import { chat, type ChatMessage, type Env as ProviderEnv, PROVIDERS } from './providers';
import { extractJsonObject } from './profile';
import { LEVELS, WRITING_WORDS, topicById, type Item, type Level, type ReadingQuestion } from './items';
import type { Attempt } from './assessment';
import type { GenerateOpts } from './items';
import { CARD_TOPICS } from './cards';

export const AXES = ['grammar', 'vocabulary', 'coherence', 'taskResponse', 'fluency'] as const;
export type Axis = typeof AXES[number];

export const AXIS_LABELS: Record<Axis, string> = {
  grammar: 'Точность грамматики', vocabulary: 'Словарь', coherence: 'Связность', taskResponse: 'Ответ на вопрос задания', fluency: 'Беглость речи',
};

/** Веса осей в сводном балле; отсутствующие оси выпадают, остальные веса перенормируются. */
export const AXIS_WEIGHTS: Record<Axis, number> = { grammar: 0.3, vocabulary: 0.2, coherence: 0.2, taskResponse: 0.2, fluency: 0.1 };

/** Ширина ступени на шкале 0–100. */
export const BAND = 25;
/** Уровень засчитывается, когда балл перешагнул низ ступени на этот запас. */
export const LEVEL_THRESHOLD = 10;

/** Темы, которые проверяют словарь, а не грамматику. */
export const LEXICAL_TOPICS = ['vocabulary', 'register', 'spelling'];

export type Axes = Record<Axis, number | null>;

export const bandStart = (level: Level) => LEVELS.indexOf(level) * BAND;

/** Баллы за задание с эталоном: верно — верх ступени, неверно — низ. */
export const pointsFor = (level: Level, correct: boolean) => bandStart(level) + (correct ? BAND : 0);

/** Баллы за чтение: доля ступени по очкам 0/50/100. */
export const readingPoints = (level: Level, score: number) => bandStart(level) + BAND * Math.max(0, Math.min(100, score)) / 100;

/** Ступень по баллу: порог — низ ступени плюс запас. */
export function scoreToLevel(score: number): Level {
  for (let i = LEVELS.length - 1; i > 0; i--) if (score >= i * BAND + LEVEL_THRESHOLD) return LEVELS[i];
  return LEVELS[0];
}

/** Следующая ступень и сколько баллов до её порога; null — ученик уже на верхней. */
export function nextStep(score: number): { level: Level; points: number } | null {
  const cur = scoreToLevel(score);
  const i = LEVELS.indexOf(cur);
  if (i >= LEVELS.length - 1) return null;
  return { level: LEVELS[i + 1], points: Math.max(1, Math.round((i + 1) * BAND + LEVEL_THRESHOLD - score)) };
}

const round = (x: number) => Math.round(Math.max(0, Math.min(100, x)));

/** Взвешенное среднее по имеющимся частям; все пустые — null. */
export function blend(parts: [number | null, number][]): number | null {
  let sum = 0, w = 0;
  for (const [v, k] of parts) if (v != null && Number.isFinite(v)) { sum += v * k; w += k; }
  return w > 0 ? sum / w : null;
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ---------- оценка письма моделью ----------

export interface WritingError {
  original: string; corrected: string; note: string;
  /** Тема ошибки из справочника карточек (cards.ts); null, если экзаменатор её не назвал. */
  topic?: string | null;
}

export interface WritingEval {
  /** Четыре оси письма в шкале 0–100 (беглость речи письмо не измеряет). */
  axes: { grammar: number; vocabulary: number; coherence: number; taskResponse: number };
  level: Level;
  /** Одна-две строки по-русски: что получилось, что исправить. */
  summary: string;
  /** Реальные ошибки из текста ученика — цитата, исправление, правило одной строкой. */
  errors: WritingError[];
  /** Текст ученика, переписанный с исправленными ошибками; null, если модель его не вернула разумным. */
  rewrite: string | null;
  model: string;
  evaluatedAt: string;
}

export const WRITING_EVAL_SCHEMA = {
  type: 'object',
  properties: {
    grammar: { type: 'integer' }, vocabulary: { type: 'integer' }, coherence: { type: 'integer' }, task_response: { type: 'integer' },
    level: { type: 'string', enum: [...LEVELS] },
    summary: { type: 'string' },
    errors: { type: 'array', items: { type: 'object', properties: { original: { type: 'string' }, corrected: { type: 'string' }, note: { type: 'string' }, topic: { type: 'string', enum: CARD_TOPICS.map(t => t.id) } }, required: ['original', 'corrected', 'note', 'topic'] } },
    rewrite: { type: 'string' },
  },
  required: ['grammar', 'vocabulary', 'coherence', 'task_response', 'level', 'summary', 'errors', 'rewrite'],
};

const SCALE = 'Scale for every axis: 0–25 = A2, 25–50 = B1, 50–75 = B2, 75–100 = C1. The model answer below is written at the target level and scores about the middle of that band; score the learner relative to it.';

/** Запрос экзаменатору письма: задание, рубрика и образец из банка — эталон, с которым сравнивается текст ученика. */
export function writingPrompt(item: Item, text: string): ChatMessage[] {
  const system = [
    'You are a strict but fair examiner of English writing for an interview-preparation coach. You grade a learner\'s short professional text against the task, its rubric and a model answer, and you report only errors that are actually present in the learner\'s text.',
    SCALE,
    'Axes: "grammar" — accuracy of grammar and spelling; "vocabulary" — range and precision of professional vocabulary and collocations; "coherence" — logical flow, linking, paragraphing, clear sentences; "task_response" — whether the text does exactly what the task asks for the stated reader (compare with the model answer; answering a neighbouring question is a low score).',
    '"errors": up to 5 real errors from the learner\'s text, most important first. "original" — the exact words as they appear in the learner\'s text (3–12 words, verbatim); "corrected" — the same fragment corrected; "note" — one line in Russian, up to 120 characters, naming the rule or the better choice; "topic" — the error\'s topic id, one of: ' + CARD_TOPICS.map(t => `${t.id} (${t.hint})`).join('; ') + '. Never invent errors; a clean text gets an empty list.',
    `"rewrite": the learner\'s text rewritten in natural English at the target level with all errors fixed and the task fully answered, keeping the learner\'s ideas and length (${WRITING_WORDS.target[0]}–${WRITING_WORDS.target[1]} words).`,
    '"summary": one or two sentences in Russian for the learner — direct, adult, supportive: what works and what to fix first. No exclamation marks, no emoji.',
    '"level": the overall CEFR level (A2, B1, B2 or C1) of this text.',
    'Return ONLY one JSON object with keys grammar, vocabulary, coherence, task_response, level, summary, errors, rewrite.',
  ].join('\n');
  const user = [
    `Target level of the task: ${item.level}.`,
    `TASK: ${item.prompt}`,
    `RUBRIC (criteria in Russian):\n${(item.rubric ?? []).map(r => `- ${r}`).join('\n')}`,
    `MODEL ANSWER (reference at ${item.level}): ${item.answer}`,
    `LEARNER'S TEXT:\n${text}`,
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? round(n) : null;
};
const normText = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Приводит ответ модели к WritingEval (без model/evaluatedAt); null — если в нём нет четырёх осей.
 *  Ошибки, цитата которых не встречается в тексте ученика, отбрасываются: модель не должна выдумывать. */
export function normalizeWritingEval(raw: unknown, text: string): Omit<WritingEval, 'model' | 'evaluatedAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const grammar = num(o.grammar), vocabulary = num(o.vocabulary), coherence = num(o.coherence), taskResponse = num(o.task_response ?? o.taskResponse);
  if (grammar == null || vocabulary == null || coherence == null || taskResponse == null) return null;
  const axes = { grammar, vocabulary, coherence, taskResponse };
  const lvlRaw = clean(o.level, 4).toUpperCase();
  const level = (LEVELS as readonly string[]).includes(lvlRaw) ? lvlRaw as Level : scoreToLevel(blend([[grammar, 1], [vocabulary, 1], [coherence, 1], [taskResponse, 1]])!);
  const hay = normText(text);
  const errors: WritingError[] = [];
  for (const e of Array.isArray(o.errors) ? o.errors : []) {
    const eo = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const original = clean(eo.original, 300), corrected = clean(eo.corrected, 300), note = clean(eo.note, 200);
    if (!original || !corrected || !note) continue;
    if (!hay.includes(normText(original))) continue;
    if (normText(original) === normText(corrected)) continue;
    if (errors.some(x => normText(x.original) === normText(original))) continue;
    const topicRaw = clean(eo.topic, 40).toLowerCase();
    errors.push({ original, corrected, note, topic: CARD_TOPICS.some(t => t.id === topicRaw) ? topicRaw : null });
    if (errors.length >= 5) break;
  }
  const rw = clean(o.rewrite, 3000);
  const n = countWords(text), wr = countWords(rw);
  const rewrite = rw && wr >= Math.min(WRITING_WORDS.min, n / 2) && wr <= Math.max(WRITING_WORDS.max, n * 2) ? rw : null;
  return { axes, level, summary: clean(o.summary, 600) || 'Оценка без комментария.', errors, rewrite };
}

export type EvalOpts = GenerateOpts;

/** Оценка письма моделью; при неразборчивом ответе — одна повторная попытка, затем ошибка. */
export async function evaluateWriting(env: ProviderEnv, item: Item, text: string, opts: EvalOpts = {}): Promise<WritingEval> {
  const call = opts.chatFn ?? chat;
  const now = opts.now ?? (() => new Date().toISOString());
  const model = opts.model ?? PROVIDERS.find(p => p.id === (opts.provider ?? 'workers-ai'))!.defaultModel;
  const messages = writingPrompt(item, text);
  let lastReply = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0 ? messages : [...messages, { role: 'assistant' as const, content: lastReply.slice(0, 2000) }, { role: 'user' as const, content: 'Your previous answer was not the JSON object described. Return only that JSON object.' }];
    lastReply = await call(env, msgs, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model, maxTokens: 1600, jsonSchema: WRITING_EVAL_SCHEMA });
    const n = normalizeWritingEval(extractJsonObject(lastReply), text);
    if (n) return { ...n, model, evaluatedAt: now() };
  }
  throw new Error(`экзаменатор письма не вернул оценку; ответ: «${lastReply.replace(/\s+/g, ' ').slice(0, 200)}»`);
}

export const parseWritingEval = (s: string | null | undefined): WritingEval | null => {
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && o.axes ? o as WritingEval : null; } catch { return null; }
};

// ---------- пять осей ----------

export interface Scored { axes: Axes; overall: number; level: Level }

/** Считает оси по попыткам теста, заданиям и (если есть) оценке письма. adaptiveCount — сколько первых позиций адаптивные. */
export function computeAxes(attempts: Attempt[], items: Map<string, Item>, writing: WritingEval | null, adaptiveCount: number): Scored {
  const grammarPts: number[] = [], lexPts: number[] = [];
  let reading: number | null = null;
  for (const a of attempts) {
    if (a.answeredAt == null) continue;
    const item = items.get(a.itemId);
    if (a.position <= adaptiveCount) {
      if (a.correct == null) continue;
      (item && LEXICAL_TOPICS.includes(item.topic) ? lexPts : grammarPts).push(pointsFor(a.level, a.correct === 1));
    } else if (item?.kind === 'reading' && a.score != null) {
      reading = readingPoints(a.level, a.score);
    }
  }
  const w = writing?.axes ?? null;
  const axes: Axes = {
    grammar: blend([[mean(grammarPts), 0.7], [w?.grammar ?? null, 0.3]]),
    vocabulary: blend([[mean(lexPts), 0.4], [w?.vocabulary ?? null, 0.6]]),
    coherence: blend([[w?.coherence ?? null, 0.7], [reading, 0.3]]),
    taskResponse: blend([[w?.taskResponse ?? null, 0.75], [reading, 0.25]]),
    fluency: null, // голосовая реплика — 4.2
  };
  for (const k of AXES) if (axes[k] != null) axes[k] = round(axes[k]!);
  const overall = round(blend(AXES.map(k => [axes[k], AXIS_WEIGHTS[k]])) ?? 0);
  return { axes, overall, level: scoreToLevel(overall) };
}

// ---------- три примера ошибок ----------

export interface ErrorExample {
  source: 'writing' | 'correction' | 'mcq' | 'reading';
  /** Как написал ученик. */
  quote: string;
  /** Как надо. */
  correction: string;
  /** Правило одной строкой по-русски. */
  note: string | null;
  topicLabel: string | null;
}

const LETTERS = ['A', 'B', 'C', 'D'];

/** До трёх примеров собственных ошибок: сначала из письма (до двух), затем неверные исправления и выборы варианта,
 *  остаток добирается из письма. Неверный ответ на чтение — в последнюю очередь. */
export function errorExamples(attempts: Attempt[], items: Map<string, Item>, writing: WritingEval | null, limit = 3): ErrorExample[] {
  const fromWriting: ErrorExample[] = (writing?.errors ?? []).map(e => ({ source: 'writing', quote: e.original, correction: e.corrected, note: e.note, topicLabel: null }));
  const corrections: ErrorExample[] = [], mcqs: ErrorExample[] = [], readings: ErrorExample[] = [];
  for (const a of attempts) {
    if (a.answeredAt == null || a.correct !== 0) continue;
    const item = items.get(a.itemId);
    if (!item) continue;
    const topicLabel = topicById(item.topic)?.label ?? item.topic;
    if (item.kind === 'correction') {
      corrections.push({ source: 'correction', quote: a.answer ?? item.prompt, correction: item.answer, note: item.explanation, topicLabel });
    } else if (item.kind === 'mcq') {
      const opts = item.options as string[];
      const chosen = opts[LETTERS.indexOf(a.answer ?? '')] ?? a.answer ?? '';
      const right = opts[LETTERS.indexOf(item.answer)] ?? item.answer;
      mcqs.push({ source: 'mcq', quote: item.prompt.replace('___', chosen), correction: item.prompt.replace('___', right), note: item.explanation, topicLabel });
    } else if (item.kind === 'reading') {
      const qs = item.options as ReadingQuestion[];
      const got = (a.answer ?? '').split(',');
      qs.forEach((q, i) => {
        if (got[i] && got[i] !== q.answer) readings.push({ source: 'reading', quote: `${q.question} — ${q.options[LETTERS.indexOf(got[i])] ?? got[i]}`, correction: q.options[LETTERS.indexOf(q.answer)] ?? q.answer, note: item.explanation, topicLabel });
      });
    }
  }
  const out: ErrorExample[] = [...fromWriting.slice(0, 2), ...corrections, ...mcqs, ...fromWriting.slice(2), ...readings];
  return out.slice(0, limit);
}
