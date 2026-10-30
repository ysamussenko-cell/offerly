/**
 * Тема оформления. Режимы: auto — тёмная вечером (с EVENING_FROM до MORNING_TO по местному времени)
 * или когда система в тёмной теме; light и dark — принудительно. Выбор хранится в localStorage.
 * Та же логика продублирована коротким скриптом в index.html, чтобы страница не мигала светлым при загрузке.
 */
export type ThemeMode = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'offerly.theme';
export const THEME_MODES: ThemeMode[] = ['auto', 'light', 'dark'];
export const THEME_LABELS: Record<ThemeMode, string> = { auto: 'Авто', light: 'Светлая', dark: 'Тёмная' };
/** Вечер по концепту: с 20:00 до 7:00 тёмная тема включается сама. */
export const EVENING_FROM = 20;
export const MORNING_TO = 7;
/** Цвет строки браузера (meta theme-color): графит днём, фон тёмной темы вечером. */
export const THEME_COLORS: Record<Theme, string> = { light: '#141C2B', dark: '#0F1520' };

export const isThemeMode = (v: unknown): v is ThemeMode => typeof v === 'string' && (THEME_MODES as string[]).includes(v);

export function isEvening(hour: number): boolean {
  return hour >= EVENING_FROM || hour < MORNING_TO;
}

/** Какую тему показать при данном режиме, системной настройке и часе. */
export function resolveTheme(mode: ThemeMode, env: { prefersDark: boolean; hour: number }): Theme {
  if (mode !== 'auto') return mode;
  return env.prefersDark || isEvening(env.hour) ? 'dark' : 'light';
}

/** Подпись под переключателем: что именно выбрано в режиме «Авто». */
export function autoHint(theme: Theme, env: { prefersDark: boolean; hour: number }): string {
  if (theme === 'light') return 'Сейчас светлая: днём и при светлой теме системы.';
  if (env.prefersDark) return 'Сейчас тёмная: система в тёмной теме.';
  return `Сейчас тёмная: вечером, с ${EVENING_FROM}:00 до ${MORNING_TO}:00.`;
}

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** Режим из хранилища; всё незнакомое — auto. */
export function readMode(storage: StorageLike | undefined): ThemeMode {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemeMode(v) ? v : 'auto';
  } catch { return 'auto'; }
}

export function writeMode(storage: StorageLike | undefined, mode: ThemeMode): void {
  try {
    if (mode === 'auto') storage?.removeItem(THEME_KEY); else storage?.setItem(THEME_KEY, mode);
  } catch { /* приватный режим без хранилища — тема останется на сессию */ }
}

/** Применить тему к документу: атрибут data-theme на <html> и цвет строки браузера. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.setAttribute('data-theme', theme);
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
}

export function currentEnv(): { prefersDark: boolean; hour: number } {
  const prefersDark = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return { prefersDark, hour: new Date().getHours() };
}
