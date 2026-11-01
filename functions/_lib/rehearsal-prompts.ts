/** Тексты подсказок модели для репетиции интервью (rehearsal.ts): что спросить в каждом из пяти вопросов,
 *  запрос на сценарий, встроенный сценарий на случай сбоя модели и запрос экзаменатору с рубриками вопросов.
 *  Вынесены из rehearsal.ts по обзору 31.10 (раздел 4): тексты длиннее логики и меняются чаще неё.
 *  Модуль не импортирует rehearsal.ts — только типы и справочники нижнего слоя, без циклов. */
import type { ChatMessage } from './providers';
import { LEVELS, domainText, type Domain, type Level } from './items';
import { CARD_TOPICS } from './cards';

export const QUESTION_KINDS = ['experience', 'mistake', 'explain', 'star', 'role'] as const;
export type QuestionKind = typeof QUESTION_KINDS[number];

/** Что должен спросить интервьюер в каждом вопросе — подсказка модели, пишущей сценарий. */
const KIND_BRIEF: Record<QuestionKind, string> = {
  experience: 'ask the candidate to describe the experience most relevant to this role: what exactly they did, at what scale and with what result',
  mistake: 'describe in two or three sentences a realistic professional situation from the candidate\'s field in which something went wrong (a wrong assumption, a missed check, a bad estimate) and ask the candidate to analyse it: what the error was, why it happened and how they would prevent it',
  explain: 'name one specific concept, method or result from the candidate\'s field and ask the candidate to explain it to a non-specialist (a manager or a client) in plain English and say why it matters for the business',
  star: 'a behavioural question that calls for a STAR answer (Situation, Task, Action, Result) about teamwork, conflict, deadline pressure or a hard decision',
  role: 'ask why the candidate wants this role and what they would focus on in the first months, so that they connect their background to the role',
};

/** Сколько фраз экзаменатор предлагает заменить. */
export const REPLACEMENTS = 3;

/** Что подсказке экзаменатора нужно знать о вопросе и ответе — подмножество Turn из rehearsal.ts. */
export interface PromptTurn { position: number; kind: QuestionKind; question: string; rubric: string[]; answer: string | null; speechId: string | null }

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

// ---------- разбор ----------

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
export function reviewPrompt(r: { targetRole: string | null; level: Level }, turns: PromptTurn[], domain: Domain): ChatMessage[] {
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
      `${t.speechId ? "CANDIDATE'S ANSWER (spoken; automatic transcript — ignore punctuation and capitalisation):" : "CANDIDATE'S ANSWER:"}\n${t.answer ?? '(no answer)'}`,
    ].join('\n')),
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
