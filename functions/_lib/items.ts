/** Банк заданий: генерация калиброванных заданий A2–C1 по темам и домену пользователя и второй прогон-проверка.
 *  Модель пишет задания; здесь они проверяются по структуре, очищаются от дублей и отправляются
 *  второй модели-экзаменатору, которая решает задание вслепую и независимо оценивает уровень.
 *  В банк (status = verified) попадают только задания, где ключ совпал с решением экзаменатора,
 *  уровень расходится не больше чем на одну ступень и экзаменатор не нашёл изъянов. Остальные хранятся
 *  как rejected с объяснением — для разбора и чтобы не генерировать то же самое снова. */
import { chat, type ChatMessage, type Env as ProviderEnv, type ProviderId, PROVIDERS } from './providers';
import { extractJsonObject } from './profile';

export const LEVELS = ['A2', 'B1', 'B2', 'C1'] as const;
export type Level = typeof LEVELS[number];

export const KINDS = ['mcq', 'correction', 'reading', 'writing'] as const;
export type Kind = typeof KINDS[number];

export const KIND_LABELS: Record<Kind, string> = {
  mcq: 'выбор варианта', correction: 'исправление ошибки', reading: 'чтение с двумя вопросами', writing: 'письмо 60–80 слов',
};

export const STATUSES = ['draft', 'verified', 'rejected'] as const;
export type Status = typeof STATUSES[number];

export interface Topic { id: string; label: string; hint: string }

/** Темы — из программы концепта (артикли и времена, союзы и инверсия, квантификаторы, глагольные конструкции
 *  и модальные с перфектом, регистр рецензента, орфография) плюс базовые грамматические темы теста уровня. */
export const TOPICS: Topic[] = [
  { id: 'articles', label: 'Артикли', hint: 'a / an / the / zero article with countable, uncountable and abstract nouns' },
  { id: 'tenses', label: 'Времена', hint: 'tense and aspect choice: present perfect vs past simple, continuous forms, narrative tenses' },
  { id: 'conjunctions', label: 'Союзы и инверсия', hint: 'linking words (although, whereas, however, despite), inversion after negative adverbials' },
  { id: 'quantifiers', label: 'Квантификаторы', hint: 'much / many / few / little / a few / each / every / several / most of' },
  { id: 'verb-patterns', label: 'Глагольные конструкции', hint: 'gerund vs infinitive, verb + object + infinitive, reporting verbs' },
  { id: 'modals', label: 'Модальные глаголы', hint: 'modals of obligation, possibility and deduction, perfect modals (should have, must have)' },
  { id: 'conditionals', label: 'Условные предложения', hint: 'zero, first, second, third and mixed conditionals, unless / provided that' },
  { id: 'passive', label: 'Пассив', hint: 'passive voice in reports and process descriptions, causative have / get' },
  { id: 'prepositions', label: 'Предлоги', hint: 'dependent prepositions, prepositions of time and place, prepositional phrases in work contexts' },
  { id: 'relative', label: 'Относительные предложения', hint: 'defining and non-defining relative clauses, which / that / whose / where' },
  { id: 'register', label: 'Регистр рецензента', hint: 'formal professional register, hedging, polite disagreement, reviewer and feedback language' },
  { id: 'spelling', label: 'Орфография и пунктуация', hint: 'commonly confused words, spelling of technical terms, commas and apostrophes' },
  { id: 'vocabulary', label: 'Профессиональная лексика', hint: 'domain vocabulary, collocations and phrasal verbs used in the learner’s field' },
];

export const topicById = (id: unknown): Topic | undefined => TOPICS.find(t => t.id === id);

export const MIN_COUNT = 1;
export const MAX_COUNT = 6;
export const DEFAULT_COUNT = 4;
export const WRITING_WORDS = { min: 50, target: [60, 80] as const, max: 100 };
export const READING_WORDS = { min: 60, max: 220 };

export interface ReadingQuestion { question: string; options: string[]; answer: string }

export interface Item {
  id: string;
  kind: Kind;
  level: Level;
  topic: string;
  domain: string | null;
  /** mcq и correction — само задание; reading — текст; writing — формулировка задания. */
  prompt: string;
  /** mcq — четыре варианта; reading — два вопроса с вариантами и ключами; иначе null. */
  options: string[] | ReadingQuestion[] | null;
  /** mcq — буква верного варианта; reading — буквы через запятую; correction — исправленное предложение; writing — образец ответа. */
  answer: string;
  /** writing — критерии оценки (3–5 строк); иначе null. */
  rubric: string[] | null;
  explanation: string | null;
  status: Status;
  checkNote: string | null;
  checkedLevel: Level | null;
  fingerprint: string;
  source: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

/** Домен пользователя для генерации: берётся из профиля резюме и анкеты. */
export interface Domain { specialty: string | null; industry: string | null; targetRole: string | null; keywords: string[] }

export function domainText(d: Domain): string {
  const who = [d.specialty, d.industry].filter(Boolean).join(', ');
  const role = d.targetRole ? `, preparing for the role of «${d.targetRole}»` : '';
  return (who ? `${who}${role}` : `a professional preparing for an English job interview${role}`);
}

// ---------- генерация ----------

const LEVEL_GUIDE: Record<Level, string> = {
  A2: 'A2 (elementary): short simple sentences of 8–12 words, high-frequency work vocabulary, present and past simple, basic connectors (and, but, because).',
  B1: 'B1 (intermediate): sentences of 12–18 words, common professional vocabulary, present perfect, modals, first conditional, linking words (however, although).',
  B2: 'B2 (upper-intermediate): complex sentences with subordinate clauses, abstract and technical vocabulary, passive, reported speech, second and third conditionals, hedging.',
  C1: 'C1 (advanced): long nuanced sentences, low-frequency and idiomatic vocabulary, inversion, mixed conditionals, perfect modals, subtle register and implication.',
};

const KIND_RULES: Record<Kind, string> = {
  mcq: `Each item: "prompt" — one English sentence from the learner's professional world with exactly one gap written as ___ (three underscores); "options" — exactly four distinct options A–D, only one of them correct, the others plausible errors a learner at this level makes; "answer" — the letter of the correct option (A, B, C or D); "explanation" — one line in Russian (up to 160 characters) stating the rule that decides the answer.`,
  correction: `Each item: "prompt" — one English sentence of 10–25 words from the learner's professional world containing exactly ONE error on the topic (grammar, word choice or spelling); "answer" — the same sentence with that one error corrected and nothing else changed; "explanation" — one line in Russian (up to 160 characters) naming the error and the rule. Do not mark the error in the prompt.`,
  reading: `Each item: "prompt" — a passage of ${READING_WORDS.min}–${READING_WORDS.max} words in English from the learner's professional world (an email, a report excerpt, a meeting summary, a review), written at the target level, where part of the meaning is implied rather than stated; "questions" — exactly two questions, each with "question", exactly four distinct "options" and "answer" (the letter A–D); at least one question must be about an implication, attitude or purpose, not a fact stated verbatim; "explanation" — one line in Russian (up to 160 characters) saying what the passage is about.`,
  writing: `Each item: "prompt" — a writing task in English for a text of ${WRITING_WORDS.target[0]}–${WRITING_WORDS.target[1]} words from the learner's professional world (a short reply to a reviewer, an explanation for a non-specialist, a status update), stating the situation, the reader and what the text must achieve; "rubric" — 3–5 criteria in Russian, one line each, specific to this task (what the text must contain and what level of language is expected); "answer" — a model answer of ${WRITING_WORDS.target[0]}–${WRITING_WORDS.target[1]} words at the target level; "explanation" — one line in Russian (up to 160 characters) about what makes the model answer work.`,
};

const ITEM_PROPS = {
  prompt: { type: 'string' }, answer: { type: 'string' }, explanation: { type: 'string' },
  options: { type: 'array', items: { type: 'string' } },
  rubric: { type: 'array', items: { type: 'string' } },
  questions: { type: 'array', items: { type: 'object', properties: {
    question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' },
  }, required: ['question', 'options', 'answer'] } },
};

/** Схема ответа генератора по виду задания — JSON-режим модели гарантирует разбираемый ответ. */
export function generationSchema(kind: Kind): Record<string, unknown> {
  const req: Record<Kind, string[]> = {
    mcq: ['prompt', 'options', 'answer', 'explanation'], correction: ['prompt', 'answer', 'explanation'],
    reading: ['prompt', 'questions', 'explanation'], writing: ['prompt', 'rubric', 'answer', 'explanation'],
  };
  const props = Object.fromEntries(req[kind].map(k => [k, (ITEM_PROPS as any)[k]]));
  return { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: props, required: req[kind] } } }, required: ['items'] };
}

export interface GenerateRequest { kind: Kind; level: Level; topic: Topic; count: number; domain: Domain }

export function generationPrompt(r: GenerateRequest): ChatMessage[] {
  const terms = r.domain.keywords.slice(0, 20).join(', ');
  const system = [
    'You write calibrated English test items for an interview-preparation coach. Items are used in a placement test, so every item must have one unambiguous key and sit precisely at the stated CEFR level.',
    `Target level: ${LEVEL_GUIDE[r.level]}`,
    `Topic: ${r.topic.label} — ${r.topic.hint}. Every item must test this topic, not something else.`,
    `Learner: ${domainText(r.domain)}.${terms ? ` Professional terms the learner uses: ${terms}.` : ''} Set every item in this professional world, in natural English as spoken in a job interview or written in a work report. Do not invent facts about the learner.`,
    KIND_RULES[r.kind],
    'All items must differ from each other in sentence and situation. No numbering inside texts, no markdown.',
    `Return ONLY one JSON object: {"items": [ ... ]} with exactly ${r.count} items and nothing else.`,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Write ${r.count} ${r.kind} item(s) at ${r.level} on «${r.topic.label}».` }];
}

// ---------- нормализация ----------

const LETTERS = ['A', 'B', 'C', 'D'];
const clean = (v: unknown, max: number): string => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** Текст считается английским, если латинских букв заметно больше кириллических. */
const looksEnglish = (s: string) => (s.match(/[a-z]/gi)?.length ?? 0) > 3 * (s.match(/[а-яё]/gi)?.length ?? 0);
/** Объяснения и рубрики — по-русски: там хоть одна кириллическая буква и их не меньше латинских. */
const looksRussian = (s: string) => { const c = s.match(/[а-яё]/gi)?.length ?? 0; return c > 0 && c >= (s.match(/[a-z]/gi)?.length ?? 0); };

/** Буква ключа: принимает «B», «b)», «B.» или текст одного из вариантов. */
export function answerLetter(raw: unknown, options: string[]): string | null {
  const s = clean(raw, 300);
  const m = /^([A-Da-d])[).:]?$/.exec(s);
  if (m) return m[1].toUpperCase();
  const i = options.findIndex(o => o.toLowerCase() === s.toLowerCase());
  return i >= 0 ? LETTERS[i] : null;
}

function cleanOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const opts = raw.map(o => clean(o, 120).replace(/^[A-Da-d][).:]\s*/, ''));
  if (opts.some(o => !o)) return null;
  if (new Set(opts.map(o => o.toLowerCase())).size !== 4) return null;
  return opts;
}

/** Нормализованный текст для поиска дублей: строчные буквы и цифры без пробелов и знаков. */
export const fingerprintOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '').slice(0, 240);

export type Rejection = { ok: false; reason: string };
export type Normalized = { ok: true; item: Omit<Item, 'id' | 'status' | 'checkNote' | 'checkedLevel' | 'createdAt' | 'verifiedAt' | 'source'> };

/** Структурная проверка одного задания из ответа генератора. Отказ — причина одной строкой. */
export function normalizeItem(raw: unknown, ctx: { kind: Kind; level: Level; topic: string; domain: string | null }): Normalized | Rejection {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'не объект' };
  const o = raw as Record<string, unknown>;
  const prompt = clean(o.prompt, 2000);
  const explanation = clean(o.explanation, 300) || null;
  if (explanation && !looksRussian(explanation)) return { ok: false, reason: 'объяснение не по-русски' };
  const base = { kind: ctx.kind, level: ctx.level, topic: ctx.topic, domain: ctx.domain, prompt, explanation, rubric: null as string[] | null, options: null as Item['options'] };

  switch (ctx.kind) {
    case 'mcq': {
      if (prompt.length < 15 || !looksEnglish(prompt)) return { ok: false, reason: 'формулировка пустая или не по-английски' };
      if (!prompt.includes('___')) return { ok: false, reason: 'в предложении нет пропуска ___' };
      const options = cleanOptions(o.options);
      if (!options) return { ok: false, reason: 'нужно ровно четыре разных варианта' };
      const answer = answerLetter(o.answer, options);
      if (!answer) return { ok: false, reason: 'ключ не указывает на вариант A–D' };
      if (!explanation) return { ok: false, reason: 'нет объяснения' };
      return { ok: true, item: { ...base, options, answer, fingerprint: fingerprintOf(prompt) } };
    }
    case 'correction': {
      const answer = clean(o.answer, 600);
      if (prompt.length < 15 || !looksEnglish(prompt)) return { ok: false, reason: 'предложение пустое или не по-английски' };
      if (answer.length < 15 || !looksEnglish(answer)) return { ok: false, reason: 'исправление пустое или не по-английски' };
      if (fingerprintOf(prompt) === fingerprintOf(answer)) return { ok: false, reason: 'исправление совпадает с исходным предложением' };
      const wp = words(prompt); if (wp < 6 || wp > 40) return { ok: false, reason: `предложение из ${wp} слов — нужно 6–40` };
      if (!explanation) return { ok: false, reason: 'нет объяснения' };
      return { ok: true, item: { ...base, answer, fingerprint: fingerprintOf(prompt) } };
    }
    case 'reading': {
      const w = words(prompt);
      if (!looksEnglish(prompt)) return { ok: false, reason: 'текст не по-английски' };
      if (w < READING_WORDS.min || w > READING_WORDS.max) return { ok: false, reason: `текст из ${w} слов — нужно ${READING_WORDS.min}–${READING_WORDS.max}` };
      const qs = Array.isArray(o.questions) ? o.questions : null;
      if (!qs || qs.length !== 2) return { ok: false, reason: 'нужно ровно два вопроса' };
      const questions: ReadingQuestion[] = [];
      for (const q of qs) {
        const qo = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
        const question = clean(qo.question, 300);
        const options = cleanOptions(qo.options);
        if (question.length < 8 || !options) return { ok: false, reason: 'вопрос без текста или без четырёх вариантов' };
        const answer = answerLetter(qo.answer, options);
        if (!answer) return { ok: false, reason: 'ключ вопроса не указывает на вариант A–D' };
        questions.push({ question, options, answer });
      }
      return { ok: true, item: { ...base, options: questions, answer: questions.map(q => q.answer).join(','), fingerprint: fingerprintOf(prompt) } };
    }
    case 'writing': {
      const answer = clean(o.answer, 1500);
      const rubric = Array.isArray(o.rubric) ? o.rubric.map(r => clean(r, 200)).filter(Boolean) : [];
      if (prompt.length < 30 || !looksEnglish(prompt)) return { ok: false, reason: 'задание пустое или не по-английски' };
      if (rubric.length < 3 || rubric.length > 5) return { ok: false, reason: 'в рубрике должно быть 3–5 критериев' };
      if (!rubric.every(looksRussian)) return { ok: false, reason: 'рубрика не по-русски' };
      const wa = words(answer);
      if (!looksEnglish(answer) || wa < WRITING_WORDS.min || wa > WRITING_WORDS.max) return { ok: false, reason: `образец из ${wa} слов — нужно ${WRITING_WORDS.min}–${WRITING_WORDS.max}` };
      return { ok: true, item: { ...base, rubric, answer, fingerprint: fingerprintOf(prompt) } };
    }
  }
}

/** Разбирает весь ответ генератора; дубли внутри ответа и против банка отбрасываются. */
export function normalizeBatch(raw: unknown, ctx: { kind: Kind; level: Level; topic: string; domain: string | null }, known: Set<string>) {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as any).items) ? (raw as any).items : Array.isArray(raw) ? raw : [];
  const items: Normalized['item'][] = [];
  const rejected: string[] = [];
  const seen = new Set(known);
  for (const r of list) {
    const n = normalizeItem(r, ctx);
    if (!n.ok) { rejected.push(n.reason); continue; }
    if (seen.has(n.item.fingerprint)) { rejected.push('дубль уже имеющегося задания'); continue; }
    seen.add(n.item.fingerprint);
    items.push(n.item);
  }
  return { items, rejected };
}

// ---------- второй прогон: экзаменатор ----------

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    level: { type: 'string', enum: [...LEVELS] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'level', 'issues'],
};

export interface Check { answer: string; level: Level | null; issues: string[] }

const EXAMINER = 'You are an independent examiner of English test items. You judge strictly: an item is good only if exactly one answer is correct, the English is natural, the item tests the stated topic and fits the stated professional context.';

/** Запрос экзаменатору. Для mcq и reading ключ скрыт — экзаменатор решает вслепую; для correction и writing он видит ключ и ищет изъяны. */
export function checkPrompt(item: Normalized['item'], topic: Topic): ChatMessage[] {
  const tail = `Then estimate the CEFR level (A2, B1, B2 or C1) a learner needs to answer it, and list "issues": concrete defects, if any (two options both correct, key wrong, unnatural English, off-topic for «${topic.label}», facts not inferable). An empty list means the item is sound. Return ONLY JSON: {"answer": "...", "level": "...", "issues": [...]}.`;
  let task: string;
  if (item.kind === 'mcq') {
    const opts = (item.options as string[]).map((o, i) => `${LETTERS[i]}. ${o}`).join('\n');
    task = `Solve this gap-fill item. Reply with the letter of the correct option in "answer".\n\n${item.prompt}\n${opts}\n\n${tail}`;
  } else if (item.kind === 'reading') {
    const qs = (item.options as ReadingQuestion[]).map((q, qi) => `Q${qi + 1}. ${q.question}\n` + q.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')).join('\n\n');
    task = `Read the passage and answer both questions. Put the two letters in "answer" separated by a comma, e.g. "B,D".\n\nPASSAGE:\n${item.prompt}\n\n${qs}\n\n${tail}`;
  } else if (item.kind === 'correction') {
    task = `This sentence is said to contain exactly one error; the proposed correction is given. Put your own corrected sentence in "answer". Report an issue if the original has no error, has more than one error, or the proposed correction is wrong or changes more than needed.\n\nSENTENCE: ${item.prompt}\nPROPOSED CORRECTION: ${item.answer}\n\n${tail}`;
  } else {
    task = `Review this writing task, its rubric and the model answer. Put a one-line verdict in "answer". Report an issue if the task is unclear, the rubric does not match the task, or the model answer misses the task, the word range ${WRITING_WORDS.target[0]}–${WRITING_WORDS.target[1]} or the level.\n\nTASK: ${item.prompt}\nRUBRIC:\n${(item.rubric ?? []).map(r => `- ${r}`).join('\n')}\nMODEL ANSWER: ${item.answer}\n\n${tail}`;
  }
  return [{ role: 'system', content: EXAMINER }, { role: 'user', content: `Stated level: ${item.level}. Stated topic: ${topic.label} (${topic.hint}).\n\n${task}` }];
}

export function normalizeCheck(raw: unknown): Check | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const lvl = clean(o.level, 4).toUpperCase().replace(/[^A-C12]/g, '');
  const issues = (Array.isArray(o.issues) ? o.issues : []).map(i => clean(i, 200)).filter(Boolean);
  return { answer: clean(o.answer, 600), level: (LEVELS as readonly string[]).includes(lvl) ? lvl as Level : null, issues };
}

const normLetters = (s: string) => s.toUpperCase().replace(/[^A-D]/g, '').split('').join(',');
const normSentence = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();

/** Решение по заданию: ключ совпал, уровень в пределах одной ступени, изъянов нет — verified; иначе rejected с причиной. */
export function judge(item: Normalized['item'], check: Check | null): { status: Status; note: string; checkedLevel: Level | null } {
  if (!check) return { status: 'rejected', note: 'экзаменатор не ответил разборчиво', checkedLevel: null };
  const hard: string[] = []; // любая запись — отказ
  const soft: string[] = []; // заметки к принятому заданию
  if (item.kind === 'mcq' || item.kind === 'reading') {
    const got = normLetters(check.answer), key = normLetters(item.answer);
    if (got !== key) hard.push(`ключ ${key.replace(/,/g, '')} не совпал с решением экзаменатора ${got.replace(/,/g, '') || '—'}`);
  } else if (item.kind === 'correction' && check.answer && normSentence(check.answer) !== normSentence(item.answer)) {
    // Исправление сформулировано иначе — допустимая вариативность, если экзаменатор не нашёл изъянов; фиксируем в заметке.
    soft.push(`экзаменатор исправил иначе: «${check.answer.slice(0, 120)}»`);
  }
  hard.push(...check.issues);
  const dist = check.level ? Math.abs(LEVELS.indexOf(check.level) - LEVELS.indexOf(item.level)) : 0;
  if (dist > 1) hard.push(`экзаменатор оценил уровень как ${check.level} при заявленном ${item.level}`);
  else if (check.level && check.level !== item.level) soft.push(`экзаменатор видит уровень ${check.level}`);
  if (hard.length) return { status: 'rejected', note: hard.join('; ').slice(0, 500), checkedLevel: check.level };
  return { status: 'verified', note: soft.length ? soft.join('; ').slice(0, 500) : 'ключ и уровень подтверждены', checkedLevel: check.level };
}

// ---------- оркестрация ----------

export interface ItemStore {
  insertItems(items: Item[]): Promise<void>;
  /** Какие из отпечатков уже есть в банке (любой статус). */
  knownFingerprints(fps: string[]): Promise<Set<string>>;
  listItems(f: { level?: Level; topic?: string; kind?: Kind; status?: Status; limit?: number }): Promise<Item[]>;
  /** Сводка банка: число заданий по уровню, виду и статусу. */
  bankStats(): Promise<{ level: Level; kind: Kind; status: Status; count: number }[]>;
  getItem(id: string): Promise<Item | null>;
  /** Принятые (verified) задания вида и уровня в случайном порядке — для теста уровня. */
  randomItems(kind: Kind, level: Level, limit: number): Promise<Item[]>;
}

export interface GenerateOpts { provider?: ProviderId; apiKey?: string; model?: string; chatFn?: typeof chat; now?: () => string; id?: () => string }

export interface GenerateResult { items: Item[]; dropped: string[] }

/** Полный цикл: генерация → структурная проверка и дубли → экзаменатор по каждому заданию (параллельно) → запись в банк. */
export async function generateItems(env: ProviderEnv, store: ItemStore, req: GenerateRequest, opts: GenerateOpts = {}): Promise<GenerateResult> {
  const call = opts.chatFn ?? chat;
  const now = opts.now ?? (() => new Date().toISOString());
  const id = opts.id ?? (() => crypto.randomUUID());
  const source = opts.model ?? PROVIDERS.find(p => p.id === (opts.provider ?? 'workers-ai'))!.defaultModel;
  const chatOpts = { provider: opts.provider, apiKey: opts.apiKey, model: opts.model };
  const ctx = { kind: req.kind, level: req.level, topic: req.topic.id, domain: domainText(req.domain) };

  const reply = await call(env, generationPrompt(req), { ...chatOpts, maxTokens: req.kind === 'mcq' ? 1200 : 2400, jsonSchema: generationSchema(req.kind) });
  const raw = extractJsonObject(reply);
  if (!raw) throw new Error(`генератор не вернул JSON; ответ: «${reply.replace(/\s+/g, ' ').slice(0, 200)}»`);
  const parsed = normalizeBatch(raw, ctx, new Set());
  const known = await store.knownFingerprints(parsed.items.map(i => i.fingerprint));
  const fresh = parsed.items.filter(i => !known.has(i.fingerprint));
  const dropped = [...parsed.rejected, ...parsed.items.filter(i => known.has(i.fingerprint)).map(() => 'дубль уже имеющегося задания')];

  const checked = await Promise.all(fresh.map(async (item) => {
    let v: ReturnType<typeof judge>;
    try {
      const r = await call(env, checkPrompt(item, req.topic), { ...chatOpts, maxTokens: 400, jsonSchema: CHECK_SCHEMA });
      v = judge(item, normalizeCheck(extractJsonObject(r)));
    } catch (e) {
      // Экзаменатор недоступен — задание не принимаем, но и не теряем: причина записана, можно перепроверить позже.
      v = { status: 'rejected', note: `проверка не выполнена: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`, checkedLevel: null };
    }
    const ts = now();
    const full: Item = { ...item, id: id(), status: v.status, checkNote: v.note, checkedLevel: v.checkedLevel, source, createdAt: ts, verifiedAt: v.status === 'verified' ? ts : null };
    return full;
  }));
  if (checked.length) await store.insertItems(checked);
  return { items: checked, dropped };
}

/** Что отдаём наружу. Банк смотрит владелец — ключи и объяснения видны; тест уровня (2.5) отдаёт задания своим маршрутом без ключей. */
export const publicItem = (i: Item) => ({
  id: i.id, kind: i.kind, level: i.level, topic: i.topic, topicLabel: topicById(i.topic)?.label ?? i.topic, domain: i.domain,
  prompt: i.prompt, options: i.options, answer: i.answer, rubric: i.rubric, explanation: i.explanation,
  status: i.status, checkNote: i.checkNote, checkedLevel: i.checkedLevel, createdAt: i.createdAt,
});

/** Проверка тела POST /api/items/generate. */
export function parseGenerateBody(raw: unknown): { ok: true; kind: Kind; level: Level; topic: Topic; count: number } | { ok: false; field: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!(KINDS as readonly string[]).includes(o.kind as string)) return { ok: false, field: 'kind' };
  if (!(LEVELS as readonly string[]).includes(o.level as string)) return { ok: false, field: 'level' };
  const topic = topicById(o.topic);
  if (!topic) return { ok: false, field: 'topic' };
  const n = o.count == null ? DEFAULT_COUNT : typeof o.count === 'number' ? o.count : typeof o.count === 'string' ? parseInt(o.count, 10) : NaN;
  if (!Number.isInteger(n) || n < MIN_COUNT || n > MAX_COUNT) return { ok: false, field: 'count' };
  return { ok: true, kind: o.kind as Kind, level: o.level as Level, topic, count: n };
}

// ---------- хранилище D1 ----------

export function d1ItemStore(db: D1Database): ItemStore {
  const parse = (s: unknown) => { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } };
  const toItem = (r: any): Item => ({
    id: r.id, kind: r.kind, level: r.level, topic: r.topic, domain: r.domain ?? null, prompt: r.prompt,
    options: parse(r.options), answer: r.answer ?? '', rubric: parse(r.rubric), explanation: r.explanation ?? null,
    status: (STATUSES as readonly string[]).includes(r.status) ? r.status : 'draft', checkNote: r.check_note ?? null,
    checkedLevel: r.checked_level ?? null, fingerprint: r.fingerprint ?? '', source: r.source ?? null,
    createdAt: r.created_at, verifiedAt: r.verified_at ?? null,
  });
  return {
    async insertItems(items) {
      if (!items.length) return;
      await db.batch(items.map(i => db.prepare(
        `INSERT INTO items (id, kind, level, topic, domain, prompt, options, answer, rubric, explanation, status, check_note, checked_level, verified_at, fingerprint, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(i.id, i.kind, i.level, i.topic, i.domain, i.prompt, i.options ? JSON.stringify(i.options) : null, i.answer,
        i.rubric ? JSON.stringify(i.rubric) : null, i.explanation, i.status, i.checkNote, i.checkedLevel, i.verifiedAt, i.fingerprint, i.source, i.createdAt)));
    },
    async knownFingerprints(fps) {
      const out = new Set<string>();
      if (!fps.length) return out;
      const rs = await db.prepare(`SELECT fingerprint FROM items WHERE fingerprint IN (${fps.map(() => '?').join(',')})`).bind(...fps).all();
      for (const r of rs.results as any[]) out.add(r.fingerprint);
      return out;
    },
    async listItems(f) {
      const where: string[] = []; const args: unknown[] = [];
      if (f.level) { where.push('level = ?'); args.push(f.level); }
      if (f.topic) { where.push('topic = ?'); args.push(f.topic); }
      if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
      if (f.status) { where.push('status = ?'); args.push(f.status); }
      const sql = `SELECT * FROM items${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
      const rs = await db.prepare(sql).bind(...args, Math.min(Math.max(f.limit ?? 50, 1), 200)).all();
      return (rs.results as any[]).map(toItem);
    },
    async bankStats() {
      const rs = await db.prepare('SELECT level, kind, status, COUNT(*) AS count FROM items GROUP BY level, kind, status').all();
      return (rs.results as any[]).map(r => ({ level: r.level, kind: r.kind, status: r.status ?? 'draft', count: Number(r.count) }));
    },
    async getItem(id) {
      const r = await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
      return r ? toItem(r) : null;
    },
    async randomItems(kind, level, limit) {
      const rs = await db.prepare("SELECT * FROM items WHERE status = 'verified' AND kind = ? AND level = ? ORDER BY RANDOM() LIMIT ?").bind(kind, level, Math.min(Math.max(limit, 1), 200)).all();
      return (rs.results as any[]).map(toItem);
    },
  };
}
