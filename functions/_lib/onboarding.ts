/** Анкета знакомства — шесть вопросов: целевая позиция, дата собеседования, формат, минуты в день,
 *  часовой пояс, родной язык. Ответы проверяются здесь, в базу попадает только допустимое. */

export const INTERVIEW_FORMATS = ['written', 'video', 'ai', 'unknown'] as const;
export type InterviewFormat = typeof INTERVIEW_FORMATS[number];

/** Подписи форматов — для писем и серверных текстов; интерфейс держит свои. */
export const FORMAT_LABELS: Record<InterviewFormat, string> = {
  written: 'письменный тест', video: 'видеозвонок', ai: 'ИИ-интервью', unknown: 'пока не известно',
};

export const MINUTES_MIN = 5;
export const MINUTES_MAX = 180;
export const MINUTES_OPTIONS = [10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_MINUTES = 20;
export const DEFAULT_TZ = 'Asia/Almaty';
export const DEFAULT_LANGUAGE = 'русский';
/** Самая далёкая допустимая дата собеседования — два года вперёд. */
export const MAX_DAYS_AHEAD = 730;

export interface Answers {
  targetRole: string;
  interviewDate: string | null;   // YYYY-MM-DD
  interviewFormat: InterviewFormat;
  minutesPerDay: number;
  tz: string;
  nativeLanguage: string;
}

export type AnswerField = keyof Answers;

export type ValidationResult =
  | { ok: true; answers: Answers }
  | { ok: false; field: AnswerField; reason: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Дата YYYY-MM-DD, существующая в календаре. */
export function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Сегодняшняя дата YYYY-MM-DD в часовом поясе пользователя. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch { return now.toISOString().slice(0, 10); }
}

/** Разница в днях между двумя датами YYYY-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Часовой пояс считается допустимым, если его понимает Intl этой среды. */
export function isTimeZone(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw }); return true; } catch { return false; }
}

const text = (v: unknown, max: number): string => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Проверяет сырые ответы формы. Дата — не раньше сегодняшнего дня в часовом поясе пользователя. */
export function validateAnswers(raw: unknown, now = new Date()): ValidationResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const targetRole = text(o.targetRole, 120);
  if (targetRole.length < 2) return { ok: false, field: 'targetRole', reason: 'empty' };

  const tz = typeof o.tz === 'string' && o.tz.trim() ? o.tz.trim() : DEFAULT_TZ;
  if (!isTimeZone(tz)) return { ok: false, field: 'tz', reason: 'unknown' };

  let interviewDate: string | null = null;
  if (o.interviewDate != null && o.interviewDate !== '') {
    interviewDate = parseDate(o.interviewDate);
    if (!interviewDate) return { ok: false, field: 'interviewDate', reason: 'format' };
    const diff = daysBetween(todayIn(tz, now), interviewDate);
    if (diff < 0) return { ok: false, field: 'interviewDate', reason: 'past' };
    if (diff > MAX_DAYS_AHEAD) return { ok: false, field: 'interviewDate', reason: 'far' };
  }

  const fmt = typeof o.interviewFormat === 'string' ? o.interviewFormat : 'unknown';
  if (!(INTERVIEW_FORMATS as readonly string[]).includes(fmt)) return { ok: false, field: 'interviewFormat', reason: 'unknown' };

  const minutesNum = typeof o.minutesPerDay === 'number' ? o.minutesPerDay : typeof o.minutesPerDay === 'string' ? parseInt(o.minutesPerDay, 10) : NaN;
  if (!Number.isInteger(minutesNum) || minutesNum < MINUTES_MIN || minutesNum > MINUTES_MAX) return { ok: false, field: 'minutesPerDay', reason: 'range' };

  const nativeLanguage = text(o.nativeLanguage, 40).toLowerCase();
  if (nativeLanguage.length < 2) return { ok: false, field: 'nativeLanguage', reason: 'empty' };

  return { ok: true, answers: { targetRole, interviewDate, interviewFormat: fmt as InterviewFormat, minutesPerDay: minutesNum, tz, nativeLanguage } };
}

export interface OnboardingStore {
  /** Сохраняет ответы: анкетные поля в profiles, часовой пояс в users. Разбор резюме не трогает. */
  saveAnswers(userId: string, a: Answers, nowIso: string): Promise<void>;
}

export function d1OnboardingStore(db: D1Database): OnboardingStore {
  return {
    async saveAnswers(userId, a, nowIso) {
      await db.batch([
        db.prepare(
          `INSERT INTO profiles (user_id, target_role, interview_date, interview_format, minutes_per_day, native_language, onboarded_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET target_role = excluded.target_role, interview_date = excluded.interview_date,
           interview_format = excluded.interview_format, minutes_per_day = excluded.minutes_per_day,
           native_language = excluded.native_language, onboarded_at = excluded.onboarded_at, updated_at = excluded.updated_at`,
        ).bind(userId, a.targetRole, a.interviewDate, a.interviewFormat, a.minutesPerDay, a.nativeLanguage, nowIso, nowIso),
        db.prepare('UPDATE users SET tz = ? WHERE id = ?').bind(a.tz, userId),
      ]);
    },
  };
}
