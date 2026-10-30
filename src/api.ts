export type User = { id: string; email: string; name: string | null; locale: string; tz: string };
export type InterviewFormat = 'written' | 'video' | 'ai' | 'unknown';
export type Profile = {
  specialty: string | null; industry: string | null; years: number | null; targetRole: string | null; keywords: string[];
  summary: string | null; resumeName: string | null; resumeAt: string | null; resumeChars: number; analyzed: boolean;
  interviewDate: string | null; interviewFormat: InterviewFormat | null; minutesPerDay: number | null; nativeLanguage: string | null;
  onboardedAt: string | null; onboarded: boolean; updatedAt: string;
};
export type Answers = {
  targetRole: string; interviewDate: string | null; interviewFormat: InterviewFormat; minutesPerDay: number; tz: string; nativeLanguage: string;
};
export type Level = 'A2' | 'B1' | 'B2' | 'C1';
export type ItemKind = 'mcq' | 'correction' | 'reading' | 'writing';
export type ItemStatus = 'draft' | 'verified' | 'rejected';
export type Topic = { id: string; label: string; hint: string };
export type ReadingQuestion = { question: string; options: string[]; answer: string };
export type Item = {
  id: string; kind: ItemKind; level: Level; topic: string; topicLabel: string; domain: string | null;
  prompt: string; options: string[] | ReadingQuestion[] | null; answer: string; rubric: string[] | null; explanation: string | null;
  status: ItemStatus; checkNote: string | null; checkedLevel: Level | null; createdAt: string;
};
export type BankStat = { level: Level; kind: ItemKind; status: ItemStatus; count: number };
export type BankTopics = { levels: Level[]; kinds: { id: ItemKind; label: string }[]; topics: Topic[]; defaultCount: number; maxCount: number };
export type GenerateResult = { ok: true; requested: number; verified: number; rejected: number; dropped: string[]; items: Item[] };
export type AssessmentStatus = 'active' | 'finished' | 'abandoned';
/** placement — тест уровня; checkpoint — контрольный срез; baseline — исходный срез вне приложения. */
export type AssessmentKind = 'placement' | 'checkpoint' | 'baseline';
export type TestItem = {
  attemptId: string; itemId: string; position: number; kind: ItemKind; kindLabel: string; prompt: string;
  options?: string[]; questions?: { question: string; options: string[] }[]; words?: { min: number; max: number };
};
export type Assessment = {
  id: string; kind: AssessmentKind; status: AssessmentStatus; total: number; answered: number; current: TestItem | null;
  startedAt: string; finishedAt: string | null; level: Level | null; levelLabel: string | null;
  summary: { adaptiveTotal: number; adaptiveCorrect: number; readingScore: number | null; writingWords: number | null } | null;
  result: AssessmentResult | null;
};
export type AxisId = 'grammar' | 'vocabulary' | 'coherence' | 'taskResponse' | 'fluency';
export type ErrorExample = { source: 'writing' | 'correction' | 'mcq' | 'reading'; quote: string; correction: string; note: string | null; topicLabel: string | null };
export type AssessmentResult = {
  axes: { id: AxisId; label: string; score: number | null }[];
  overall: number; level: Level;
  ladder: { steps: { level: Level; label: string; from: number }[]; next: { level: Level; points: number } | null };
  examples: ErrorExample[];
  writing: { level: Level; summary: string; rewrite: string | null; errors: number } | null;
  scoredAt: string | null; scoringNote: string | null;
};
export type ErrorCard = {
  id: string; topic: string; topicLabel: string; rule: string | null; example: string | null; correction: string | null;
  source: string | null; due: string | null; reps: number; lapses: number; retired: boolean; createdAt: string;
};
export type DayFormat = 'lesson' | 'rehearsal' | 'checkpoint';
export type WritingFormat = 'review' | 'explain';
export type ProgramDay = {
  id: string; date: string; weekday: string; position: number; week: number; format: DayFormat; formatLabel: string;
  topic: string; topicLabel: string; writing: WritingFormat | null; writingLabel: string | null; reason: string | null;
  status: 'planned' | 'done' | 'skipped'; minutes: number | null; score: number | null; completedAt: string | null; today: boolean; past: boolean;
};
export type Program = {
  generatedAt: string | null; startDate: string; endDate: string; totalDays: number; today: string; interviewDate: string | null;
  counts: { lessons: number; rehearsals: number; checkpoints: number; done: number };
  topics: { id: string; label: string; days: number }[];
  days: ProgramDay[];
};
export type ProgramResponse = { ok: true; days: number; topics: { id: string; label: string }[]; program: Program | null };
export type LessonPart = 'warmup' | 'writing' | 'review';
export type LessonStepCurrent = {
  stepId: string; position: number; part: LessonPart; partLabel: string; kind: ItemKind | 'card'; kindLabel: string; level: Level | null;
  topicLabel: string | null; prompt: string; options?: string[]; words?: { min: number; max: number };
};
export type LessonStepDone = {
  stepId: string; position: number; part: LessonPart; partLabel: string; kind: ItemKind | 'card'; topicLabel: string | null;
  prompt: string; answer: string | null; correct: number | null; score: number | null; feedback: string | null;
  written: string | null; correction: string | null;
  writing: { level: Level; summary: string; rewrite: string | null; errors: { original: string; corrected: string; note: string }[]; axes: { grammar: number; vocabulary: number; coherence: number; taskResponse: number } } | null;
};
export type Lesson = {
  id: string; status: 'active' | 'finished'; date: string; day: ProgramDay | null;
  topic: string; topicLabel: string; writing: WritingFormat | null; writingLabel: string | null; level: Level; minutes: number | null;
  total: number; answered: number;
  parts: { warmup: { total: number; done: number; correct: number }; writing: { done: boolean; score: number | null }; review: { total: number; done: number; correct: number } };
  current: LessonStepCurrent | null; steps: LessonStepDone[]; last: LessonStepDone | null;
  score: number | null; startedAt: string; finishedAt: string | null;
};
export type LessonToday = {
  ok: true; warmup: number; reviewMax: number; today: string; day: ProgramDay | null; available: boolean;
  reason: 'no_program' | 'no_day' | 'rehearsal' | 'checkpoint' | null; lesson: Lesson | null;
};
export type Health = { ok: boolean; version: string; db: 'ok' | 'missing' | 'error'; ai: 'ok' | 'missing' | 'error'; mail?: 'ok' | 'missing' };

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any = {}) { super(code); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'request_failed', j);
  return j as T;
}

const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => call<Health>('/health'),
  me: () => call<{ ok: true; user: User }>('/me'),
  requestCode: (email: string) => post<{ ok: true; delivery: 'email' | 'echo'; code?: string; expiresAt: string }>('/auth/request', { email }),
  verifyCode: (email: string, code: string) => post<{ ok: true; user: User; isNew: boolean }>('/auth/verify', { email, code }),
  logout: () => post<{ ok: true }>('/auth/logout', {}),
  profile: () => call<{ ok: true; profile: Profile | null }>('/profile'),
  uploadResume: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return call<{ ok: true; profile: Profile }>('/resume', { method: 'POST', body: fd });
  },
  pasteResume: (text: string) => post<{ ok: true; profile: Profile }>('/resume', { text }),
  analyzeResume: () => post<{ ok: true; profile: Profile }>('/resume/analyze', {}),
  saveAnswers: (a: Answers) => put<{ ok: true; profile: Profile; user: User }>('/onboarding', a),
  bankTopics: () => call<{ ok: true } & BankTopics>('/items/topics'),
  bankStats: () => call<{ ok: true; stats: BankStat[] }>('/items/stats'),
  bankItems: (q: Partial<Record<'level' | 'topic' | 'kind' | 'status' | 'limit', string>>) =>
    call<{ ok: true; items: Item[] }>(`/items/bank?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  generateItems: (body: { kind: ItemKind; level: Level; topic: string; count: number }) => post<GenerateResult>('/items/generate', body),
  assessment: () => call<{ ok: true; total: number; adaptive: number; assessment: Assessment | null }>('/assessment'),
  startAssessment: () => post<{ ok: true; assessment: Assessment }>('/assessment/start', {}),
  answerAssessment: (attemptId: string, answer: string | string[]) => post<{ ok: true; assessment: Assessment }>('/assessment/answer', { attemptId, answer }),
  abandonAssessment: () => post<{ ok: true; abandoned: boolean }>('/assessment/abandon', {}),
  scoreAssessment: (force = false) => post<{ ok: true; assessment: Assessment }>('/assessment/score', { force }),
  cards: () => call<{ ok: true; topics: { id: string; label: string }[]; cards: ErrorCard[] }>('/cards'),
  program: () => call<ProgramResponse>('/program'),
  generateProgram: () => post<ProgramResponse>('/program/generate', {}),
  swapProgramDays: (a: string, b: string) => post<ProgramResponse>('/program/swap', { a, b }),
  lesson: () => call<LessonToday>('/lesson'),
  startLesson: () => post<{ ok: true; lesson: Lesson }>('/lesson/start', {}),
  answerLesson: (stepId: string, answer: string) => post<{ ok: true; lesson: Lesson }>('/lesson/answer', { stepId, answer }),
};

/** Тексты ошибок API — одной строкой, прямо и без восклицаний. */
export const ERRORS: Record<string, string> = {
  bad_email: 'Адрес почты выглядит неверно.',
  too_many: 'Слишком много кодов подряд. Подождите пятнадцать минут и запросите снова.',
  mail_not_configured: 'Отправка писем пока не настроена. Нужен ключ RESEND_API_KEY в секретах проекта.',
  mail_failed: 'Письмо не ушло: почтовый сервис ответил ошибкой. Попробуйте ещё раз через минуту.',
  bad_input: 'Код — шесть цифр из письма.',
  no_code: 'Код истёк или уже использован. Запросите новый.',
  wrong_code: 'Код не подошёл. Проверьте цифры в письме.',
  locked: 'Пять неверных попыток. Запросите новый код.',
  unauthorized: 'Сессия закончилась. Войдите снова.',
  resume_missing: 'Файл не пришёл. Выберите PDF, DOCX или TXT.',
  resume_unsupported: 'Такой формат не читаю. Нужен PDF, DOCX или обычный текст.',
  resume_too_large: 'Файл больше 8 МБ. Сохраните резюме без картинок или вставьте текст.',
  resume_unreadable: 'Файл повреждён или защищён — открыть не удалось. Попробуйте сохранить его заново.',
  resume_no_text: 'В файле нет текстового слоя — похоже, это скан. Вставьте текст резюме вручную.',
  resume_too_short: 'Текста мало — меньше двухсот знаков. Нужно полное резюме, а не заголовок.',
  profile_failed: 'Текст сохранён, но модель не смогла собрать профиль. Нажмите «Разобрать снова».',
  onboarding_invalid: 'В анкете есть ответ, который сервер не принял. Проверьте поля.',
  items_invalid: 'Сервер не принял параметры: уровень, тема или вид задания вне списка.',
  items_failed: 'Модель не вернула задания. Попробуйте ещё раз через минуту.',
  assessment_none: 'Теста нет: ни начатого, ни завершённого. Нажмите «Начать тест».',
  assessment_stale: 'Это задание уже закрыто — экран обновлён, ответьте на текущее.',
  assessment_finished: 'Тест уже завершён.',
  answer_invalid: 'Ответ не принят: проверьте, что он заполнен.',
  bank_empty: 'В банке нет подходящего задания, и модель не смогла написать новое. Пополните банк и попробуйте снова.',
  program_invalid: 'Переставить не получилось: менять местами можно только два ещё не пройденных занятия, не раньше сегодняшнего дня.',
  lesson_no_day: 'На сегодня нет дня программы. Составьте программу в карточке «Программа».',
  lesson_unavailable: 'Сегодня по программе не занятие: репетиция интервью и контрольный срез появятся в следующих версиях.',
  lesson_none: 'Активного занятия на сегодня нет. Вернитесь на главную и начните занятие.',
  lesson_stale: 'Этот шаг уже закрыт — экран обновлён, ответьте на текущий.',
  lesson_eval_failed: 'Модель не оценила письмо. Текст на месте — отправьте ещё раз через минуту.',
  request_failed: 'Сервер не ответил. Проверьте связь и попробуйте снова.',
};

/** Тексты отказов анкеты по полю и причине — одной строкой. */
export const ANSWER_ERRORS: Record<string, string> = {
  'targetRole:empty': 'Напишите, на какую позицию готовитесь, — хотя бы два знака.',
  'interviewDate:format': 'Дата собеседования записана неверно.',
  'interviewDate:past': 'Эта дата уже прошла. Если собеседование было, поставьте следующее или оставьте поле пустым.',
  'interviewDate:far': 'Дата дальше двух лет. Укажите ближайшее собеседование или оставьте поле пустым.',
  'interviewFormat:unknown': 'Выберите формат из списка.',
  'minutesPerDay:range': 'Минуты в день — целое число от 5 до 180.',
  'tz:unknown': 'Такого часового пояса нет. Выберите из списка.',
  'nativeLanguage:empty': 'Укажите родной язык.',
};

/** Отказы при приёме ответа теста — по причине. */
export const ANSWER_REFUSALS: Record<string, string> = {
  empty: 'Ответ пустой. Выберите вариант или напишите текст.',
  format: 'Ответ не того вида: для выбора — одна буква, для чтения — ответ на оба вопроса, для исправления — предложение целиком.',
  too_short: 'Текст короче тридцати слов. Цель — 60–80 слов.',
  too_long: 'Текст длиннее двухсот слов. Цель — 60–80 слов.',
};

export const errorText = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'onboarding_invalid') {
    return ANSWER_ERRORS[`${e.body?.field}:${e.body?.reason}`] ?? ERRORS.onboarding_invalid;
  }
  if (e instanceof ApiError && e.code === 'answer_invalid') return ANSWER_REFUSALS[String(e.body?.reason)] ?? ERRORS.answer_invalid;
  const base = (e instanceof ApiError && ERRORS[e.code]) || ERRORS.request_failed;
  const detail = e instanceof ApiError && typeof e.body?.detail === 'string' ? e.body.detail : '';
  return detail ? `${base} Ответ сервера: ${detail}` : base;
};
