/** Ежедневное письмо и напоминание (4.4, 4.5) в настоящем Chromium — две карточки главного экрана, которых не было в сценариях.
 *  Почты на стенде нет (ключа RESEND_API_KEY нет): карточка письма предупреждает об этом, «прислать сейчас» отвечает понятной ошибкой.
 *  Push-служба подменена: подписка устройства кладётся через API с настоящими ключами P-256 (браузер без push-службы
 *  подписаться не может), а запросы на https://push.e2e.test перехватываются в процессе стенда — служба сначала принимает
 *  напоминание (201), потом отвечает 410, и устройство пропадает из списка. Время включения выбирается заведомо прошедшим
 *  (00:00 в поясе ученика), поэтому первое письмо и напоминание — завтра, и карточка не должна писать «отправлено». */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { openWorld, closeWorld, login, seed, text, card, shot, inPage, EMAIL, type World } from './helpers';
import { localClock, ENABLED_AFTER } from '../functions/_lib/digest';

const PUSH_HOST = 'push.e2e.test';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let w: World;
/** Что ответит подменённая push-служба и что она получила. */
let pushStatus = 201;
const pushed: { url: string; headers: Record<string, string>; bytes: number }[] = [];

beforeAll(async () => {
  w = await openWorld();
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host !== PUSH_HOST) return real(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    pushed.push({ url, headers, bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0 });
    return new Response(pushStatus === 201 ? '' : 'subscription expired', { status: pushStatus });
  });
  await login(w.page, w.stand.url);
  await seed(w.stand);
  await w.page.reload();
});
afterAll(async () => { vi.unstubAllGlobals(); await closeWorld(w); });

const user = () => w.stand.rows<{ id: string; tz: string }>('SELECT id, tz FROM users WHERE email = ?', EMAIL)[0];
/** 00:00 уже прошло везде, кроме первой минуты суток, — тогда сценарий проверяет только то, что не зависит от часа. */
const afterMidnight = () => localClock(user().tz, new Date()).minutes > 0;
const note = (c: ReturnType<typeof card>) => c.getByRole('status');

/** Подписка устройства через API под cookie браузера: ключи настоящие (P-256 и 16 байт auth), адрес — подменённая служба. */
async function subscribeDevice(id: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const body = JSON.stringify({ endpoint: `https://${PUSH_HOST}/${id}`, keys: { p256dh, auth }, userAgent: WINDOWS_UA });
  return inPage<number>(w.page, `fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }).then(r => r.status)`);
}

describe('ежедневное письмо', () => {
  it('выключено: строка состояния, предупреждение о почте, предпросмотр сегодняшнего письма', async () => {
    const dc = card(w.page, 'Ежедневное письмо');
    await dc.getByText('Выключено. Включите').waitFor();
    expect(await text(dc)).toContain('Почта на сервере не настроена — письма не уйдут, пока не задан ключ RESEND_API_KEY.');
    const toggle = dc.getByRole('button', { name: /^Показать сегодняшний текст: «Offerly, / });
    const subject = (await text(toggle)).match(/«(.+)»/)![1];
    await toggle.click();
    const pre = dc.locator('pre');
    expect(subject).toMatch(/^Offerly, 1?\d+ \S+: .+/);
    expect(await text(pre)).toMatch(/Задание дня — /);
    expect(await text(pre)).toContain('К повтору в журнале ошибок: 2 карточки.');
    expect(await text(pre)).toContain('Готовность: 53 из 100');
    await dc.getByRole('button', { name: 'Скрыть сегодняшний текст' }).click();
    expect(await pre.count()).toBe(0);
  });

  it('включено на прошедшее время: первое письмо завтра, карточка не пишет «отправлено»; в базе заметка дня', async () => {
    const dc = card(w.page, 'Ежедневное письмо');
    await dc.locator('input[type="time"]').fill('00:00');
    await dc.getByRole('button', { name: 'Включить' }).click();
    expect(await text(note(dc))).toMatch(/^Письмо будет приходить в 00:00 \(.+\)\.$/);
    expect(await text(dc.locator('.row h2 + span'))).toBe('в 00:00');
    const p = w.stand.rows<{ notifyAt: string; digestSentOn: string | null; digestNote: string | null }>('SELECT notify_at, digest_sent_on, digest_note FROM profiles WHERE user_id = ?', user().id)[0];
    expect(p.notifyAt).toBe('00:00');
    if (afterMidnight()) {
      expect(p).toMatchObject({ digestSentOn: localClock(user().tz, new Date()).date, digestNote: ENABLED_AFTER });
      await w.page.reload();
      await card(w.page, 'Ежедневное письмо').getByText(/^Письмо включено, когда сегодняшнее время уже прошло; первое — .+ в 00:00\.$/).waitFor();
    }
    expect(await text(card(w.page, 'Ежедневное письмо'))).not.toContain('письмо отправлено');
    await shot(w.page, 'notify-digest');
  });

  it('«прислать сейчас» без почты — понятная ошибка, день не отмечается отправкой; «выключить» — письмо выключено', async () => {
    const dc = card(w.page, 'Ежедневное письмо');
    await dc.getByRole('button', { name: 'прислать сейчас' }).click();
    expect(await text(dc.locator('p.error'))).toBe('Отправка писем пока не настроена. Нужен ключ RESEND_API_KEY в секретах проекта.');
    expect(w.stand.rows<{ digestSentAt: string | null }>('SELECT digest_sent_at FROM profiles WHERE user_id = ?', user().id)[0].digestSentAt).toBeNull();
    await dc.getByRole('button', { name: 'выключить' }).click();
    expect(await text(note(dc))).toBe('Письмо выключено.');
    await dc.getByText('Выключено. Включите').waitFor();
    expect(w.stand.rows<{ notifyAt: string | null }>('SELECT notify_at FROM profiles WHERE user_id = ?', user().id)[0].notifyAt).toBeNull();
  });
});

describe('напоминание', () => {
  it('без устройств: напоминание выключено, формы времени нет', async () => {
    const pc = card(w.page, 'Напоминание');
    await pc.getByText(/^Выключено\. Включите — и раз в день/).waitFor();
    expect(await pc.locator('input[type="time"]').count()).toBe(0);
  });

  it('устройство подписано: список устройств, время по умолчанию, прошедшее время включения — не «отправлено»', async () => {
    expect(await subscribeDevice('d1')).toBe(200);
    await w.page.reload();
    const pc = card(w.page, 'Напоминание');
    await pc.getByText(/^Chrome · Windows — подписано .+, напоминаний ещё не было$/).waitFor();
    const setting = w.stand.rows<{ pushAt: string; sentOn: string | null; note: string | null }>('SELECT push_at, sent_on, note FROM push_settings WHERE user_id = ?', user().id)[0];
    expect(setting.pushAt).toBe('07:30'); // письмо выключено — время по умолчанию
    expect(await pc.locator('input[type="time"]').inputValue()).toBe('07:30');
    if (setting.sentOn) {
      expect(setting.note).toBe(ENABLED_AFTER);
      await pc.getByText(/^Напоминание включено, когда сегодняшнее время уже прошло; первое — .+ в 07:30\.$/).waitFor();
    } else await pc.getByText(/^Сегодня ещё не отправлялось; следующее сегодня в 07:30/).waitFor();
    expect(await text(pc)).not.toContain('напоминание отправлено');
  });

  it('«Переставить» на 00:00, «прислать сейчас»: служба приняла — зашифрованное напоминание с подписью VAPID, время доставки в списке', async () => {
    const pc = card(w.page, 'Напоминание');
    await pc.locator('input[type="time"]').fill('00:00');
    await pc.getByRole('button', { name: 'Переставить' }).click();
    expect(await text(note(pc))).toMatch(/^Напоминание будет приходить в 00:00 \(.+\)\.$/);
    if (afterMidnight()) await pc.getByText(/^Напоминание включено, когда сегодняшнее время уже прошло; первое — .+ в 00:00\.$/).waitFor();

    await pc.getByRole('button', { name: 'прислать сейчас' }).click();
    expect(await text(note(pc))).toMatch(/^Отправлено на 1 из 1: «Offerly: .+». Уведомление появится в течение нескольких секунд\.$/);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].url).toBe(`https://${PUSH_HOST}/d1`);
    expect(pushed[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', urgency: 'normal' });
    expect(pushed[0].headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(pushed[0].bytes).toBeGreaterThan(86); // заголовок aes128gcm (86 байт) плюс шифротекст
    await pc.getByText(/^Chrome · Windows — подписано .+, последнее напоминание .+$/).waitFor();
    // ручная отправка день не отмечает
    expect(w.stand.rows<{ note: string | null }>('SELECT note FROM push_settings WHERE user_id = ?', user().id)[0].note).toBe(afterMidnight() ? ENABLED_AFTER : null);
  });

  it('служба ответила 410: устройство удаляется из базы и списка, карточка объясняет отказ и снова предлагает подписать устройство', async () => {
    pushStatus = 410;
    const pc = card(w.page, 'Напоминание');
    await pc.getByRole('button', { name: 'прислать сейчас' }).click();
    expect(await text(pc.locator('p.error'))).toBe('Push-служба не приняла напоминание ни на одном устройстве. Проверьте, что уведомления сайта разрешены, и повторите.');
    expect(pushed).toHaveLength(2);
    expect(w.stand.rows('SELECT id FROM push_subscriptions WHERE user_id = ?', user().id)).toHaveLength(0);
    await pc.getByText(/^Выключено: устройства подписаны|^Сегодня|^Напоминание включено/).first().waitFor();
    expect(await pc.locator('li').count()).toBe(0);
    await shot(w.page, 'notify-push');
  });
});
