import { describe, it, expect } from 'vitest';
import { longDateRu } from '../functions/_lib/dates';

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
