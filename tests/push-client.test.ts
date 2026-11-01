import { describe, it, expect } from 'vitest';
import { pushSupport, pushStatusText, urlBase64ToUint8Array, keyToBase64Url, permissionText, SUPPORT_TEXT, PUSH_CLIENT_ERRORS, type SupportEnv } from '../src/push';
import { ERRORS, type Push } from '../src/api';
import { b64url, generateVapidKeys } from '../functions/_lib/push';

const env = (over: Partial<SupportEnv> = {}): SupportEnv => ({
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', secure: true, serviceWorker: true, pushManager: true, notification: true, standalone: false, ...over,
});
const view = (over: Partial<Push> = {}): Push => ({
  ok: true, defaultAt: '07:30', windowMinutes: 180, stepMinutes: 15, publicKey: 'BA', keySource: 'db', pushAt: '07:41', enabled: true, tz: 'Asia/Almaty', localTime: '08:00',
  today: '2026-11-12', state: 'sent', sentOn: '2026-11-12', note: 'sent', next: { date: '2026-11-13', time: '07:41' }, subscriptions: [{ id: 's1', device: 'Chrome · Windows', createdAt: '2026-11-01T00:00:00.000Z', lastSentAt: null, lastError: null }], ...over,
});

describe('поддержка Web Push в браузере', () => {
  it('Chrome на компьютере — ok; без HTTPS, без service worker, без PushManager — отдельные причины', () => {
    expect(pushSupport(env())).toBe('ok');
    expect(pushSupport(env({ secure: false }))).toBe('insecure');
    expect(pushSupport(env({ serviceWorker: false }))).toBe('no_sw');
    expect(pushSupport(env({ pushManager: false }))).toBe('no_push');
    expect(pushSupport(env({ notification: false }))).toBe('no_notification');
  });
  it('iPhone в Safari без установки — инструкция добавить на экран «Домой»; установленное приложение — ok', () => {
    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
    expect(pushSupport(env({ ua: ios, pushManager: false, notification: false }))).toBe('ios_install');
    expect(pushSupport(env({ ua: ios, standalone: true }))).toBe('ok');
    expect(SUPPORT_TEXT.ios_install).toMatch(/На экран „Домой“/);
    for (const t of Object.values(SUPPORT_TEXT)) expect(t).toMatch(/\.$/);
    for (const t of Object.values(PUSH_CLIENT_ERRORS)) expect(t).toMatch(/\.$/);
    for (const k of ['push_invalid', 'push_no_subscriptions', 'push_failed', 'vapid_invalid', 'notify_invalid']) expect(ERRORS[k]).toMatch(/\.$/);
    expect(permissionText('denied')).toMatch(/запрещены/);
    expect(permissionText('granted')).toBeNull();
    expect(permissionText('default')).toBeNull();
  });
  it('ключ VAPID → байты для applicationServerKey и обратно', async () => {
    const k = await generateVapidKeys();
    const bytes = urlBase64ToUint8Array(k.publicKey);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(keyToBase64Url(bytes.buffer as ArrayBuffer)).toBe(k.publicKey);
    expect(keyToBase64Url(null)).toBeNull();
    expect([...b64url.decode(k.publicKey)]).toEqual([...bytes]);
  });
});

describe('строка состояния напоминания', () => {
  it('выключено — с подписками и без; отправлено; пропущено, потому что занятие пройдено; ошибка; рано; пора; поздно', () => {
    expect(pushStatusText(view({ enabled: false, pushAt: null, state: 'off', next: null, subscriptions: [] }))).toMatch(/^Выключено\. Включите/);
    expect(pushStatusText(view({ enabled: false, pushAt: null, state: 'off', next: null }))).toMatch(/устройства подписаны/);
    expect(pushStatusText(view())).toBe('Сегодняшнее напоминание отправлено; следующее 13 ноября 2026 г. в 07:41.');
    expect(pushStatusText(view({ note: 'sent:1/2' }))).toMatch(/^Сегодняшнее напоминание отправлено/);
    expect(pushStatusText(view({ note: 'skipped:done' }))).toMatch(/занятие уже было пройдено/);
    expect(pushStatusText(view({ note: 'skipped:enabled_after' }))).toBe('Напоминание включено, когда сегодняшнее время уже прошло; первое — 13 ноября 2026 г. в 07:41.');
    expect(pushStatusText(view({ note: 'skipped:no_subscriptions' }))).toMatch(/устройств не было/);
    expect(pushStatusText(view({ note: 'skipped:late' }))).toMatch(/окно отправки прошло/);
    expect(pushStatusText(view({ note: 'error:410 gone' }))).toMatch(/доставить не удалось \(410 gone\)/);
    expect(pushStatusText(view({ state: 'early', sentOn: null, next: { date: '2026-11-12', time: '07:41' } }))).toBe('Сегодня ещё не отправлялось; следующее сегодня в 07:41 (в течение 15 минут после назначенного времени).');
    expect(pushStatusText(view({ state: 'due', sentOn: null }))).toMatch(/в ближайшие 15 минут/);
    expect(pushStatusText(view({ state: 'late', sentOn: null }))).toMatch(/3 часа после назначенного времени/);
  });
});
