import { describe, it, expect } from 'vitest';
import { digestStatusText } from '../src/screens/Digest';
import type { Digest } from '../src/api';

const view = (over: Partial<Digest> = {}): Digest => ({
  ok: true, defaultAt: '07:30', windowMinutes: 180, stepMinutes: 15, notifyAt: '07:41', enabled: true, tz: 'Asia/Almaty', localTime: '09:00',
  today: '2026-11-12', state: 'sent', sentOn: '2026-11-12', note: 'sent', next: { date: '2026-11-13', time: '07:41' }, mail: 'ok', ...over,
});

describe('строка состояния письма', () => {
  it('«отправлено» — только когда письмо действительно ушло (по расписанию, вручную или старая запись без заметки)', () => {
    expect(digestStatusText(view())).toBe('Сегодняшнее письмо отправлено; следующее 13 ноября 2026 г. в 07:41.');
    expect(digestStatusText(view({ note: 'sent:manual' }))).toMatch(/^Сегодняшнее письмо отправлено/);
    expect(digestStatusText(view({ note: null }))).toMatch(/^Сегодняшнее письмо отправлено/);
  });
  it('день отмечен без письма: включено после назначенного времени, окно прошло, почта не настроена, ошибка отправки', () => {
    expect(digestStatusText(view({ note: 'skipped:enabled_after' }))).toBe('Письмо включено, когда сегодняшнее время уже прошло; первое — 13 ноября 2026 г. в 07:41.');
    expect(digestStatusText(view({ note: 'skipped:late' }))).toBe('Сегодня окно отправки прошло; следующее 13 ноября 2026 г. в 07:41.');
    expect(digestStatusText(view({ note: 'skipped:mail_not_configured' }))).toMatch(/^Сегодня письмо не ушло — почта на сервере не настроена; следующее/);
    expect(digestStatusText(view({ note: 'error:403 forbidden' }))).toMatch(/^Сегодня отправить не удалось \(403 forbidden\); следующее/);
    for (const note of ['skipped:enabled_after', 'skipped:late', 'skipped:mail_not_configured', 'error:x']) expect(digestStatusText(view({ note }))).not.toMatch(/отправлено/);
  });
  it('выключено, рано, пора, поздно — как раньше', () => {
    expect(digestStatusText(view({ enabled: false, notifyAt: null, state: 'off', next: null }))).toMatch(/^Выключено\. Включите/);
    expect(digestStatusText(view({ state: 'early', sentOn: null, note: null, next: { date: '2026-11-12', time: '07:41' } }))).toBe('Сегодня ещё не отправлялось; следующее сегодня в 07:41 (придёт в течение 15 минут после назначенного времени).');
    expect(digestStatusText(view({ state: 'due', sentOn: null }))).toMatch(/^Время наступило/);
    expect(digestStatusText(view({ state: 'late', sentOn: null }))).toMatch(/^Сегодня окно отправки прошло \(3 часа/);
  });
});
