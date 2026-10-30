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

export const errorText = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'onboarding_invalid') {
    return ANSWER_ERRORS[`${e.body?.field}:${e.body?.reason}`] ?? ERRORS.onboarding_invalid;
  }
  const base = (e instanceof ApiError && ERRORS[e.code]) || ERRORS.request_failed;
  const detail = e instanceof ApiError && typeof e.body?.detail === 'string' ? e.body.detail : '';
  return detail ? `${base} Ответ сервера: ${detail}` : base;
};
