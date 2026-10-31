import { describe, it, expect } from 'vitest';
import { hotkeyHints, interpretKey, isMacLike, isTyping, submitShortcut, type HotkeyContext, type KeyLike } from '../src/hotkeys';

const down = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ type: 'keydown', key, ...extra });
const up = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ type: 'keyup', key, ...extra });
const inText = { targetTag: 'TEXTAREA' };
const inInput = { targetTag: 'INPUT' };

const mcq: HotkeyContext = { choices: 4, submit: true, cancel: true };
const writing: HotkeyContext = { choices: 0, submit: true, cancel: true };
const review: HotkeyContext = { next: true, cancel: true };

describe('горячие клавиши: разбор событий', () => {
  it('1–4 выбирают вариант, когда фокус не в поле ввода', () => {
    expect(interpretKey(down('1'), mcq)).toEqual({ type: 'choose', index: 0 });
    expect(interpretKey(down('4'), mcq)).toEqual({ type: 'choose', index: 3 });
    expect(interpretKey(down('5'), mcq)).toBeNull();
    expect(interpretKey(down('3'), { ...mcq, choices: 2 })).toBeNull();
    expect(interpretKey(down('2'), writing)).toBeNull();
  });

  it('цифры в поле ввода — это текст, а не выбор', () => {
    expect(interpretKey(down('1', inText), mcq)).toBeNull();
    expect(interpretKey(down('1', inInput), mcq)).toBeNull();
    expect(interpretKey(down('1', { targetEditable: true }), mcq)).toBeNull();
    expect(interpretKey(down('1', { ctrlKey: true }), mcq)).toBeNull();
  });

  it('Enter отправляет выбор, Ctrl/Cmd+Enter отправляет из любого места', () => {
    expect(interpretKey(down('Enter'), mcq)).toEqual({ type: 'submit' });
    expect(interpretKey(down('Enter', inText), writing)).toBeNull();
    expect(interpretKey(down('Enter', { ...inText, ctrlKey: true }), writing)).toEqual({ type: 'submit' });
    expect(interpretKey(down('Enter', { ...inText, metaKey: true }), writing)).toEqual({ type: 'submit' });
    expect(interpretKey(down('Enter'), writing)).toEqual({ type: 'submit' });
    expect(interpretKey(down('Enter'), { ...mcq, submit: false })).toBeNull();
    expect(interpretKey(down('Enter', { altKey: true }), mcq)).toBeNull();
  });

  it('после разбора Enter ведёт дальше, из поля — только с Ctrl', () => {
    expect(interpretKey(down('Enter'), review)).toEqual({ type: 'next' });
    expect(interpretKey(down('Enter', inText), review)).toBeNull();
    expect(interpretKey(down('Enter', { ...inText, ctrlKey: true }), review)).toEqual({ type: 'next' });
    expect(interpretKey(down('1'), review)).toBeNull();
  });

  it('Esc — отмена; из многострочного поля первый Esc лишь снимает фокус', () => {
    expect(interpretKey(down('Escape'), mcq)).toEqual({ type: 'cancel' });
    expect(interpretKey(down('Escape', inInput), mcq)).toEqual({ type: 'cancel' });
    expect(interpretKey(down('Escape', inText), writing)).toEqual({ type: 'blur' });
    expect(interpretKey(down('Escape', { targetEditable: true }), writing)).toEqual({ type: 'blur' });
    expect(interpretKey(down('Escape'), { ...mcq, cancel: false })).toBeNull();
  });

  it('занятый экран не реагирует ни на что, кроме разрешённой отмены', () => {
    const busy = { ...mcq, busy: true };
    expect(interpretKey(down('1'), busy)).toBeNull();
    expect(interpretKey(down('Enter'), busy)).toBeNull();
    expect(interpretKey(down('Escape'), busy)).toEqual({ type: 'cancel' });
    expect(interpretKey(down('Escape'), { ...busy, cancel: false })).toBeNull();
  });

  it('пробел с удержанием пишет голос только там, где запись доступна', () => {
    const voice: HotkeyContext = { submit: true, recordable: true };
    expect(interpretKey(down(' '), voice)).toEqual({ type: 'record-start' });
    expect(interpretKey(down(' ', { repeat: true }), voice)).toEqual({ type: 'record-start' });
    expect(interpretKey(up(' '), voice)).toEqual({ type: 'record-stop' });
    expect(interpretKey(down(' '), writing)).toBeNull();
    expect(interpretKey(down(' ', inText), voice)).toBeNull();
    expect(interpretKey(up(' ', inText), voice)).toBeNull();
    // отпускание останавливает запись, даже если экран успел стать не recordable
    expect(interpretKey(up(' '), writing)).toEqual({ type: 'record-stop' });
    expect(interpretKey(up('Enter'), mcq)).toBeNull();
  });

  it('isTyping: поля ввода и contenteditable', () => {
    expect(isTyping(down('a', { targetTag: 'textarea' }))).toBe(true);
    expect(isTyping(down('a', { targetTag: 'SELECT' }))).toBe(true);
    expect(isTyping(down('a', { targetTag: 'BUTTON' }))).toBe(false);
    expect(isTyping(down('a'))).toBe(false);
    expect(isTyping(down('a', { targetEditable: true }))).toBe(true);
  });
});

describe('горячие клавиши: подсказка', () => {
  const flat = (ctx: HotkeyContext, opts?: { mac?: boolean; textEntry?: boolean }) => hotkeyHints(ctx, opts).map(h => `${h.keys.join('+')} ${h.label}`);

  it('выбор варианта: цифры, Enter, Esc', () => {
    expect(flat(mcq)).toEqual(['1–4 выбрать вариант', 'Enter отправить', 'Esc отмена']);
    expect(flat({ ...mcq, choices: 2 })).toEqual(['1–2 выбрать вариант', 'Enter отправить', 'Esc отмена']);
  });

  it('текстовый ответ: Ctrl+Enter, на Mac — Cmd', () => {
    expect(flat(writing, { textEntry: true })).toEqual(['Ctrl+Enter отправить', 'Esc отмена']);
    expect(flat(writing, { textEntry: true, mac: true })).toEqual(['Cmd+Enter отправить', 'Esc отмена']);
  });

  it('разбор: только Enter — дальше и Esc', () => {
    expect(flat(review)).toEqual(['Enter дальше', 'Esc отмена']);
    expect(flat({ ...review, choices: 4, submit: true })).toEqual(['Enter дальше', 'Esc отмена']);
  });

  it('запись голоса показывается только с recordable; пустой контекст — пустая подсказка', () => {
    expect(flat({ submit: true, recordable: true }, { textEntry: true })).toEqual(['Ctrl+Enter отправить', 'Пробел удерживать — запись голоса']);
    expect(flat({})).toEqual([]);
    expect(flat({ cancel: true })).toEqual(['Esc отмена']);
  });

  it('aria-keyshortcuts и определение Mac', () => {
    expect(submitShortcut(true)).toBe('Control+Enter Meta+Enter');
    expect(submitShortcut(false)).toBe('Enter Control+Enter Meta+Enter');
    expect(isMacLike('MacIntel')).toBe(true);
    expect(isMacLike('iPhone')).toBe(true);
    expect(isMacLike('Win32')).toBe(false);
    expect(isMacLike('Linux x86_64')).toBe(false);
  });
});
