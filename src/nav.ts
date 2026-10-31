/**
 * Экраны и история браузера (6.1, телефон). Приложение не меняет путь: занятие, репетиция, тест, срез и настройки —
 * состояние React. На телефоне у этого есть цена: кнопка «назад» (жест Android, стрелка в iOS) закрывает установленное
 * приложение целиком, а не возвращает на главный. Поэтому у каждого открытого экрана — своя запись в истории
 * (`history.pushState`), «назад» снимает её, и приложение закрывает экран; закрытие кнопкой на экране снимает ту же запись.
 * Те же имена экранов — в ссылках быстрого доступа манифеста (долгое нажатие на значок) и в уведомлениях: `/?screen=lesson`.
 * Логика без DOM: история и слушатели передаются снаружи, чтобы проверять её в тестах.
 */

export type ScreenName = 'lesson' | 'rehearsal' | 'test' | 'checkpoint' | 'settings';

export const SCREEN_NAMES: readonly ScreenName[] = ['lesson', 'rehearsal', 'test', 'checkpoint', 'settings'];

/** Параметр адреса, который открывает экран сразу после входа: /?screen=lesson. */
export const SCREEN_PARAM = 'screen';

/** Запись истории, которую ставит приложение; чужие записи (другие сайты, стартовая страница) — без этого поля. */
export interface NavState { offerly: ScreenName }

export function isNavState(s: unknown, screen?: ScreenName): s is NavState {
  if (!s || typeof s !== 'object') return false;
  const v = (s as { offerly?: unknown }).offerly;
  if (typeof v !== 'string' || !(SCREEN_NAMES as readonly string[]).includes(v)) return false;
  return screen == null || v === screen;
}

/** Экран из строки запроса адреса (`?screen=lesson`); неизвестное или пустое значение — null. */
export function parseScreen(search: string): ScreenName | null {
  let v: string | null = null;
  try { v = new URLSearchParams(search).get(SCREEN_PARAM); } catch { return null; }
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return (SCREEN_NAMES as readonly string[]).includes(s) ? (s as ScreenName) : null;
}

/** Адрес экрана для истории, ссылок быстрого доступа и уведомлений: главный — «/», экран — «/?screen=имя». */
export function hrefFor(screen: ScreenName | null, base = '/'): string {
  return screen ? `${base}?${SCREEN_PARAM}=${screen}` : base;
}

/** То, что нужно от window.history; в тестах — подделка. */
export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url?: string | null): void;
  replaceState(state: unknown, unused: string, url?: string | null): void;
  back(): void;
}

export interface ScreenHistory {
  /** Экран открыт: добавить запись в историю (если верхняя запись — уже этот экран, ничего не делать).
   *  `fresh` — приложение открыто по ссылке с экраном: верхняя запись заменяется главным, чтобы «назад» вёл на главный, а не прочь. */
  open(screen: ScreenName, opts?: { fresh?: boolean }): void;
  /** Экран закрывают кнопкой: если верхняя запись — его, снять её через history.back() (onClose придёт из popstate); иначе закрыть сразу. */
  close(): void;
  /** Запись истории сменилась (popstate). `open` — какой экран открыт сейчас. Если новая запись — не он, открытый экран
   *  закрывается (onClose). Возвращает экран новой записи: «вперёд» после «назад» — приложение может открыть его снова. */
  onPop(state: unknown, open: ScreenName | null): ScreenName | null;
  /** Выход из учётной записи или сброс: верхняя запись экрана заменяется главным без popstate. */
  leave(): void;
}

/**
 * Связь открытых экранов с историей. `onClose` вызывается ровно один раз на закрытие — либо из `close()` напрямую,
 * либо из `onPop()`, когда запись снята кнопкой «назад» или нашим `history.back()`.
 */
export function createScreenHistory(history: HistoryLike, onClose: () => void): ScreenHistory {
  let pendingBack = false;
  return {
    open(screen, opts) {
      if (opts?.fresh) history.replaceState(null, '', hrefFor(null));
      if (!opts?.fresh && isNavState(history.state, screen)) return;
      history.pushState({ offerly: screen } satisfies NavState, '', hrefFor(screen));
    },
    close() {
      if (isNavState(history.state) && !pendingBack) {
        pendingBack = true;
        try { history.back(); }
        catch { pendingBack = false; onClose(); }
        return;
      }
      if (!pendingBack) onClose();
    },
    onPop(state, open) {
      pendingBack = false;
      const next = isNavState(state) ? state.offerly : null;
      if (open != null && next !== open) onClose();
      return next;
    },
    leave() {
      pendingBack = false;
      if (isNavState(history.state)) history.replaceState(null, '', hrefFor(null));
    },
  };
}
