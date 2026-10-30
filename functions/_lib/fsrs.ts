/** Расписание повторов карточек ошибок по FSRS (Free Spaced Repetition Scheduler, формулы версии 4.5
 *  с параметрами по умолчанию). Карточка хранит стабильность S (дни, за которые вероятность вспомнить
 *  падает до 90 %), сложность D (1–10), счётчики reps/lapses, дату последнего повтора и серию верных подряд.
 *  Оценок у нас две: верно (Good) и неверно (Again) — ученик либо исправил предложение как надо, либо нет.
 *  Интервал до следующего повтора — такой, чтобы к сроку вероятность вспомнить равнялась DESIRED_RETENTION.
 *  Карточка гаснет после RETIRE_AFTER верных подряд; неверный ответ обнуляет серию и возвращает карточку завтра. */
// Без импорта program.ts: cards → fsrs → program → cards замкнуло бы круг на уровне модулей.
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Параметры FSRS-4.5 по умолчанию (w0…w16). */
export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755] as const;
export const DESIRED_RETENTION = 0.9;
/** Интервал не короче дня и не длиннее полугода: программа рассчитана на недели, не годы. */
export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 180;
/** Сколько верных подряд гасят карточку. */
export const RETIRE_AFTER = 3;

const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9^(1/DECAY) − 1: при t = S вероятность вспомнить ровно 0,9

export type Grade = 'again' | 'good';
const RATING: Record<Grade, number> = { again: 1, good: 3 };

export interface FsrsState {
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** Верных подряд. */
  streak: number;
  /** Дата последнего повтора (YYYY-MM-DD); null — карточка ещё не повторялась. */
  reviewedAt: string | null;
}

export interface FsrsNext extends FsrsState {
  due: string | null;
  retired: boolean;
  /** Интервал в днях до следующего повтора (0 — погашена). */
  interval: number;
  reviewedAt: string;
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const clampS = (s: number) => Math.max(0.1, s);

/** Вероятность вспомнить через t дней при стабильности S. */
export const retrievability = (stability: number, elapsedDays: number) => Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / clampS(stability), DECAY);

/** Интервал в днях, через который вероятность вспомнить упадёт до retention; в границах MIN..MAX. */
export function intervalFor(stability: number, retention = DESIRED_RETENTION): number {
  const days = clampS(stability) / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(days)));
}

/** Начальная стабильность по первой оценке. */
export const initialStability = (g: Grade) => clampS(W[RATING[g] - 1]);
/** Начальная сложность по первой оценке: D0 = w4 − (G − 3)·w5. */
export const initialDifficulty = (g: Grade) => clampD(W[4] - (RATING[g] - 3) * W[5]);

/** Сложность после ответа: сдвиг на w6·(G − 3) и подтягивание к среднему (w7). */
export function nextDifficulty(d: number, g: Grade): number {
  const shifted = d - W[6] * (RATING[g] - 3);
  return clampD(W[7] * initialDifficulty('good') + (1 - W[7]) * shifted);
}

/** Стабильность после верного ответа. */
export function recallStability(s: number, d: number, r: number): number {
  return clampS(s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) + 1));
}

/** Стабильность после неверного ответа (не выше прежней). */
export function forgetStability(s: number, d: number, r: number): number {
  return clampS(Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r))));
}

/** Дней между датами YYYY-MM-DD (b − a), не меньше нуля. */
export const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));

/** Карточка ещё не повторялась — первая оценка задаёт S и D. */
export const isNew = (c: Pick<FsrsState, 'reviewedAt' | 'reps' | 'lapses'>) => c.reviewedAt == null && c.reps === 0 && c.lapses === 0;

/** Состояние карточки после ответа сегодня. Верно — серия растёт, интервал по FSRS; RETIRE_AFTER верных подряд гасят
 *  карточку (due null). Неверно — серия обнуляется, lapses растёт, карточка возвращается через MIN_INTERVAL. */
export function review(c: FsrsState, g: Grade, today: string): FsrsNext {
  let stability: number, difficulty: number;
  if (isNew(c)) {
    stability = initialStability(g); difficulty = initialDifficulty(g);
  } else {
    // Без даты повтора (карточки до 3.3) считаем, что повтор пришёл в срок: вероятность вспомнить ≈ DESIRED_RETENTION.
    const elapsed = c.reviewedAt ? daysBetween(c.reviewedAt, today) : intervalFor(c.stability);
    const r = retrievability(c.stability, elapsed);
    difficulty = nextDifficulty(c.difficulty, g);
    stability = g === 'good' ? recallStability(c.stability, c.difficulty, r) : forgetStability(c.stability, c.difficulty, r);
  }
  const good = g === 'good';
  const streak = good ? c.streak + 1 : 0;
  const retired = good && streak >= RETIRE_AFTER;
  const interval = retired ? 0 : good ? intervalFor(stability) : MIN_INTERVAL;
  return {
    stability: Math.round(stability * 1000) / 1000, difficulty: Math.round(difficulty * 1000) / 1000,
    reps: good ? c.reps + 1 : c.reps, lapses: good ? c.lapses : c.lapses + 1,
    streak, reviewedAt: today, due: retired ? null : addDays(today, interval), retired, interval,
  };
}
