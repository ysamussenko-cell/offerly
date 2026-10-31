/** Настройки (4.6): свой ключ провайдера, общее время уведомлений, экспорт данных. Ошибки SettingsError уходят в app.onError. */
import { PROVIDERS } from '../providers';
import { parseNotifyAt, localClock, DEFAULT_NOTIFY_AT, SEND_WINDOW_MINUTES } from '../digest';
import { sentOnIfPassed } from '../push';
import { masterKey, parseKeyBody, saveKey, checkKey, publicKey, providerOptions, decryptSecret, exportData, exportCounts, exportFileName } from '../settings';
import { area, bodyOf, requireAuth, type Ctx } from './context';

export function settingsRoutes(version: string) {
  const r = area();

  /** Сводка настроек: ключ (без самого ключа), откуда мастер-ключ, оба канала уведомлений с общим поясом, счётчики для экспорта. */
  const settingsView = async (c: Ctx) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const now = new Date();
    const row = await store.getProviderKey(user.id);
    const { key: mk, source } = await masterKey(c.env, store, now.toISOString());
    const readable = row ? (await decryptSecret(mk, row.keyEnc, user.id)) != null : false;
    const p = await store.getProfile(user.id);
    const push = await store.getPushSetting(user.id);
    const subs = await store.listPushSubscriptions(user.id);
    const clock = localClock(user.tz, now);
    return {
      ok: true,
      provider: { key: publicKey(row, readable), keySource: source, providers: providerOptions(), builtin: PROVIDERS[0].name },
      notifications: {
        tz: user.tz, localTime: clock.time, defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES,
        mail: { at: p?.notifyAt ?? null, enabled: Boolean(p?.notifyAt), configured: Boolean(c.env.RESEND_API_KEY) },
        push: { at: push?.pushAt ?? null, enabled: Boolean(push?.pushAt), devices: subs.length },
      },
      data: { counts: await exportCounts(store, user.id), file: exportFileName(clock.date) },
    };
  };

  r.get('/settings', requireAuth, async (c) => c.json(await settingsView(c)));

  /** Сохранить свой ключ: {provider, apiKey, model?}. Ключ шифруется, в ответе — только провайдер, модель и последние четыре знака. */
  r.put('/settings/key', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const v = parseKeyBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'key_invalid', reason: v.reason }, 400);
    await saveKey(c.env, c.get('store'), user.id, v.value, new Date().toISOString());
    return c.json(await settingsView(c));
  });

  /** Проверить сохранённый ключ коротким вызовом модели (без отката на встроенную): {ok, reply | detail}. */
  r.post('/settings/key/check', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const k = await checkKey(c.env, c.get('store'), user.id, new Date().toISOString());
    const view = await settingsView(c);
    if (!k.ok) return c.json({ ...view, ok: false, error: 'key_check_failed', detail: k.detail }, 502);
    return c.json({ ...view, reply: k.reply });
  });

  /** Убрать свой ключ — дальше работает встроенная модель. */
  r.delete('/settings/key', requireAuth, async (c) => {
    const removed = await c.get('store').deleteProviderKey(c.get('auth')!.user.id);
    return c.json({ ...(await settingsView(c)), removed });
  });

  /** Общее время уведомлений: {at: "HH:MM", mail: bool, push: bool}. Канал без галочки выключается; push без подписанных
   *  устройств включить нельзя — push_no_subscriptions 404. Прошедшее сегодня время — первое уведомление завтра. */
  r.put('/settings/notifications', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await bodyOf(c);
    const mail = body?.mail === true, push = body?.push === true;
    const v = mail || push ? parseNotifyAt(body?.at) : { ok: true as const, value: null };
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    if (push && (await store.listPushSubscriptions(user.id)).length === 0) return c.json({ ok: false, error: 'push_no_subscriptions' }, 404);
    const now = new Date();
    const at = v.value;
    const mailAt = mail ? at : null, pushAt = push ? at : null;
    await store.saveNotifyAt(user.id, mailAt, sentOnIfPassed(mailAt, user.tz, now), now.toISOString());
    await store.savePushAt(user.id, pushAt, sentOnIfPassed(pushAt, user.tz, now), now.toISOString());
    return c.json(await settingsView(c));
  });

  /** Все данные пользователя одним JSON-файлом (без ключа провайдера и адресов push-подписок). */
  r.get('/export', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const now = new Date();
    const data = await exportData(c.get('store'), user, version, now.toISOString());
    const name = exportFileName(localClock(user.tz, now).date);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    });
  });

  return r;
}
