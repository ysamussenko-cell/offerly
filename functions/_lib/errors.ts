/**
 * Общая ошибка предметной области. Каждая область (тест, занятие, репетиция, голос, настройки…) наследует её
 * и задаёт код и HTTP-статус; `app.onError` в app.ts превращает любую DomainError в один и тот же JSON-ответ:
 * `{ ok: false, error: code, reason?, detail? }` — detail есть только когда сообщение не совпадает с кодом.
 */
export class DomainError extends Error {
  constructor(public code: string, public status: number, message?: string, public reason?: string) {
    super(message ?? code);
    this.name = new.target.name;
  }

  /** Тело ответа API для этой ошибки; undefined-поля JSON не попадают в вывод. */
  toJSON(): { ok: false; error: string; reason?: string; detail?: string } {
    return { ok: false, error: this.code, reason: this.reason, detail: this.message !== this.code ? this.message : undefined };
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
