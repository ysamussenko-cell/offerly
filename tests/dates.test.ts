import { describe, it, expect } from 'vitest';
import { addDays, daysBetween, longDateRu, todayIn, weekdayOf } from '../functions/_lib/dates';

describe('longDateRu', () => {
  it('пишет дату по-русски, с годом и без', () => {
    expect(longDateRu('2026-10-29')).toBe('29 октября 2026');
    expect(longDateRu('2026-11-01', false)).toBe('1 ноября');
    expect(longDateRu('2027-01-05')).toBe('5 января 2027');
  });
  it('из полной ISO-метки берёт дату UTC, без хвоста времени', () => {
    expect(longDateRu('2026-10-29T03:00:00.000Z')).toBe('29 октября 2026');
    expect(longDateRu('2026-12-31T23:59:59.000Z')).toBe('31 декабря 2026');
  });
});

describe('календарь', () => {
  it('todayIn берёт дату в поясе ученика, неизвестный пояс — дату UTC', () => {
    const now = new Date('2026-11-01T20:30:00Z');
    expect(todayIn('Asia/Almaty', now)).toBe('2026-11-02');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-11-01');
    expect(todayIn('Нет/Такого', now)).toBe('2026-11-01');
  });
  it('addDays переходит через месяц и год, n может быть отрицательным', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-01', 0)).toBe('2026-11-01');
  });
  it('daysBetween со знаком и согласован с addDays', () => {
    expect(daysBetween('2026-10-30', '2026-11-23')).toBe(24);
    expect(daysBetween('2026-11-23', '2026-10-30')).toBe(-24);
    for (const n of [-40, -1, 0, 1, 7, 365]) expect(daysBetween('2026-11-01', addDays('2026-11-01', n))).toBe(n);
  });
  it('weekdayOf: 0 — воскресенье, 6 — суббота', () => {
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(weekdayOf('2026-11-07')).toBe(6);
    expect(weekdayOf('2026-11-02')).toBe(1);
  });
});
