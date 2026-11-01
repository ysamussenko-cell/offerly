/**
 * Страница установки (5.1): чистая логика без DOM — какой это компьютер или телефон, какие шаги установки показать,
 * что сказать про установщик для Windows. Экран — src/screens/Install.tsx.
 */
import type { Release } from './api';
import { longDateAt } from './text';

/** Адрес страницы установки; остальные пути — приложение. */
export const INSTALL_PATH = '/install';

export type Screen = 'app' | 'install';

/** Какой экран открыть по пути: /install и /install/ — страница установки, всё остальное — приложение. */
export function screenFor(pathname: string): Screen {
  const p = pathname.replace(/\/+$/, '').toLowerCase();
  return p === INSTALL_PATH ? 'install' : 'app';
}

export type Platform = 'windows' | 'mac' | 'ios' | 'android' | 'linux' | 'other';

export const PLATFORM_LABEL: Record<Platform, string> = {
  windows: 'Windows', mac: 'Mac', ios: 'iPhone и iPad', android: 'Android', linux: 'Linux', other: 'это устройство',
};

/** Платформа по строке браузера. iPad в Safari притворяется Mac — его выдаёт сенсорный экран (maxTouchPoints). */
export function platformOf(ua: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return maxTouchPoints > 1 ? 'ios' : 'mac';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'other';
}

export type Browser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'samsung' | 'other';

/** Браузер по строке: порядок важен — Edge и Samsung содержат «Chrome», Chrome содержит «Safari». */
export function browserOf(ua: string): Browser {
  if (/Edg\//.test(ua)) return 'edge';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Firefox|FxiOS/.test(ua)) return 'firefox';
  if (/Chrome|CriOS/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
}

/** Умеет ли браузер ставить веб-приложение сам (событие beforeinstallprompt или пункт меню). */
export const canPromptInstall = (platform: Platform, browser: Browser): boolean =>
  platform !== 'ios' && (browser === 'chrome' || browser === 'edge' || browser === 'samsung');

/** Шаги установки как приложения — по платформе и браузеру, два-три шага. button — на странице есть кнопка «Установить приложение» (браузер предложил установку сам). */
export function installSteps(platform: Platform, browser: Browser, button = false): string[] {
  if (platform === 'ios') {
    return browser === 'safari' || browser === 'other'
      ? ['Откройте offerly-c8b.pages.dev в Safari.', 'Нажмите «Поделиться» (квадрат со стрелкой внизу экрана).', 'Выберите «На экран „Домой“» и подтвердите.']
      : ['На iPhone и iPad веб-приложения ставит только Safari: откройте этот адрес в Safari.', 'Нажмите «Поделиться» → «На экран „Домой“».'];
  }
  if (platform === 'android') {
    if (browser === 'firefox') return ['Firefox на Android: меню (три точки) → «Установить» или «Добавить на главный экран».'];
    if (button) return ['Нажмите «Установить приложение» выше — браузер спросит подтверждение.', 'Значок Offerly появится на главном экране.'];
    return ['Откройте offerly-c8b.pages.dev в Chrome.', 'Меню (три точки) → «Установить приложение» или «Добавить на главный экран».', 'Подтвердите — значок появится на главном экране.'];
  }
  if (browser === 'firefox') return ['Firefox не ставит веб-приложения сам: откройте этот адрес в Chrome или Edge.', 'В Chrome или Edge нажмите значок установки справа в адресной строке.'];
  if (platform === 'mac' && browser === 'safari') return ['В Safari: меню «Файл» → «Добавить в Dock».', 'Offerly откроется отдельным окном; значок появится в Dock.'];
  if (button) return ['Нажмите «Установить приложение» выше — браузер спросит подтверждение.', 'Offerly откроется в своём окне; значок появится на рабочем столе и в меню «Пуск».'];
  return ['Нажмите значок установки справа в адресной строке или откройте меню (три точки) → «Установить Offerly».', 'Подтвердите — Offerly откроется в своём окне, значок появится на рабочем столе и в меню «Пуск».'];
}

/** Что даёт установка — одной строкой для подзаголовка карточки. */
export const INSTALL_BENEFITS = 'Своё окно без вкладок, значок на рабочем столе или экране «Домой», открывается без сети и показывает напоминания.';

/** Строка версии релиза: «Версия 0.22.0 · 1 ноября 2026», без даты — «Версия 0.22.0». */
export function releaseLine(r: Extract<Release, { available: true }>): string {
  const date = r.publishedAt ? longDateAt(r.publishedAt) : null;
  return date ? `Версия ${r.version} · ${date}` : `Версия ${r.version}`;
}

/** Текст карточки Windows, когда установщика нет или его не удалось проверить. */
export function windowsUnavailableText(r: Extract<Release, { available: false }>): string {
  switch (r.reason) {
    case 'none': return 'Установщик для Windows готовится. Пока установите Offerly как приложение из браузера — это тот же Offerly в своём окне, с напоминаниями и работой без сети.';
    case 'no_windows': return `Последний релиз без сборки для Windows${r.detail ? ` (${r.detail})` : ''}. Установите как приложение из браузера — ссылка появится здесь, как только сборка выйдет.`;
    default: return `Не удалось проверить, есть ли установщик${r.detail ? `: ${r.detail}` : ''}. Попробуйте позже или откройте список релизов.`;
  }
}

/** Текст ошибки сети при запросе релиза — страница открыта без сети или сервер не ответил. */
export const RELEASE_OFFLINE_TEXT = 'Проверить наличие установщика не удалось — нет связи с сервером. Установка из браузера работает и так.';

/** Предупреждение SmartScreen для неподписанного установщика. */
export const SMARTSCREEN_NOTE = 'Установщик не подписан сертификатом издателя: Windows может показать окно SmartScreen — «Подробнее» → «Выполнить в любом случае». Файл собирается в GitHub Actions из этого репозитория.';
