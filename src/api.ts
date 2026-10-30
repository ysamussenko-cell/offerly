export type User = { id: string; email: string; name: string | null; locale: string; tz: string };
export type Health = { ok: boolean; version: string; db: 'ok' | 'missing' | 'error'; ai: 'ok' | 'missing' | 'error'; mail?: 'ok' | 'missing' };

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'request_failed');
  return j as T;
}

const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => call<Health>('/health'),
  me: () => call<{ ok: true; user: User }>('/me'),
  requestCode: (email: string) => post<{ ok: true; delivery: 'email' | 'echo'; code?: string; expiresAt: string }>('/auth/request', { email }),
  verifyCode: (email: string, code: string) => post<{ ok: true; user: User; isNew: boolean }>('/auth/verify', { email, code }),
  logout: () => post<{ ok: true }>('/auth/logout', {}),
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
  request_failed: 'Сервер не ответил. Проверьте связь и попробуйте снова.',
};

export const errorText = (e: unknown) => (e instanceof ApiError && ERRORS[e.code]) || ERRORS.request_failed;
