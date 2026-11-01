export type User = { id: string; email: string; name: string | null; locale: string; tz: string };
export type InterviewFormat = 'written' | 'video' | 'ai' | 'unknown';
export type Profile = {
  specialty: string | null; industry: string | null; years: number | null; targetRole: string | null; keywords: string[];
  summary: string | null; resumeName: string | null; resumeAt: string | null; resumeChars: number; analyzed: boolean;
  interviewDate: string | null; interviewFormat: InterviewFormat | null; minutesPerDay: number | null; nativeLanguage: string | null;
  onboardedAt: string | null; onboarded: boolean; targetLevel: string | null; weeklyGoalMinutes: number | null; notifyAt: string | null; digestSentOn: string | null; updatedAt: string;
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
/** Режим экрана теста и среза: пройти задания или открыть разбор завершённого. */
export type AssessmentMode = 'test' | 'result';
export type TestItem = {
  attemptId: string; itemId: string; position: number; kind: ItemKind; kindLabel: string; prompt: string;
  options?: string[]; questions?: { question: string; options: string[] }[]; words?: { min: number; max: number };
};
export type Assessment = {
  id: string; kind: AssessmentKind; status: AssessmentStatus; total: number; answered: number; current: TestItem | null;
  startedAt: string; finishedAt: string | null; level: Level | null; levelLabel: string | null;
  summary: { adaptiveTotal: number; adaptiveCorrect: number; readingScore: number | null; writingWords: number | null } | null;
  result: AssessmentResult | null;
  /** Сравнение с предыдущим завершённым тестом или срезом; null — сравнивать не с чем. */
  comparison: Comparison | null;
  programDayId: string | null;
};
export type AxisId = 'grammar' | 'vocabulary' | 'coherence' | 'taskResponse' | 'fluency';
export type LevelChange = 'up' | 'same' | 'down';
export type Comparison = {
  previous: { id: string; kind: AssessmentKind; kindLabel: string; finishedAt: string | null; level: Level; overall: number };
  overall: { before: number; after: number; delta: number };
  level: { before: Level; after: Level; change: LevelChange };
  axes: { id: AxisId; label: string; before: number | null; after: number | null; delta: number | null }[];
  improved: AxisId[]; declined: AxisId[];
  verdict: string;
};
/** Контрольный срез: тот же тест короче, плюс день программы и признак пересборки программы. */
export type Checkpoint = Assessment & { day: ProgramDay | null; programAdjusted: boolean };
export type CheckpointMeta = { total: number; adaptive: number; significant: number };
export type CheckpointToday = CheckpointMeta & { ok: true; today: string; scheduled: boolean; day: ProgramDay | null; next: ProgramDay | null; checkpoint: Checkpoint | null; finishedToday: boolean };
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
  source: string | null; due: string | null; reps: number; lapses: number; streak: number; left: number; reviewedAt: string | null; retired: boolean; createdAt: string;
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
export type LessonPart = 'warmup' | 'writing' | 'review' | 'bonus';
export type BonusState = 'offered' | 'declined' | 'active' | 'correct' | 'wrong';
export type LessonStepCurrent = {
  stepId: string; position: number; part: LessonPart; partLabel: string; kind: ItemKind | 'card'; kindLabel: string; level: Level | null;
  topicLabel: string | null; prompt: string; options?: string[]; words?: { min: number; max: number };
};
export type LessonStepDone = {
  stepId: string; position: number; part: LessonPart; partLabel: string; kind: ItemKind | 'card'; topicLabel: string | null;
  prompt: string; answer: string | null; correct: number | null; score: number | null; feedback: string | null;
  written: string | null; correction: string | null;
  writing: { level: Level; summary: string; rewrite: string | null; errors: { original: string; corrected: string; note: string; topic?: string | null }[]; axes: { grammar: number; vocabulary: number; coherence: number; taskResponse: number } } | null;
  card: { id: string; due: string | null; streak: number; left: number; retired: boolean } | null;
  newCards: number;
};
export type Lesson = {
  id: string; status: 'active' | 'finished'; date: string; day: ProgramDay | null;
  topic: string; topicLabel: string; writing: WritingFormat | null; writingLabel: string | null; level: Level; minutes: number | null;
  total: number; answered: number;
  parts: { warmup: { total: number; done: number; correct: number }; writing: { done: boolean; score: number | null }; review: { total: number; done: number; correct: number } };
  current: LessonStepCurrent | null; steps: LessonStepDone[]; last: LessonStepDone | null;
  score: number | null; startedAt: string; finishedAt: string | null;
  /** Бонусная задача после занятия: предложена, отклонена, выдана (current — её шаг) или решена (step — разбор). */
  bonus: { status: BonusState; level: Level; kind: ItemKind; multiplier: number; step: LessonStepDone | null } | null;
};
export type LessonMeta = { warmup: number; reviewMax: number; bonusMultiplier: number; bonusChance: number };
export type LessonToday = LessonMeta & {
  ok: true; today: string; day: ProgramDay | null; available: boolean;
  reason: 'no_program' | 'no_day' | 'rehearsal' | 'checkpoint' | null; lesson: Lesson | null;
};
export type AchievementGroup = 'topic' | 'writing' | 'stretch' | 'cards' | 'bonus' | 'lesson';
export type Achievement = {
  code: string; title: string; description: string; group: AchievementGroup; groupLabel: string;
  unlocked: boolean; unlockedAt: string | null; detail: string | null; new: boolean; progress: { value: number; target: number };
};
export type Achievements = { ok: true; total: number; unlocked: number; fresh: number; achievements: Achievement[] };
export type WeekStatus = 'done' | 'active' | 'today' | 'planned' | 'missed' | 'frozen' | 'unavailable' | 'free';
export type WeekDay = { date: string; weekday: string; today: boolean; past: boolean; day: ProgramDay | null; status: WeekStatus; minutes: number; score: number | null };
export type Dashboard = {
  ok: true; gainPerLesson: number; missPenalty: number; missCap: number; freezesPerWeek: number; goalMin: number; goalMax: number; goalDays: number; bonusMultiplier: number;
  today: string;
  readiness: {
    value: number | null; base: number | null; baseKind: AssessmentKind | null; baseDate: string | null; level: Level | null;
    gained: number; lost: number; lessons: number; bonuses: number; missed: number;
    forecast: { perDay: number; next: { level: Level; points: number; days: number | null } | null; atInterview: number | null; target: { level: Level; points: number; reached: boolean } };
  };
  countdown: { interviewDate: string | null; daysLeft: number | null };
  streak: { current: number; best: number; todayDone: boolean; freezeAvailable: boolean; frozen: string[]; missed: string[]; lastDone: string | null };
  goal: { minutes: number; custom: boolean; done: number; left: number; default: number; percent: number };
  week: WeekDay[];
  program: { exists: boolean; endDate: string | null; done: number; total: number };
};
export type RehearsalKind = 'experience' | 'mistake' | 'explain' | 'star' | 'role';
export type SpeechMetrics = { words: number; duration: number; wpm: number; pauses: number; longestPause: number; fillers: number; fluency: number };
/** Запись речи после распознавания: расшифровка и мерки; id передаётся с ответом репетиции. */
export type Speech = SpeechMetrics & { id: string; text: string; createdAt: string };
export type VoiceMeta = { maxBytes: number; maxSeconds: number; maxChars: number; stt: string; tts: string };
export type RehearsalTurn = {
  turnId: string; position: number; kind: RehearsalKind; kindLabel: string; question: string; rubric: string[];
  answer: string | null; words: number | null; answered: boolean; score: number | null; feedback: string | null;
  /** Мерки речи, если ответ продиктован голосом. */
  speech: SpeechMetrics | null;
};
export type Replacement = { original: string; better: string; note: string; topic: string | null; topicLabel: string | null };
export type RehearsalResult = {
  overall: number; level: Level; axes: { id: AxisId; label: string; score: number | null }[];
  summary: string; strengths: string[]; replacements: Replacement[]; newCards: number; reviewedAt: string;
};
export type Rehearsal = {
  id: string; status: 'active' | 'finished' | 'abandoned'; date: string; day: ProgramDay | null;
  targetRole: string | null; level: Level; scripted: boolean; total: number; answered: number; spoken: number;
  current: { turnId: string; position: number; kind: RehearsalKind; kindLabel: string; question: string; words: { min: number; max: number } } | null;
  turns: RehearsalTurn[]; result: RehearsalResult | null; reviewNote: string | null; startedAt: string; finishedAt: string | null;
};
export type RehearsalMeta = { questions: number; words: { min: number; target: readonly [number, number]; max: number }; replacements: number };
export type RehearsalToday = RehearsalMeta & { ok: true; today: string; scheduled: boolean; day: ProgramDay | null; rehearsal: Rehearsal | null; last: Rehearsal | null };
export type DigestState = 'off' | 'sent' | 'early' | 'due' | 'late';
export type Digest = {
  ok: true; defaultAt: string; windowMinutes: number; stepMinutes: number;
  notifyAt: string | null; enabled: boolean; tz: string; localTime: string; today: string; state: DigestState; sentOn: string | null;
  next: { date: string; time: string } | null; mail: 'ok' | 'missing';
  preview?: { subject: string; text: string; headline: string; dueCards: number };
};
export type PushDevice = { id: string; device: string; createdAt: string; lastSentAt: string | null; lastError: string | null };
export type Push = {
  ok: true; defaultAt: string; windowMinutes: number; stepMinutes: number; publicKey: string; keySource: 'env' | 'db';
  pushAt: string | null; enabled: boolean; tz: string; localTime: string; today: string; state: DigestState; sentOn: string | null; note: string | null;
  next: { date: string; time: string } | null; subscriptions: PushDevice[];
};
export type PushDelivery = { id: string; ok: boolean; status: number; gone: boolean; detail: string | null };
/** Напоминание дня для приложения Windows: срок и текст без отправки (GET /push/reminder). */
export type PushReminder = { ok: true; at: string; tz: string; localTime: string; today: string; windowMinutes: number; todayDone: boolean; reminder: { title: string; body: string } };
export type PushSendResult = { ok: true; delivered: number; devices: PushDelivery[]; reminder: { title: string; body: string; url: string; tag: string } };
export type ProviderOption = { id: string; name: string; short: string; keyUrl: string | null; defaultModel: string; prefix: string | null; free: boolean };
/** Сохранённый ключ провайдера — без самого ключа: провайдер, модель, последние четыре знака, читается ли текущим мастер-ключом, итог проверки. */
export type ProviderKeyInfo = {
  provider: string; providerName: string; short: string; model: string | null; custom: boolean; hint: string; readable: boolean;
  checkedAt: string | null; checkNote: string | null; createdAt: string; updatedAt: string;
};
export type Settings = {
  ok: true;
  provider: { key: ProviderKeyInfo | null; keySource: 'env' | 'db'; providers: ProviderOption[]; builtin: string };
  notifications: {
    tz: string; localTime: string; defaultAt: string; windowMinutes: number;
    mail: { at: string | null; enabled: boolean; configured: boolean };
    push: { at: string | null; enabled: boolean; devices: number };
  };
  data: { counts: { assessments: number; cards: number; programDays: number; lessons: number; rehearsals: number; speeches: number }; file: string };
  /** После проверки ключа — ответ модели. */
  reply?: string;
  removed?: boolean;
};
/** Релиз десктопной сборки для страницы установки (5.1): установщик Windows из latest.json последнего релиза GitHub. */
export type Release =
  | { ok: true; available: true; version: string; publishedAt: string | null; notes: string | null; windows: { url: string; name: string; signed: boolean }; releasesUrl: string }
  | { ok: true; available: false; reason: 'none' | 'no_windows' | 'error'; detail: string | null; releasesUrl: string };
export type Health = { ok: boolean; version: string; db: 'ok' | 'missing' | 'error'; ai: 'ok' | 'missing' | 'error'; mail?: 'ok' | 'missing'; push?: 'env' | 'db' | 'pending' | 'error' };

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any = {}) { super(code); }
}

/** Запрос не дошёл до сервера: offline — браузер знает, что сети нет; network — сеть есть, но сервер не ответил. */
export const networkFailure = (online: boolean) => new ApiError(0, online ? 'network' : 'offline');

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw networkFailure(typeof navigator === 'undefined' || navigator.onLine !== false);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'request_failed', j);
  return j as T;
}

/** Запрос, отдающий не JSON, а файл (озвучка): ошибки по-прежнему приходят JSON-ом. */
async function callBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  let r: Response;
  try { r = await fetch(`/api${path}`, { credentials: 'same-origin', ...init }); }
  catch { throw networkFailure(typeof navigator === 'undefined' || navigator.onLine !== false); }
  if (!r.ok) { const j: any = await r.json().catch(() => ({})); throw new ApiError(r.status, j.error ?? 'request_failed', j); }
  return r.blob();
}

const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => call<Health>('/health'),
  release: () => call<Release>('/release'),
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
  checkpoint: () => call<CheckpointToday>('/checkpoint'),
  startCheckpoint: () => post<{ ok: true; checkpoint: Checkpoint }>('/checkpoint/start', {}),
  answerCheckpoint: (attemptId: string, answer: string | string[]) => post<{ ok: true; checkpoint: Checkpoint }>('/checkpoint/answer', { attemptId, answer }),
  abandonCheckpoint: () => post<{ ok: true; abandoned: boolean }>('/checkpoint/abandon', {}),
  scoreCheckpoint: (force = false) => post<{ ok: true; checkpoint: Checkpoint }>('/checkpoint/score', { force }),
  cards: () => call<{ ok: true; topics: { id: string; label: string }[]; cards: ErrorCard[] }>('/cards'),
  program: () => call<ProgramResponse>('/program'),
  generateProgram: () => post<ProgramResponse>('/program/generate', {}),
  swapProgramDays: (a: string, b: string) => post<ProgramResponse>('/program/swap', { a, b }),
  lesson: () => call<LessonToday>('/lesson'),
  startLesson: () => post<{ ok: true; lesson: Lesson }>('/lesson/start', {}),
  answerLesson: (stepId: string, answer: string) => post<{ ok: true; lesson: Lesson; unlocked: Achievement[] }>('/lesson/answer', { stepId, answer }),
  bonusLesson: (accept: boolean) => post<{ ok: true; lesson: Lesson }>('/lesson/bonus', { accept }),
  rehearsal: () => call<RehearsalToday>('/rehearsal'),
  startRehearsal: () => post<{ ok: true; rehearsal: Rehearsal }>('/rehearsal/start', {}),
  answerRehearsal: (turnId: string, answer: string, speechId: string | null = null) => post<{ ok: true; rehearsal: Rehearsal; unlocked: Achievement[] }>('/rehearsal/answer', speechId ? { turnId, answer, speechId } : { turnId, answer }),
  reviewRehearsal: (force = false) => post<{ ok: true; rehearsal: Rehearsal }>('/rehearsal/review', { force }),
  abandonRehearsal: () => post<{ ok: true; abandoned: boolean }>('/rehearsal/abandon', {}),
  achievements: () => call<Achievements>('/achievements'),
  achievementsSeen: () => post<{ ok: true }>('/achievements/seen', {}),
  dashboard: () => call<Dashboard>('/dashboard'),
  /** Запись речи → расшифровка и мерки (Whisper на Workers AI). */
  transcribe: (audio: Blob, name = 'answer.wav') => {
    const fd = new FormData();
    fd.append('audio', audio, name);
    return call<{ ok: true; speech: Speech } & VoiceMeta>('/voice/transcribe', { method: 'POST', body: fd });
  },
  /** Озвучка реплики тренера → MP3 (MeloTTS). */
  speak: (text: string) => callBlob('/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
  saveGoal: (minutes: number | null) => put<Dashboard>('/dashboard/goal', { minutes }),
  digest: () => call<Digest>('/digest'),
  saveDigest: (notifyAt: string | null) => put<Digest>('/digest', { notifyAt }),
  sendDigest: () => post<{ ok: true; subject: string; sentOn: string; id: string | null }>('/digest/send', {}),
  push: () => call<Push>('/push'),
  savePush: (pushAt: string | null) => put<Push>('/push', { pushAt }),
  subscribePush: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null, pushAt?: string) =>
    post<Push>('/push/subscribe', { endpoint: sub.endpoint, keys: sub.keys, userAgent, ...(pushAt ? { pushAt } : {}) }),
  unsubscribePush: (endpoint: string) => del<Push & { removed: boolean }>('/push/subscribe', { endpoint }),
  sendPush: () => post<PushSendResult>('/push/send', {}),
  pushReminder: () => call<PushReminder>('/push/reminder'),
  settings: () => call<Settings>('/settings'),
  saveKey: (provider: string, apiKey: string, model: string) => put<Settings>('/settings/key', { provider, apiKey, model }),
  checkKey: () => post<Settings>('/settings/key/check', {}),
  deleteKey: () => del<Settings>('/settings/key', {}),
  saveNotifications: (at: string, mail: boolean, push: boolean) => put<Settings>('/settings/notifications', { at, mail, push }),
  /** Адрес файла экспорта — открывается ссылкой, cookie сессии уходит сам. */
  exportUrl: '/api/export',
};

/** Тексты ошибок API — одной строкой, прямо и без восклицаний. */
export const ERRORS: Record<string, string> = {
  offline: 'Нет сети. Ответ не отправлен — текст остаётся на экране, подключитесь и отправьте снова.',
  network: 'Сервер не ответил. Проверьте подключение и повторите.',
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
  assessment_busy: 'Сейчас идёт другой тест: завершите или прервите его, тогда можно начать этот.',
  answer_invalid: 'Ответ не принят: проверьте, что он заполнен.',
  bank_empty: 'В банке нет подходящего задания, и модель не смогла написать новое. Пополните банк и попробуйте снова.',
  program_invalid: 'Переставить не получилось: менять местами можно только два ещё не пройденных занятия, не раньше сегодняшнего дня.',
  lesson_no_day: 'На сегодня нет дня программы. Составьте программу в карточке «Программа».',
  lesson_unavailable: 'Сегодня по программе не занятие: репетиция интервью — в карточке «Репетиция интервью», контрольный срез — в карточке «Контрольный срез».',
  lesson_none: 'Активного занятия на сегодня нет. Вернитесь на главную и начните занятие.',
  lesson_stale: 'Этот шаг уже закрыт — экран обновлён, ответьте на текущий.',
  lesson_eval_failed: 'Модель не оценила письмо. Текст на месте — отправьте ещё раз через минуту.',
  bonus_none: 'Бонусная задача сегодня не предлагалась или уже закрыта.',
  rehearsal_none: 'Репетиции нет: ни начатой, ни завершённой. Нажмите «Начать репетицию».',
  rehearsal_stale: 'Этот вопрос уже закрыт — экран обновлён, ответьте на текущий.',
  rehearsal_finished: 'Репетиция уже завершена.',
  rehearsal_eval_failed: 'Экзаменатор не разобрал разговор. Ответы сохранены — нажмите «Разобрать снова» через минуту.',
  goal_invalid: 'Недельная цель — целое число минут от 15 до 1260.',
  notify_invalid: 'Время — часы и минуты, например 07:30.',
  push_invalid: 'Браузер отдал подписку в неожиданном виде. Обновите страницу и включите напоминания снова.',
  push_no_subscriptions: 'Ни одно устройство не подписано. Нажмите «Включить на этом устройстве».',
  push_failed: 'Push-служба не приняла напоминание ни на одном устройстве. Проверьте, что уведомления сайта разрешены, и повторите.',
  vapid_invalid: 'Ключи VAPID на сервере заданы неверно — напоминания не уйдут, пока их не поправят в секретах проекта.',
  audio_missing: 'Запись не ушла на сервер. Попробуйте ещё раз.',
  audio_unsupported: 'Сервер не принял формат записи. Попробуйте другой браузер.',
  audio_too_large: 'Запись длиннее предела. Говорите короче — до двух минут.',
  audio_empty: 'В записи не нашлось речи. Скажите ответ ближе к микрофону.',
  stt_failed: 'Модель распознавания не ответила. Повторите через минуту или ответьте текстом.',
  tts_failed: 'Озвучить не удалось: модель не ответила. Попробуйте позже.',
  tts_text_invalid: 'Нечего озвучивать.',
  key_invalid: 'Ключ не принят: проверьте провайдера, сам ключ и имя модели.',
  key_none: 'Своего ключа нет — работает встроенная модель.',
  key_unreadable: 'Сохранённый ключ не читается: мастер-ключ сервера сменился. Введите ключ заново.',
  key_check_failed: 'Провайдер не ответил на пробный запрос. Проверьте ключ и модель.',
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

/** Отказы при приёме ответа на вопрос репетиции — по причине. */
export const REHEARSAL_REFUSALS: Record<string, string> = {
  empty: 'Ответ пустой. Напишите, что сказали бы интервьюеру.',
  too_short: 'Ответ короче пятнадцати слов. На интервью так не отвечают — разверните мысль, цель 40–150 слов.',
  too_long: 'Ответ длиннее четырёхсот слов. Интервьюер столько не слушает — сократите до 40–150.',
  speech_unknown: 'Запись голоса не найдена на сервере. Отправьте ответ текстом или запишите снова.',
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

/** Разбор резюме не удался, но текст сохранён: профиль для карточки и строка причины, которую карточка покажет. */
export function failedAnalysis(e: unknown): { profile: Profile; notice: string } | null {
  if (e instanceof ApiError && e.code === 'profile_failed' && e.body?.profile) return { profile: e.body.profile as Profile, notice: errorText(e) };
  return null;
}

/** То же для репетиции: отказ по длине ответа объясняется её мерками. */
export const rehearsalErrorText = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'answer_invalid') return REHEARSAL_REFUSALS[String(e.body?.reason)] ?? ERRORS.answer_invalid;
  return errorText(e);
};
