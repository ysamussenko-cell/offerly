/** Календарь сервера в одном месте: сегодняшняя дата в поясе ученика, арифметика дат YYYY-MM-DD
 *  и русские даты для текстов (в учётке, письмах и причинах программы — «29 октября 2026», не ISO).
 *  Модуль ничего не импортирует, поэтому его можно звать из fsrs, cards, program и digest без циклов. */

const DAY_MS = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Сегодняшняя дата YYYY-MM-DD в часовом поясе пользователя; неизвестный пояс — дата UTC. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch { return now.toISOString().slice(0, 10); }
}

/** Разница в днях между двумя датами YYYY-MM-DD (b − a), со знаком. */
export const daysBetween = (a: string, b: string): number => Math.round((at(b) - at(a)) / DAY_MS);

/** Дата YYYY-MM-DD через n дней (n может быть отрицательным). */
export const addDays = (iso: string, n: number): string => new Date(at(iso) + n * DAY_MS).toISOString().slice(0, 10);

/** 0 — воскресенье … 6 — суббота; дата уже в поясе пользователя, поэтому считается как календарная. */
export const weekdayOf = (iso: string): number => new Date(at(iso)).getUTCDay();

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «31 октября 2026» (или «31 октября») из YYYY-MM-DD; полная ISO-метка берётся по дате UTC. */
export function longDateRu(iso: string, withYear = true): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS_RU[m - 1]}${withYear ? ` ${y}` : ''}`;
}
