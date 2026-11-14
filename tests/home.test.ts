import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { countdownByDays, todayButtonText, todayView, weekMarkLabel } from '../src/screens/Home';
import type { Dashboard, ProgramDay, WeekDay } from '../src/api';

const TODAY = '2026-11-12';
const programDay = (over: Partial<ProgramDay> = {}): ProgramDay => ({
  id: 'd1', date: TODAY, weekday: 'чт', position: 1, week: 1, format: 'lesson', formatLabel: 'занятие',
  topic: 'conjunctions', topicLabel: 'Союзы и инверсия', writing: null, writingLabel: null, reason: null,
  status: 'planned', minutes: 25, score: null, completedAt: null, today: true, past: false, ...over,
});
const cell = (over: Partial<WeekDay> = {}): WeekDay => ({ date: TODAY, weekday: 'чт', today: true, past: false, day: programDay(), status: 'today', minutes: 0, score: null, ...over });
const dash = (week: WeekDay[], exists = true): Pick<Dashboard, 'program' | 'week'> => ({ program: { exists, endDate: null, done: 0, total: exists ? 28 : 0 }, week });

describe('«Сегодня» на главном (7.1)', () => {
  it('день занятия: тема и минуты одной строкой, одна главная кнопка; недоделанное — «Продолжить»', () => {
    expect(todayView(dash([cell()]))).toEqual({ title: 'Союзы и инверсия · 25 минут', action: { format: 'lesson', label: 'Начать занятие', primary: true } });
    expect(todayView(dash([cell({ status: 'active' })])).action).toEqual({ format: 'lesson', label: 'Продолжить занятие', primary: true });
  });

  it('репетиция и срез — по формату дня и своей кнопкой', () => {
    const r = todayView(dash([cell({ day: programDay({ format: 'rehearsal', formatLabel: 'репетиция интервью', minutes: null }) })]));
    expect(r).toEqual({ title: 'Репетиция интервью', action: { format: 'rehearsal', label: 'Начать репетицию', primary: true } });
    expect(todayView(dash([cell({ status: 'active', day: programDay({ format: 'checkpoint', formatLabel: 'контрольный срез' }) })])).action?.label).toBe('Продолжить срез');
  });

  it('пройдено: балл в строке; у занятия — второстепенная «Открыть разбор», у репетиции кнопки нет', () => {
    expect(todayView(dash([cell({ status: 'done', score: 71 })]))).toEqual({ title: 'Союзы и инверсия — пройдено · 71', action: { format: 'lesson', label: 'Открыть разбор', primary: false } });
    expect(todayView(dash([cell({ status: 'done', score: null, day: programDay({ format: 'rehearsal', formatLabel: 'репетиция интервью' }) })]))).toEqual({ title: 'Репетиция интервью — пройдено', action: null });
  });

  it('нет программы или свободный день — одна строка без кнопки', () => {
    expect(todayView(dash([], false))).toEqual({ title: 'Программы ещё нет — составьте её в карточке «Программа».', action: null });
    expect(todayView(dash([cell({ day: null, status: 'free' })]))).toEqual({ title: 'По программе сегодня свободно.', action: null });
  });

  it('отметка недели: подпись только в подсказке; у свободного дня — без «свободно»', () => {
    expect(weekMarkLabel(cell({ status: 'done' }))).toBe('чт 12 нояб — Союзы и инверсия, пройдено');
    expect(weekMarkLabel(cell({ day: null, status: 'free' }))).toBe('чт 12 нояб');
  });

  it('срок и кнопки', () => {
    expect([countdownByDays(-1), countdownByDays(0), countdownByDays(1), countdownByDays(21)]).toEqual(['дата прошла', 'сегодня', 'завтра', 'через 21 день']);
    expect(todayButtonText('lesson', false)).toBe('Начать занятие');
  });

  it('без шума: на главной карточке нет механики готовности, серии, цели и абзацев', () => {
    const src = readFileSync('src/screens/Home.tsx', 'utf-8');
    const home = src.slice(src.indexOf('export function HomeCard'), src.indexOf('/** Недельная цель'));
    for (const word of ['База ', 'заморозк', 'Серия', 'бонус', 'Недельная цель', 'forecast', 'при текущем темпе']) expect(home, word).not.toContain(word);
    for (const m of home.matchAll(/>([^<>{}]{80,})</g)) throw new Error(`длинный текст на главном: ${m[1]}`);
    expect(readFileSync('src/App.tsx', 'utf-8')).not.toContain('LessonCard');
  });
});
