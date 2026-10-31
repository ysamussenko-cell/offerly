/**
 * Признаки телефона (6.1): сенсорный экран без мыши и режим установленного приложения. Чистые функции с
 * передаваемым matchMedia, чтобы проверять в тестах; обёртки без аргументов читают window.
 */

export interface MediaLike { matchMedia?: (query: string) => { matches: boolean } }

/** Запрос, по которому прячется подсказка клавиш (styles.css): нет наведения, грубый указатель — палец. */
export const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';
export const STANDALONE_QUERY = '(display-mode: standalone)';

function matches(win: MediaLike | undefined, query: string): boolean {
  try { return !!win?.matchMedia?.(query).matches; } catch { return false; }
}

/** Телефон или планшет: основной указатель — палец. */
export function isCoarsePointer(win: MediaLike | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return matches(win, COARSE_POINTER_QUERY);
}

/** Приложение открыто со значка (PWA в своём окне, без адресной строки); в Safari на iOS — navigator.standalone. */
export function isStandalone(win: MediaLike & { navigator?: unknown } | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (matches(win, STANDALONE_QUERY)) return true;
  return (win?.navigator as { standalone?: unknown } | undefined)?.standalone === true;
}

/**
 * Ставить ли фокус в поле ответа сразу при открытии шага. С клавиатурой — да: можно сразу печатать. На телефоне — нет:
 * фокус поднимает экранную клавиатуру, она закрывает задание, которое ещё не прочитано; поле откроется по касанию.
 */
export function autoFocusFields(win: MediaLike | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return !isCoarsePointer(win);
}
