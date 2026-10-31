/** Репетиция интервью текстом (концепт §2): тренер ведёт интервью по сценарию целевой позиции — расскажите
 *  об опыте, разберите ошибку из своей области, объясните понятие неспециалисту, поведенческий вопрос (STAR),
 *  мотивация и позиция. Сценарий пишет модель при старте по профилю резюме и анкете и целиком сохраняется
 *  в rehearsal_turns: у каждого вопроса записано, что должен содержать сильный ответ (rubric) — это эталон,
 *  с которым потом сравниваются ответы. Если модель сценарий не написала — встроенный сценарий по тем же пяти
 *  вопросам с подстановкой позиции (script_model = NULL, ученик это видит).
 *  Как на настоящем интервью, разбора между вопросами нет: ученик отвечает на все вопросы, после последнего
 *  экзаменатор разбирает весь разговор одним вызовом (scoring.ts: та же шкала и оси, что у письма): балл
 *  и строка по каждому ответу, что сказано хорошо, какие три фразы стоит заменить (цитаты проверяются
 *  на присутствие в ответах — модель не должна выдумывать), оценка по пяти осям (беглость речи — с голосом, 4.2).
 *  Три фразы уходят карточками в журнал (cards.ts, source = rehearsal), день программы отмечается пройденным
 *  со сводным баллом. Сбой экзаменатора репетицию не роняет: она закрывается с причиной в review_note,
 *  разбор можно запросить снова (POST /api/rehearsal/review). Репетицию можно начать и вне плана —
 *  в любой день; к дню программы она привязывается, если сегодня по программе репетиция. */
import { chat, type ChatMessage, type Env as ProviderEnv, PROVIDERS } from './providers';
import { extractJsonObject } from './profile';
import { LEVELS, domainText, type Domain, type Level, type GenerateOpts } from './items';
import { AXES, AXIS_LABELS, AXIS_WEIGHTS, blend, scoreToLevel, type Axes, type Axis } from './scoring';
import { CARD_TOPICS, cardTopicById, createCards, type CardDraft, type CardStore } from './cards';
import type { AssessmentStore } from './assessment';
import { publicDay, type ProgramDay, type ProgramStore, type PublicDay } from './program';
import type { Profile } from './profile';
import { todayIn } from './onboarding';

export const QUESTION_KINDS = ['experience', 'mistake', 'explain', 'star', 'role'] as const;
export type QuestionKind = typeof QUESTION_KINDS[number];
export const QUESTION_COUNT = QUESTION_KINDS.length;

export const KIND_LABELS: Record<QuestionKind, string> = {
  experience: 'Опыт', mistake: 'Разбор ошибки', explain: 'Объяснение неспециалисту', star: 'Поведенческий вопрос (STAR)', role: 'Мотивация и позиция',
};

/** Что должен спросить интервьюер в каждом вопросе — подсказка модели, пишущей сценарий. */
const KIND_BRIEF: Record<QuestionKind, string> = {
  experience: 'ask the candidate to describe the experience most relevant to this role: what exactly they did, at what scale and with what result',
  mistake: 'describe in two or three sentences a realistic professional situation from the candidate\'s field in which something went wrong (a wrong assumption, a missed check, a bad estimate) and ask the candidate to analyse it: what the error was, why it happened and how they would prevent it',
  explain: 'name one specific concept, method or result from the candidate\'s field and ask the candidate to explain it to a non-specialist (a manager or a client) in plain English and say why it matters for the business',
  star: 'a behavioural question that calls for a STAR answer (Situation, Task, Action, Result) about teamwork, conflict, deadline pressure or a hard decision',
  role: 'ask why the candidate wants this role and what they would focus on in the first months, so that they connect their background to the role',
};

/** Длина ответа в словах: короче min — отказ, длиннее max — отказ; target — ориентир на экране. */
export const ANSWER_WORDS = { min: 15, target: [40, 150] as const, max: 400 };
/** Сколько фраз экзаменатор предлагает заменить. */
export const REPLACEMENTS = 3;
/** Источник карточек, заведённых из репетиции. */
export const CARD_SOURCE = 'rehearsal';
export const DEFAULT_LEVEL: Level = 'B1';

export const REHEARSAL_STATUSES = ['active', 'finished', 'abandoned'] as const;
export type RehearsalStatus = typeof REHEARSAL_STATUSES[number];

export interface Rehearsal {
  id: string;
  userId: string;
  programDayId: string | null;
  dayDate: string;
  targetRole: string | null;
  level: Level;
  status: RehearsalStatus;
  questionCount: number;
  /** Модель, написавшая сценарий; null — встроенный сценарий. */
  scriptModel: string | null;
  axes: Axes | null;
  overall: number | null;
  /** JSON разбора (RehearsalReview); null — разбора нет. */
  review: string | null;
  reviewNote: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string | null;
}

export interface Turn {
  id: string;
  rehearsalId: string;
  userId: string;
  position: number;
  kind: QuestionKind;
  question: string;
  /** Что должен содержать сильный ответ — по-русски, 1–5 строк. */
  rubric: string[];
  answer: string | null;
  score: number | null;
  feedback: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export type RehearsalPatch = Partial<Pick<Rehearsal, 'status' | 'axes' | 'overall' | 'review' | 'reviewNote' | 'finishedAt' | 'updatedAt'>>;
export type TurnPatch = Partial<Pick<Turn, 'answer' | 'score' | 'feedback' | 'answeredAt'>>;

export interface RehearsalStore {
  createRehearsal(r: Rehearsal, turns: Turn[]): Promise<void>;
  updateRehearsal(id: string, patch: RehearsalPatch): Promise<void>;
  /** Репетиция пользователя за дату: идущая или завершённая прежде брошенной; из нескольких — последняя начатая. */
  rehearsalForDay(userId: string, dayDate: string): Promise<Rehearsal | null>;
  /** Все репетиции пользователя по дате и времени начала. */
  listRehearsals(userId: string): Promise<Rehearsal[]>;
  updateTurn(id: string, patch: TurnPatch): Promise<void>;
  listTurns(rehearsalId: string): Promise<Turn[]>;
}

export type Store = RehearsalStore & CardStore & ProgramStore & Pick<AssessmentStore, 'latestFinishedAssessment'>;

export class RehearsalError extends Error {
  constructor(public code: 'rehearsal_none' | 'rehearsal_stale' | 'rehearsal_finished' | 'answer_invalid' | 'rehearsal_eval_failed', message?: string, public reason?: string) { super(message ?? code); }
}

export interface RunOpts extends GenerateOpts { now?: () => string; id?: () => string }

const round = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? round(n) : null;
};
const normText = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const modelOf = (opts: GenerateOpts) => opts.model ?? PROVIDERS.find(p => p.id === (opts.provider ?? 'workers-ai'))!.defaultModel;

// ---------- сценарий ----------

export interface ScriptQuestion { kind: QuestionKind; question: string; rubric: string[] }

export const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: { type: 'object', properties: { kind: { type: 'string', enum: [...QUESTION_KINDS] }, question: { type: 'string' }, rubric: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'question', 'rubric'] },
    },
  },
  required: ['questions'],
};

const LEVEL_NOTE: Record<Level, string> = {
  A2: 'The candidate is at CEFR A2: ask in short plain sentences and name the thing to talk about explicitly.',
  B1: 'The candidate is at CEFR B1: ask in clear everyday professional English, one idea per sentence.',
  B2: 'The candidate is at CEFR B2: ask as a real hiring manager would, with natural interview phrasing.',
  C1: 'The candidate is at CEFR C1: ask demanding, nuanced questions as a senior interviewer would.',
};

/** Запрос на сценарий интервью: пять вопросов в фиксированном порядке по домену и целевой позиции ученика. */
export function scriptPrompt(domain: Domain, targetRole: string | null, level: Level): ChatMessage[] {
  const role = targetRole ?? domain.targetRole ?? 'the role the candidate is applying for';
  const system = [
    'You are an experienced hiring manager preparing a job interview in English. You write an interview script of exactly five questions for the candidate described below, in this order and of these kinds:',
    ...QUESTION_KINDS.map((k, i) => `${i + 1}. "${k}" — ${KIND_BRIEF[k]}.`),
    'Every question must be rooted in the candidate\'s own field and the target role: name real tools, situations and stakeholders of that field, never generic placeholders. Use only what is given about the candidate; do not invent employers or facts about them.',
    LEVEL_NOTE[level],
    'For each question return: "kind" — one of experience, mistake, explain, star, role; "question" — the interviewer\'s words in English, one to three sentences, at most 70 words; "rubric" — exactly three lines in Russian, each up to 120 characters, stating what a strong answer must contain (content first, then the language expected: structure, tense, register).',
    'Return ONLY one JSON object: {"questions": [ ... five objects ... ]}.',
  ].join('\n');
  const user = [
    `Candidate: ${domainText(domain)}.`,
    `Target role: ${role}.`,
    domain.keywords.length ? `Professional terms from the candidate's résumé: ${domain.keywords.slice(0, 20).join(', ')}.` : 'No résumé terms are available — stay with the specialty and industry.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Приводит ответ модели к сценарию: все пять видов по одному, в нашем порядке; вопрос и рубрика непустые. null — не годится. */
export function normalizeScript(raw: unknown): ScriptQuestion[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as Record<string, unknown>).questions;
  if (!Array.isArray(list)) return null;
  const byKind = new Map<QuestionKind, ScriptQuestion>();
  for (const q of list) {
    const o = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
    const kind = clean(o.kind, 20).toLowerCase() as QuestionKind;
    if (!(QUESTION_KINDS as readonly string[]).includes(kind) || byKind.has(kind)) continue;
    const question = clean(o.question, 600);
    if (question.length < 15) continue;
    const rubric = (Array.isArray(o.rubric) ? o.rubric : []).map(r => clean(r, 200)).filter(Boolean).slice(0, 5);
    if (!rubric.length) continue;
    byKind.set(kind, { kind, question, rubric });
  }
  if (byKind.size !== QUESTION_COUNT) return null;
  return QUESTION_KINDS.map(k => byKind.get(k)!);
}

/** Встроенный сценарий на случай, когда модель сценарий не написала: те же пять вопросов с подстановкой позиции. */
export function defaultScript(targetRole: string | null): ScriptQuestion[] {
  const role = targetRole ? `the role of ${targetRole}` : 'this role';
  return [
    { kind: 'experience', question: `Tell me about the experience that is most relevant to ${role}. What exactly did you do, at what scale, and what came out of it?`,
      rubric: ['Конкретные проекты и своя роль в них, а не общие слова', 'Масштаб и результат — в цифрах или фактах', 'Прошедшее время для завершённых дел, Present Perfect — для опыта в целом'] },
    { kind: 'mistake', question: 'Think of a professional mistake you have seen in your field — a wrong assumption, a missed check or a bad estimate. What exactly went wrong, why did it happen, and how would you prevent it next time?',
      rubric: ['Названа конкретная ошибка и её причина', 'Разделены факт, причина и вывод', 'Связки причины и следствия: because, so that, as a result'] },
    { kind: 'explain', question: 'Pick one concept or method you use every day and explain it to me as if I were a manager without a technical background. Why does it matter for the business?',
      rubric: ['Понятие объяснено без жаргона, с примером или сравнением', 'Есть ответ на «почему это важно», а не только «что это»', 'Короткие ясные предложения, термины расшифрованы'] },
    { kind: 'star', question: 'Tell me about a time when you had to deliver a result under pressure or disagree with a colleague. What was the situation, what did you have to do, what did you do, and what was the result?',
      rubric: ['Все четыре части STAR: ситуация, задача, действия, результат', 'Действия — свои, в первом лице, а не команды в целом', 'Результат назван явно, с последствием для дела'] },
    { kind: 'role', question: `Why do you want ${role}, and what would you focus on in your first three months?`,
      rubric: ['Связь своего опыта с задачами позиции', 'Конкретный план на первые месяцы, а не пожелания', 'Будущие формы и модальные: would, plan to, intend to'] },
  ];
}

/** Сценарий от модели (одна повторная попытка); не получилось — встроенный, model = null. */
export async function writeScript(env: ProviderEnv, domain: Domain, targetRole: string | null, level: Level, opts: GenerateOpts = {}): Promise<{ questions: ScriptQuestion[]; model: string | null; note: string | null }> {
  const call = opts.chatFn ?? chat;
  const messages = scriptPrompt(domain, targetRole, level);
  let note: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await call(env, messages, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model, maxTokens: 1800, jsonSchema: SCRIPT_SCHEMA });
      const qs = normalizeScript(extractJsonObject(reply));
      if (qs) return { questions: qs, model: modelOf(opts), note: null };
      note = `модель не вернула сценарий из пяти вопросов; ответ: «${reply.replace(/\s+/g, ' ').slice(0, 160)}»`;
    } catch (e) {
      note = `модель не ответила: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
    }
  }
  return { questions: defaultScript(targetRole), model: null, note };
}

// ---------- ответ ----------

export function validateAnswer(raw: unknown): { ok: true; answer: string } | { ok: false; reason: 'empty' | 'too_short' | 'too_long' } {
  const s = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim() : '';
  if (!s) return { ok: false, reason: 'empty' };
  const n = countWords(s);
  if (n < ANSWER_WORDS.min) return { ok: false, reason: 'too_short' };
  if (n > ANSWER_WORDS.max) return { ok: false, reason: 'too_long' };
  return { ok: true, answer: s.slice(0, 6000) };
}

// ---------- разбор ----------

export interface Replacement {
  /** Как сказал ученик — цитата из ответа. */
  original: string;
  /** Как сказать сильнее. */
  better: string;
  /** Почему — одной строкой по-русски. */
  note: string;
  /** Тема из справочника карточек; null, если экзаменатор её не назвал. */
  topic: string | null;
}

export interface TurnEval { position: number; score: number; note: string }

export interface RehearsalReview {
  axes: { grammar: number; vocabulary: number; coherence: number; taskResponse: number };
  level: Level;
  /** Две строки по-русски: общее впечатление и что исправить первым. */
  summary: string;
  /** Что сказано хорошо — 1–3 строки по-русски. */
  strengths: string[];
  /** Три фразы заменить. */
  replacements: Replacement[];
  turns: TurnEval[];
  model: string;
  reviewedAt: string;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    grammar: { type: 'integer' }, vocabulary: { type: 'integer' }, coherence: { type: 'integer' }, task_response: { type: 'integer' },
    level: { type: 'string', enum: [...LEVELS] },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    turns: { type: 'array', items: { type: 'object', properties: { position: { type: 'integer' }, score: { type: 'integer' }, note: { type: 'string' } }, required: ['position', 'score', 'note'] } },
    replacements: { type: 'array', items: { type: 'object', properties: { original: { type: 'string' }, better: { type: 'string' }, note: { type: 'string' }, topic: { type: 'string', enum: CARD_TOPICS.map(t => t.id) } }, required: ['original', 'better', 'note', 'topic'] } },
  },
  required: ['grammar', 'vocabulary', 'coherence', 'task_response', 'level', 'summary', 'strengths', 'turns', 'replacements'],
};

const SCALE = 'Scale for every score: 0–25 = A2, 25–50 = B1, 50–75 = B2, 75–100 = C1. The candidate is being prepared for the target level named below; an answer that fully meets a question\'s rubric in natural English of that level scores about the middle of that band.';

/** Запрос экзаменатору: весь разговор с рубриками вопросов — эталон, по которому оцениваются ответы. */
export function reviewPrompt(r: Pick<Rehearsal, 'targetRole' | 'level'>, turns: Turn[], domain: Domain): ChatMessage[] {
  const system = [
    'You are a strict but fair examiner of English for job interviews. You read the transcript of a mock interview (the candidate typed the answers) and grade the candidate against each question and its rubric. You report only what is actually in the candidate\'s answers.',
    SCALE,
    'Axes: "grammar" — accuracy of grammar and spelling across all answers; "vocabulary" — range and precision of professional vocabulary, collocations and interview phrasing; "coherence" — structure within and across answers (clear openings, linking, STAR order, no rambling); "task_response" — whether each answer does what the question asks for that listener (the mistake is analysed, the concept is explained for a non-specialist, the STAR story has a result). Fluency of speech is not graded here.',
    `"turns": one object per question — "position" (the question number), "score" 0–100 on the same scale for that answer, "note" one line in Russian up to 140 characters: the single most useful thing to improve in this answer, or what made it strong.`,
    '"strengths": two or three lines in Russian, each up to 160 characters — what the candidate said well, concretely, quoting a few of the candidate\'s words where possible.',
    `"replacements": exactly ${REPLACEMENTS} phrases from the candidate\'s answers that are worth replacing, most important first — "original" the exact words as they appear in an answer (3–12 words, verbatim); "better" the same idea said the way an interviewer at the target level expects; "note" one line in Russian up to 140 characters saying why; "topic" the topic id, one of: ` + CARD_TOPICS.map(t => `${t.id} (${t.hint})`).join('; ') + '. Prefer phrases that weaken the impression most: vague wording, calques from Russian, grammar slips, wrong register. Never invent words the candidate did not write.',
    '"summary": two sentences in Russian addressed to the candidate as «вы» — direct, adult, supportive: the overall impression an interviewer would get and what to fix first. No exclamation marks, no emoji.',
    '"level": the overall CEFR level (A2, B1, B2 or C1) of the candidate\'s English in this transcript.',
    'Return ONLY one JSON object with keys grammar, vocabulary, coherence, task_response, level, summary, strengths, turns, replacements.',
  ].join('\n');
  const user = [
    `Candidate: ${domainText(domain)}. Target role: ${r.targetRole ?? domain.targetRole ?? 'not specified'}. Target level: ${r.level}.`,
    ...turns.map(t => [
      `QUESTION ${t.position} (${t.kind}): ${t.question}`,
      `WHAT A STRONG ANSWER CONTAINS (Russian):\n${t.rubric.map(x => `- ${x}`).join('\n')}`,
      `CANDIDATE'S ANSWER:\n${t.answer ?? '(no answer)'}`,
    ].join('\n')),
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Приводит ответ модели к разбору; null — нет четырёх осей. Фразы, которых нет в ответах ученика, отбрасываются. */
export function normalizeReview(raw: unknown, turns: Turn[]): Omit<RehearsalReview, 'model' | 'reviewedAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const grammar = num(o.grammar), vocabulary = num(o.vocabulary), coherence = num(o.coherence), taskResponse = num(o.task_response ?? o.taskResponse);
  if (grammar == null || vocabulary == null || coherence == null || taskResponse == null) return null;
  const axes = { grammar, vocabulary, coherence, taskResponse };
  const lvlRaw = clean(o.level, 4).toUpperCase();
  const level = (LEVELS as readonly string[]).includes(lvlRaw) ? lvlRaw as Level : scoreToLevel(blend([[grammar, 1], [vocabulary, 1], [coherence, 1], [taskResponse, 1]])!);
  const hay = normText(turns.map(t => t.answer ?? '').join('\n'));
  const replacements: Replacement[] = [];
  for (const e of Array.isArray(o.replacements) ? o.replacements : []) {
    const eo = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const original = clean(eo.original, 300), better = clean(eo.better ?? eo.corrected, 300), note = clean(eo.note, 200);
    if (!original || !better || !note) continue;
    if (!hay.includes(normText(original))) continue;
    if (normText(original) === normText(better)) continue;
    if (replacements.some(x => normText(x.original) === normText(original))) continue;
    const topicRaw = clean(eo.topic, 40).toLowerCase();
    replacements.push({ original, better, note, topic: cardTopicById(topicRaw) ? topicRaw : null });
    if (replacements.length >= REPLACEMENTS) break;
  }
  const evals: TurnEval[] = [];
  for (const t of Array.isArray(o.turns) ? o.turns : []) {
    const to = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const position = num(to.position), score = num(to.score);
    if (position == null || score == null || !turns.some(x => x.position === position) || evals.some(x => x.position === position)) continue;
    evals.push({ position, score, note: clean(to.note, 200) });
  }
  const strengths = (Array.isArray(o.strengths) ? o.strengths : []).map(s => clean(s, 300)).filter(Boolean).slice(0, 3);
  return { axes, level, summary: clean(o.summary, 600) || 'Разбор без комментария.', strengths, replacements, turns: evals.sort((a, b) => a.position - b.position) };
}

/** Разбор разговора моделью; при неразборчивом ответе — одна повторная попытка, затем ошибка. */
export async function reviewRehearsal(env: ProviderEnv, r: Pick<Rehearsal, 'targetRole' | 'level'>, turns: Turn[], domain: Domain, opts: RunOpts = {}): Promise<RehearsalReview> {
  const call = opts.chatFn ?? chat;
  const now = opts.now ?? (() => new Date().toISOString());
  const messages = reviewPrompt(r, turns, domain);
  let lastReply = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0 ? messages : [...messages, { role: 'assistant' as const, content: lastReply.slice(0, 2000) }, { role: 'user' as const, content: 'Your previous answer was not the JSON object described. Return only that JSON object.' }];
    lastReply = await call(env, msgs, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model, maxTokens: 2200, jsonSchema: REVIEW_SCHEMA });
    const n = normalizeReview(extractJsonObject(lastReply), turns);
    if (n) return { ...n, model: modelOf(opts), reviewedAt: now() };
  }
  throw new Error(`экзаменатор не вернул разбор; ответ: «${lastReply.replace(/\s+/g, ' ').slice(0, 200)}»`);
}

export const parseReview = (s: string | null | undefined): RehearsalReview | null => {
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && o.axes ? o as RehearsalReview : null; } catch { return null; }
};

/** Пять осей репетиции: четыре от экзаменатора, беглость — null до голоса; сводный балл — по весам осей. */
export function rehearsalAxes(review: Pick<RehearsalReview, 'axes'>): { axes: Axes; overall: number; level: Level } {
  const axes: Axes = { grammar: review.axes.grammar, vocabulary: review.axes.vocabulary, coherence: review.axes.coherence, taskResponse: review.axes.taskResponse, fluency: null };
  const overall = round(blend(AXES.map(k => [axes[k], AXIS_WEIGHTS[k]])) ?? 0);
  return { axes, overall, level: scoreToLevel(overall) };
}

/** Ключ источника карточки из фразы репетиции. */
export const replacementOrigin = (rehearsalId: string, index: number) => `rehearsal:${rehearsalId}:r${index + 1}`;

/** Заготовки карточек из фраз: тему называет экзаменатор; без темы — «ответ на вопрос задания». */
export function draftsFromReplacements(reps: Replacement[], rehearsalId: string): CardDraft[] {
  return reps.map((e, i) => ({ topic: cardTopicById(e.topic) ? e.topic as string : 'task-response', rule: e.note || null, example: e.original, correction: e.better, origin: replacementOrigin(rehearsalId, i) }));
}

// ---------- что видит ученик ----------

export interface CurrentTurn { turnId: string; position: number; kind: QuestionKind; kindLabel: string; question: string; words: { min: number; max: number } }

export interface TurnView {
  turnId: string; position: number; kind: QuestionKind; kindLabel: string; question: string; rubric: string[];
  answer: string | null; words: number | null; answered: boolean; score: number | null; feedback: string | null;
}

export interface Result {
  overall: number; level: Level;
  axes: { id: Axis; label: string; score: number | null }[];
  summary: string; strengths: string[];
  replacements: (Replacement & { topicLabel: string | null })[];
  /** Сколько карточек журнала завели фразы (по origin). */
  newCards: number;
  reviewedAt: string;
}

export interface View {
  id: string; status: RehearsalStatus; date: string; day: PublicDay | null;
  targetRole: string | null; level: Level;
  /** Сценарий написан моделью (true) или встроенный (false). */
  scripted: boolean;
  total: number; answered: number;
  current: CurrentTurn | null;
  turns: TurnView[];
  result: Result | null;
  /** Почему разбора нет (сбой модели); null — разбор на месте или репетиция ещё идёт. */
  reviewNote: string | null;
  startedAt: string; finishedAt: string | null;
}

export async function view(store: Pick<Store, 'listCards'>, r: Rehearsal, turns: Turn[], day: ProgramDay | null, today: string): Promise<View> {
  const review = parseReview(r.review);
  const pending = r.status === 'active' ? turns.find(t => t.answeredAt == null) ?? null : null;
  const cards = await store.listCards(r.userId);
  const newCards = cards.filter(c => c.origin?.startsWith(`rehearsal:${r.id}:`)).length;
  const result: Result | null = review && r.overall != null ? {
    overall: r.overall, level: scoreToLevel(r.overall),
    axes: AXES.map(id => ({ id, label: AXIS_LABELS[id], score: r.axes?.[id] ?? null })),
    summary: review.summary, strengths: review.strengths,
    replacements: review.replacements.map(e => ({ ...e, topicLabel: cardTopicById(e.topic)?.label ?? null })),
    newCards, reviewedAt: review.reviewedAt,
  } : null;
  return {
    id: r.id, status: r.status, date: r.dayDate, day: day ? publicDay(day, today) : null, targetRole: r.targetRole, level: r.level, scripted: r.scriptModel != null,
    total: turns.length, answered: turns.filter(t => t.answeredAt != null).length,
    current: pending ? { turnId: pending.id, position: pending.position, kind: pending.kind, kindLabel: KIND_LABELS[pending.kind], question: pending.question, words: { min: ANSWER_WORDS.target[0], max: ANSWER_WORDS.target[1] } } : null,
    turns: turns.map(t => ({ turnId: t.id, position: t.position, kind: t.kind, kindLabel: KIND_LABELS[t.kind], question: t.question, rubric: t.rubric, answer: t.answer, words: t.answer ? countWords(t.answer) : null, answered: t.answeredAt != null, score: t.score, feedback: t.feedback })),
    result, reviewNote: r.reviewNote, startedAt: r.startedAt, finishedAt: r.finishedAt,
  };
}

// ---------- оркестрация ----------

const domainOf = (p: Profile | null): Domain => ({ specialty: p?.specialty ?? null, industry: p?.industry ?? null, targetRole: p?.targetRole ?? null, keywords: p?.keywords ?? [] });

async function dayOf(store: Store, userId: string, today: string): Promise<ProgramDay | null> {
  const all = await store.listProgramDays(userId);
  return all.filter(d => d.dayDate === today && d.format === 'rehearsal').sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0))[0] ?? null;
}

async function dayById(store: Store, id: string | null) { return id ? store.getProgramDay(id) : null; }

export interface TodayInfo { today: string; scheduled: boolean; day: PublicDay | null; rehearsal: View | null; last: View | null }

/** Что сегодня: репетиция ли по программе, сегодняшняя репетиция (идёт или прошла) и последняя завершённая раньше. */
export async function today(store: Store, userId: string, tz: string, opts: RunOpts = {}): Promise<TodayInfo> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const day = await dayOf(store, userId, t);
  const r = await store.rehearsalForDay(userId, t);
  const cur = r && r.status !== 'abandoned' ? r : null;
  const all = await store.listRehearsals(userId);
  const prev = all.filter(x => x.status === 'finished' && x.dayDate < t).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  return {
    today: t, scheduled: !!day, day: day ? publicDay(day, t) : null,
    rehearsal: cur ? await view(store, cur, await store.listTurns(cur.id), day, t) : null,
    last: prev ? await view(store, prev, await store.listTurns(prev.id), await dayById(store, prev.programDayId), t) : null,
  };
}

/** Начать репетицию или продолжить начатую (сегодняшняя активная или завершённая возвращается как есть). */
export async function startOrResume(env: ProviderEnv, store: Store, userId: string, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const t = todayIn(tz, new Date(now()));
  const day = await dayOf(store, userId, t);
  let r = await store.rehearsalForDay(userId, t);
  if (r && r.status === 'abandoned') r = null;
  if (!r) {
    const a = await store.latestFinishedAssessment(userId);
    const level = a?.level ?? DEFAULT_LEVEL;
    const targetRole = profile?.targetRole ?? null;
    const script = await writeScript(env, domainOf(profile), targetRole, level, opts);
    const ts = now();
    const created: Rehearsal = { id: id(), userId, programDayId: day && day.status !== 'done' ? day.id : null, dayDate: t, targetRole, level, status: 'active', questionCount: script.questions.length, scriptModel: script.model, axes: null, overall: null, review: null, reviewNote: script.note ? `сценарий встроенный: ${script.note}` : null, startedAt: ts, finishedAt: null, updatedAt: ts };
    const turns: Turn[] = script.questions.map((q, i) => ({ id: id(), rehearsalId: created.id, userId, position: i + 1, kind: q.kind, question: q.question, rubric: q.rubric, answer: null, score: null, feedback: null, createdAt: ts, answeredAt: null }));
    await store.createRehearsal(created, turns);
    return view(store, created, turns, day, t);
  }
  return view(store, r, await store.listTurns(r.id), day, t);
}

/** Принять ответ на текущий вопрос; после последнего — закрыть репетицию, разобрать разговор, завести карточки,
 *  отметить день программы. Сбой экзаменатора репетицию не роняет — причина в reviewNote. */
export async function answer(env: ProviderEnv, store: Store, userId: string, turnId: unknown, raw: unknown, tz: string, profile: Profile | null, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const r = await store.rehearsalForDay(userId, t);
  if (!r || r.status === 'abandoned') throw new RehearsalError('rehearsal_none', 'репетиции на сегодня нет');
  if (r.status === 'finished') throw new RehearsalError('rehearsal_finished', 'репетиция уже завершена');
  const turns = await store.listTurns(r.id);
  const pending = turns.find(x => x.answeredAt == null);
  if (!pending) throw new RehearsalError('rehearsal_stale', 'вопросов не осталось');
  if (typeof turnId !== 'string' || turnId !== pending.id) throw new RehearsalError('rehearsal_stale', 'ответ относится не к текущему вопросу');
  const v = validateAnswer(raw);
  if (!v.ok) throw new RehearsalError('answer_invalid', undefined, v.reason);
  const ts = now();
  const patch: TurnPatch = { answer: v.answer, answeredAt: ts };
  await store.updateTurn(pending.id, patch);
  Object.assign(pending, patch);
  const day = await dayById(store, r.programDayId);
  if (!turns.some(x => x.answeredAt == null)) {
    const fin: RehearsalPatch = { status: 'finished', finishedAt: ts, updatedAt: ts };
    await store.updateRehearsal(r.id, fin);
    Object.assign(r, fin);
    await score(env, store, r, turns, day, t, profile, opts);
  } else {
    await store.updateRehearsal(r.id, { updatedAt: ts });
  }
  return view(store, r, turns, day, t);
}

/** Разбор завершённой репетиции: оси, сводный балл, баллы по вопросам, карточки из фраз, день программы. */
async function score(env: ProviderEnv, store: Store, r: Rehearsal, turns: Turn[], day: ProgramDay | null, t: string, profile: Profile | null, opts: RunOpts): Promise<boolean> {
  const now = opts.now ?? (() => new Date().toISOString());
  let review: RehearsalReview;
  try { review = await reviewRehearsal(env, r, turns, domainOf(profile), opts); }
  catch (e) {
    const note = `разбор не выполнен: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`;
    await store.updateRehearsal(r.id, { reviewNote: note, updatedAt: now() });
    r.reviewNote = note;
    if (day && day.status !== 'done') { await store.updateProgramDay(day.id, { status: 'done', score: null, completedAt: now(), updatedAt: now() }); day.status = 'done'; }
    return false;
  }
  const s = rehearsalAxes(review);
  const ts = now();
  const patch: RehearsalPatch = { axes: s.axes, overall: s.overall, review: JSON.stringify(review), reviewNote: null, updatedAt: ts };
  await store.updateRehearsal(r.id, patch);
  Object.assign(r, patch);
  for (const t2 of turns) {
    const ev = review.turns.find(x => x.position === t2.position);
    const tp: TurnPatch = { score: ev?.score ?? null, feedback: ev?.note || null };
    await store.updateTurn(t2.id, tp);
    Object.assign(t2, tp);
  }
  await createCards(store, r.userId, draftsFromReplacements(review.replacements, r.id), t, CARD_SOURCE, opts);
  if (day) { await store.updateProgramDay(day.id, { status: 'done', score: s.overall, completedAt: day.completedAt ?? ts, updatedAt: ts }); day.status = 'done'; day.score = s.overall; }
  return true;
}

/** Разобрать заново последнюю завершённую репетицию: когда разбора нет (сбой модели) или force. */
export async function rescore(env: ProviderEnv, store: Store, userId: string, tz: string, profile: Profile | null, force = false, opts: RunOpts = {}): Promise<View> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const all = await store.listRehearsals(userId);
  const r = all.filter(x => x.status === 'finished').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  if (!r) throw new RehearsalError('rehearsal_none', 'завершённой репетиции нет');
  const turns = await store.listTurns(r.id);
  const day = await dayById(store, r.programDayId);
  if (r.review && !force) return view(store, r, turns, day, t);
  const ok = await score(env, store, r, turns, day, t, profile, opts);
  if (!ok) throw new RehearsalError('rehearsal_eval_failed', r.reviewNote ?? 'экзаменатор не вернул разбор');
  return view(store, r, turns, day, t);
}

/** Бросить сегодняшнюю начатую репетицию: следующий start напишет новый сценарий. */
export async function abandon(store: Store, userId: string, tz: string, opts: RunOpts = {}): Promise<boolean> {
  const now = opts.now ?? (() => new Date().toISOString());
  const t = todayIn(tz, new Date(now()));
  const r = await store.rehearsalForDay(userId, t);
  if (!r || r.status !== 'active') return false;
  await store.updateRehearsal(r.id, { status: 'abandoned', updatedAt: now() });
  return true;
}

// ---------- хранилище D1 ----------

export function d1RehearsalStore(db: D1Database): RehearsalStore {
  const n = (v: unknown) => v == null ? null : Number(v);
  const toR = (r: any): Rehearsal => {
    const axes: Axes = { grammar: n(r.grammar), vocabulary: n(r.vocabulary), coherence: n(r.coherence), taskResponse: n(r.task_response), fluency: n(r.fluency) };
    return {
      id: r.id, userId: r.user_id, programDayId: r.program_day_id ?? null, dayDate: r.day_date, targetRole: r.target_role ?? null,
      level: (LEVELS as readonly string[]).includes(r.level) ? r.level : DEFAULT_LEVEL, status: (REHEARSAL_STATUSES as readonly string[]).includes(r.status) ? r.status : 'active',
      questionCount: Number(r.question_count ?? QUESTION_COUNT), scriptModel: r.script_model ?? null,
      axes: AXES.some(k => axes[k] != null) ? axes : null, overall: n(r.overall), review: r.review ?? null, reviewNote: r.review_note ?? null,
      startedAt: r.started_at, finishedAt: r.finished_at ?? null, updatedAt: r.updated_at ?? null,
    };
  };
  const toT = (r: any): Turn => {
    let rubric: string[] = [];
    try { const p = JSON.parse(r.rubric ?? '[]'); if (Array.isArray(p)) rubric = p.map(String); } catch { rubric = []; }
    return {
      id: r.id, rehearsalId: r.rehearsal_id, userId: r.user_id, position: Number(r.position), kind: (QUESTION_KINDS as readonly string[]).includes(r.kind) ? r.kind : 'experience',
      question: r.question, rubric, answer: r.answer ?? null, score: n(r.score), feedback: r.feedback ?? null, createdAt: r.created_at, answeredAt: r.answered_at ?? null,
    };
  };
  const COLS: Record<string, string> = {
    status: 'status', overall: 'overall', review: 'review', reviewNote: 'review_note', finishedAt: 'finished_at', updatedAt: 'updated_at',
    answer: 'answer', score: 'score', feedback: 'feedback', answeredAt: 'answered_at',
  };
  const AXIS_COLS: Record<Axis, string> = { grammar: 'grammar', vocabulary: 'vocabulary', coherence: 'coherence', taskResponse: 'task_response', fluency: 'fluency' };
  const setClause = (patch: Record<string, unknown>) => {
    const sets: string[] = [], args: unknown[] = [];
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) continue;
      if (k === 'axes') { const ax = patch[k] as Axes | null; for (const a of AXES) { sets.push(`${AXIS_COLS[a]} = ?`); args.push(ax ? ax[a] : null); } continue; }
      if (COLS[k]) { sets.push(`${COLS[k]} = ?`); args.push(patch[k]); }
    }
    return { sql: sets.join(', '), args };
  };
  return {
    async createRehearsal(r, turns) {
      await db.batch([
        db.prepare('INSERT INTO rehearsals (id, user_id, program_day_id, day_date, target_role, level, status, question_count, script_model, overall, grammar, vocabulary, coherence, task_response, fluency, review, review_note, started_at, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(r.id, r.userId, r.programDayId, r.dayDate, r.targetRole, r.level, r.status, r.questionCount, r.scriptModel, r.overall, r.axes?.grammar ?? null, r.axes?.vocabulary ?? null, r.axes?.coherence ?? null, r.axes?.taskResponse ?? null, r.axes?.fluency ?? null, r.review, r.reviewNote, r.startedAt, r.finishedAt, r.updatedAt),
        ...turns.map(t => db.prepare('INSERT INTO rehearsal_turns (id, rehearsal_id, user_id, position, kind, question, rubric, answer, score, feedback, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(t.id, t.rehearsalId, t.userId, t.position, t.kind, t.question, JSON.stringify(t.rubric), t.answer, t.score, t.feedback, t.createdAt, t.answeredAt)),
      ]);
    },
    async updateRehearsal(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE rehearsals SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async rehearsalForDay(userId, dayDate) {
      const r = await db.prepare("SELECT * FROM rehearsals WHERE user_id = ? AND day_date = ? ORDER BY (status = 'abandoned'), started_at DESC LIMIT 1").bind(userId, dayDate).first();
      return r ? toR(r) : null;
    },
    async listRehearsals(userId) {
      const rs = await db.prepare('SELECT * FROM rehearsals WHERE user_id = ? ORDER BY day_date, started_at').bind(userId).all();
      return (rs.results as any[]).map(toR);
    },
    async updateTurn(id, patch) {
      const s = setClause(patch); if (!s.sql) return;
      await db.prepare(`UPDATE rehearsal_turns SET ${s.sql} WHERE id = ?`).bind(...s.args, id).run();
    },
    async listTurns(rehearsalId) {
      const rs = await db.prepare('SELECT * FROM rehearsal_turns WHERE rehearsal_id = ? ORDER BY position').bind(rehearsalId).all();
      return (rs.results as any[]).map(toT);
    },
  };
}
