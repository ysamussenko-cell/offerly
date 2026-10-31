import { useEffect, useRef } from 'react';
import { hotkeyHints, interpretKey, isMacLike, type HotkeyAction, type HotkeyContext } from './hotkeys';

export type HotkeyHandlers = {
  onSubmit?: () => void;
  onChoose?: (index: number) => void;
  onCancel?: () => void;
  onNext?: () => void;
  onRecordStart?: () => void;
  onRecordStop?: () => void;
};

const MAC = isMacLike();

/** Слушает клавиатуру на окне (фокус часто на body, onKeyDown на секции его не ловит) и вызывает обработчики
 *  по правилам из hotkeys.ts. Контекст и обработчики читаются через ref — слушатель ставится один раз. */
export function useHotkeys(ctx: HotkeyContext, handlers: HotkeyHandlers): void {
  const latest = useRef({ ctx, handlers });
  latest.current = { ctx, handlers };
  useEffect(() => {
    const run = (e: globalThis.KeyboardEvent) => {
      const { ctx, handlers } = latest.current;
      const t = e.target as HTMLElement | null;
      const action: HotkeyAction | null = interpretKey({
        type: e.type, key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat,
        targetTag: t?.tagName, targetEditable: Boolean(t?.isContentEditable),
      }, ctx);
      if (!action) return;
      const h = ({
        'submit': handlers.onSubmit,
        'choose': handlers.onChoose && (() => handlers.onChoose!((action as { index: number }).index)),
        'cancel': handlers.onCancel,
        'blur': handlers.onCancel && (() => (document.activeElement as HTMLElement | null)?.blur()),
        'next': handlers.onNext,
        'record-start': handlers.onRecordStart,
        'record-stop': handlers.onRecordStop,
      } as Record<HotkeyAction['type'], (() => void) | undefined>)[action.type];
      if (!h) return;
      e.preventDefault();
      h();
    };
    window.addEventListener('keydown', run);
    window.addEventListener('keyup', run);
    return () => { window.removeEventListener('keydown', run); window.removeEventListener('keyup', run); };
  }, []);
}

/** Строка подсказки клавиш под кнопками: только то, что работает на этом экране сейчас.
 *  На устройствах без мыши (телефон) скрывается стилями — там клавиатуры обычно нет. */
export function KeyHints({ ctx, textEntry }: { ctx: HotkeyContext; textEntry?: boolean }) {
  const hints = hotkeyHints(ctx, { mac: MAC, textEntry });
  if (hints.length === 0) return null;
  return (
    <p className="keys" aria-label="Горячие клавиши">
      {hints.map(h => (
        <span key={h.label} className="key-hint">
          {h.keys.map((k, i) => <span key={k}>{i > 0 && <span className="key-plus">+</span>}<kbd>{k}</kbd></span>)}
          <span className="key-label">{h.label}</span>
        </span>
      ))}
    </p>
  );
}
