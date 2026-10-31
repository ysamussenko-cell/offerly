/** Горячие клавиши приложения — чистая логика без React и DOM, чтобы её можно было проверить тестами.
 *  Правила (пожелание Юрия 30.10):
 *  - Enter — отправить ответ, когда ответ выбирается кнопками (вариант 1–4) или фокус не в поле ввода;
 *    Ctrl+Enter (на Mac — Cmd+Enter) — отправить из любого места, в том числе из многострочного поля;
 *  - 1–4 — выбрать вариант ответа, пока фокус не в поле ввода;
 *  - Esc — отмена: прервать занятие или тест, закрыть анкету, вернуться назад; из многострочного поля первый Esc
 *    лишь снимает фокус, чтобы случайно не потерять написанное;
 *  - пробел с удержанием — запись голоса (нажали — запись пошла, отпустили — остановилась); включается с 4.2,
 *    пока ни один экран не объявляет recordable.
 *  После разбора шага Enter ведёт дальше (next), чтобы не тянуться к мыши между заданиями. */

export type HotkeyAction =
  | { type: 'submit' }
  | { type: 'choose'; index: number }
  | { type: 'cancel' }
  /** Esc в многострочном поле: сначала снять фокус (черновик цел), второй Esc — уже отмена. */
  | { type: 'blur' }
  | { type: 'next' }
  | { type: 'record-start' }
  | { type: 'record-stop' };

/** Что умеет текущий экран. Всё выключено по умолчанию — экран включает только нужное. */
export type HotkeyContext = {
  /** Сколько вариантов ответа на экране (0 — ответ не выбирается кнопками). */
  choices?: number;
  /** Ответ можно отправить (Enter / Ctrl+Enter). */
  submit?: boolean;
  /** На экране разбор шага, Enter ведёт дальше. */
  next?: boolean;
  /** Esc что-то отменяет или закрывает. */
  cancel?: boolean;
  /** Голосовой ответ доступен — пробел с удержанием пишет. */
  recordable?: boolean;
  /** Экран занят (запрос в полёте) — клавиши не действуют, кроме отмены, если она разрешена явно. */
  busy?: boolean;
};

/** Минимум сведений о событии клавиатуры — структурно совместим с KeyboardEvent. */
export type KeyLike = {
  type: 'keydown' | 'keyup' | string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  /** Тег элемента в фокусе (TEXTAREA, INPUT, …) — в hook берётся из event.target. */
  targetTag?: string;
  /** Поле с contenteditable тоже считается полем ввода. */
  targetEditable?: boolean;
};

export const MAX_CHOICES = 4;
const TYPING_TAGS = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

/** Фокус в поле ввода: цифры и Enter там принадлежат тексту, а не приложению. */
export function isTyping(e: KeyLike): boolean {
  return Boolean(e.targetEditable) || TYPING_TAGS.has((e.targetTag ?? '').toUpperCase());
}

/** Мак: Cmd вместо Ctrl. Определяется по платформе один раз при загрузке. */
export function isMacLike(platform?: string): boolean {
  const p = platform ?? (typeof navigator !== 'undefined' ? navigator.platform || (navigator as any).userAgentData?.platform || '' : '');
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Какое действие вызывает клавиша в данном контексте; null — клавиша не наша, браузер делает своё. */
export function interpretKey(e: KeyLike, ctx: HotkeyContext): HotkeyAction | null {
  const typing = isTyping(e);
  const mod = Boolean(e.ctrlKey || e.metaKey);

  if (e.type === 'keyup') {
    // Отпустили пробел — остановить запись. Проверка recordable здесь намеренно опущена:
    // запись могла начаться до того, как экран перестал быть recordable, и её нужно остановить.
    if (e.key === ' ' && !typing) return { type: 'record-stop' };
    return null;
  }
  if (e.type !== 'keydown') return null;

  if (e.key === 'Escape') {
    if (!ctx.cancel) return null;
    // В многострочном поле может быть черновик письма — первый Esc только снимает фокус, второй отменяет.
    if ((e.targetTag ?? '').toUpperCase() === 'TEXTAREA' || e.targetEditable) return { type: 'blur' };
    return { type: 'cancel' };
  }

  if (ctx.busy) return null;
  if (e.altKey) return null;

  if (e.key === 'Enter') {
    if (ctx.next) return (!typing || mod) ? { type: 'next' } : null;
    if (!ctx.submit) return null;
    if (mod) return { type: 'submit' };
    if (typing) return null; // обычный Enter в поле — перевод строки или отправка формы браузером
    return { type: 'submit' };
  }

  if (!typing && !mod && (ctx.choices ?? 0) > 0 && /^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    if (index < Math.min(ctx.choices!, MAX_CHOICES)) return { type: 'choose', index };
    return null;
  }

  // Автоповтор при удержании тоже возвращает record-start: экран игнорирует повтор, а событие глушится,
  // иначе удерживаемый пробел прокручивает страницу.
  if (e.key === ' ' && ctx.recordable && !typing && !mod) return { type: 'record-start' };

  return null;
}

export type KeyHint = { keys: string[]; label: string };

/** Подсказка клавиш для текущего экрана — что сейчас реально работает, ничего лишнего. */
export function hotkeyHints(ctx: HotkeyContext, opts: { mac?: boolean; textEntry?: boolean } = {}): KeyHint[] {
  const mod = opts.mac ? 'Cmd' : 'Ctrl';
  const out: KeyHint[] = [];
  const n = Math.min(ctx.choices ?? 0, MAX_CHOICES);
  if (ctx.next) {
    out.push({ keys: ['Enter'], label: 'дальше' });
  } else {
    if (n > 0) out.push({ keys: [n === 1 ? '1' : `1–${n}`], label: 'выбрать вариант' });
    if (ctx.submit) out.push(opts.textEntry ? { keys: [mod, 'Enter'], label: 'отправить' } : { keys: ['Enter'], label: 'отправить' });
    if (ctx.recordable) out.push({ keys: ['Пробел'], label: 'удерживать — запись голоса' });
  }
  if (ctx.cancel) out.push({ keys: ['Esc'], label: 'отмена' });
  return out;
}

/** Значение для aria-keyshortcuts у кнопки отправки. */
export function submitShortcut(textEntry: boolean): string {
  return textEntry ? 'Control+Enter Meta+Enter' : 'Enter Control+Enter Meta+Enter';
}
