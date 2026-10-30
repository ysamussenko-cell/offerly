/** Русские склонения и тексты, которые нужны нескольким экранам. */

/** Форма слова по числу: plural(3, 'день', 'дня', 'дней') → «дня». */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n), mod10 = abs % 10, mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export const yearsText = (n: number) => `${n} ${plural(n, 'год', 'года', 'лет')}`;
export const daysText = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
export const minutesText = (n: number) => `${n} ${plural(n, 'минута', 'минуты', 'минут')}`;

export const FORMAT_LABELS: Record<string, string> = {
  written: 'Письменный тест', video: 'Видеозвонок', ai: 'ИИ-интервью', unknown: 'Пока не знаю',
};

/** Сегодняшняя дата YYYY-MM-DD в указанном поясе (как считает сервер). */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch { return now.toISOString().slice(0, 10); }
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** «через 24 дня», «сегодня», «завтра», «дата прошла». */
export function countdownText(interviewDate: string, tz: string, now = new Date()): string {
  const d = daysBetween(todayIn(tz, now), interviewDate);
  if (d < 0) return 'дата прошла';
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  return `через ${daysText(d)}`;
}

/** Дата YYYY-MM-DD → «23 ноября 2026». */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Часовые пояса для списка: все известные браузеру, а если он их не отдаёт — короткий набор. */
export const FALLBACK_TIME_ZONES = [
  'Asia/Almaty', 'Asia/Astana', 'Asia/Tashkent', 'Asia/Bishkek', 'Asia/Dubai', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku',
  'Europe/Moscow', 'Europe/Minsk', 'Europe/Kyiv', 'Europe/Istanbul', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'Europe/Lisbon',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export function timeZoneList(current?: string | null): string[] {
  let list: string[] = FALLBACK_TIME_ZONES;
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try { if (intl.supportedValuesOf) list = intl.supportedValuesOf('timeZone'); } catch { /* старый браузер — короткий список */ }
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

/** Смещение пояса для подписи: «Asia/Almaty (UTC+5)». */
export function tzLabel(tz: string, now = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? '';
    return part ? `${tz} (${part.replace('GMT', 'UTC')})` : tz;
  } catch { return tz; }
}

export const LANGUAGES = ['русский', 'казахский', 'украинский', 'узбекский', 'белорусский', 'киргизский', 'азербайджанский', 'армянский', 'грузинский', 'татарский', 'турецкий'];
