import { describe, it, expect } from 'vitest';
import { autoHint, isEvening, readMode, resolveTheme, THEME_COLORS, THEME_KEY, THEME_LABELS, THEME_MODES, writeMode } from '../src/theme';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, map: m };
};

describe('тема оформления', () => {
  it('вечер — с 20:00 до 7:00', () => {
    expect(isEvening(20)).toBe(true);
    expect(isEvening(23)).toBe(true);
    expect(isEvening(0)).toBe(true);
    expect(isEvening(6)).toBe(true);
    expect(isEvening(7)).toBe(false);
    expect(isEvening(12)).toBe(false);
    expect(isEvening(19)).toBe(false);
  });

  it('auto: тёмная вечером или по системе, иначе светлая', () => {
    expect(resolveTheme('auto', { prefersDark: false, hour: 12 })).toBe('light');
    expect(resolveTheme('auto', { prefersDark: false, hour: 21 })).toBe('dark');
    expect(resolveTheme('auto', { prefersDark: true, hour: 12 })).toBe('dark');
    expect(resolveTheme('auto', { prefersDark: true, hour: 3 })).toBe('dark');
  });

  it('явный режим сильнее времени и системы', () => {
    expect(resolveTheme('light', { prefersDark: true, hour: 23 })).toBe('light');
    expect(resolveTheme('dark', { prefersDark: false, hour: 12 })).toBe('dark');
  });

  it('режим читается из хранилища, мусор и отсутствие — auto', () => {
    const s = mem();
    expect(readMode(s)).toBe('auto');
    s.setItem(THEME_KEY, 'dark');
    expect(readMode(s)).toBe('dark');
    s.setItem(THEME_KEY, 'neon');
    expect(readMode(s)).toBe('auto');
    expect(readMode(undefined)).toBe('auto');
    const broken = { getItem: () => { throw new Error('private'); }, setItem: () => {}, removeItem: () => {} };
    expect(readMode(broken)).toBe('auto');
  });

  it('запись: auto убирает ключ, остальное пишет', () => {
    const s = mem();
    writeMode(s, 'light');
    expect(s.map.get(THEME_KEY)).toBe('light');
    writeMode(s, 'auto');
    expect(s.map.has(THEME_KEY)).toBe(false);
    expect(() => writeMode({ getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => {} }, 'dark')).not.toThrow();
  });

  it('подписи режимов и цвет строки браузера по дизайн-проекту', () => {
    expect(THEME_MODES).toEqual(['auto', 'light', 'dark']);
    expect(Object.values(THEME_LABELS)).toEqual(['Авто', 'Светлая', 'Тёмная']);
    expect(THEME_COLORS.light).toBe('#141C2B');
    expect(THEME_COLORS.dark).toBe('#0F1520');
  });

  it('подсказка под «Авто» объясняет, почему тема такая', () => {
    expect(autoHint('light', { prefersDark: false, hour: 12 })).toContain('светлая');
    expect(autoHint('dark', { prefersDark: true, hour: 12 })).toContain('система');
    expect(autoHint('dark', { prefersDark: false, hour: 22 })).toContain('20:00');
  });
});
