/** Главный экран (3.4), ежедневное письмо (4.4) и Web Push (4.5, 5.2). Ошибки PushError уходят в app.onError. */
import { dashboard, parseGoal, GAIN_PER_LESSON, MISS_PENALTY, MISS_CAP, FREEZES_PER_WEEK, GOAL_MIN, GOAL_MAX, GOAL_DAYS_DEFAULT } from '../dashboard';
import { BONUS_MULTIPLIER } from '../lesson';
import { parseNotifyAt, digestState, nextDigest, buildDigest, collectDigest, sendDigestNow, localClock, minutesOf, DEFAULT_NOTIFY_AT, SEND_WINDOW_MINUTES, CRON_STEP_MINUTES } from '../digest';
import { vapidKeys, parseSubscribeBody, publicSubscription, sendPushNow, buildReminder, sentOnIfPassed } from '../push';
import { area, bodyOf, profileOf, requireAuth, type Ctx } from './context';

export function dashboardRoutes() {
  const r = area();
  const dashboardMeta = { gainPerLesson: GAIN_PER_LESSON, missPenalty: MISS_PENALTY, missCap: MISS_CAP, freezesPerWeek: FREEZES_PER_WEEK, goalMin: GOAL_MIN, goalMax: GOAL_MAX, goalDays: GOAL_DAYS_DEFAULT, bonusMultiplier: BONUS_MULTIPLIER };

  /** Готовность 0–100 с разбором и прогнозом, обратный отсчёт, серия с заморозкой, недельная цель и план недели. */
  r.get('/dashboard', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    return c.json({ ok: true, ...dashboardMeta, ...(await dashboard(c.get('store'), user.id, user.tz, await profileOf(c))) });
  });

  /** Своя недельная цель: {minutes} — целое от GOAL_MIN до GOAL_MAX; null — вернуться к значению по умолчанию. */
  r.put('/dashboard/goal', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const v = parseGoal(body?.minutes);
    if (!v.ok) return c.json({ ok: false, error: 'goal_invalid', reason: v.reason }, 400);
    await c.get('store').saveWeeklyGoal(user.id, v.minutes, new Date().toISOString());
    return c.json({ ok: true, ...dashboardMeta, ...(await dashboard(c.get('store'), user.id, user.tz, await profileOf(c))) });
  });

  // --- ежедневное письмо ---

  const digestMeta = { defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES, stepMinutes: CRON_STEP_MINUTES };
  /** Состояние письма: время, включено ли, что было сегодня, когда следующее, настроена ли почта — и предпросмотр (тема и текст). */
  const digestView = async (c: Ctx, preview: boolean) => {
    const user = c.get('auth')!.user;
    const p = await profileOf(c);
    const now = new Date();
    const s = digestState({ notifyAt: p?.notifyAt ?? null, digestSentOn: p?.digestSentOn ?? null }, user.tz, now);
    const out: Record<string, unknown> = {
      ok: true, ...digestMeta, notifyAt: p?.notifyAt ?? null, enabled: s.state !== 'off', tz: user.tz, localTime: s.time, today: s.date, state: s.state,
      sentOn: p?.digestSentOn ?? null, note: p?.digestNote ?? null, next: nextDigest({ notifyAt: p?.notifyAt ?? null, digestSentOn: p?.digestSentOn ?? null }, user.tz, now),
      mail: c.env.RESEND_API_KEY ? 'ok' : 'missing',
    };
    if (preview) {
      const { mail, data } = await buildDigest(c.env, c.get('store'), user, p);
      out.preview = { subject: mail.subject, text: mail.text, headline: mail.headline, dueCards: data.dueCards };
    }
    return out;
  };

  r.get('/digest', requireAuth, async (c) => c.json(await digestView(c, c.req.query('preview') !== '0')));

  /** Время письма: {notifyAt: "HH:MM"} — включить или переставить; {notifyAt: null} — выключить.
   *  Если назначенное время сегодня уже прошло, первое письмо придёт завтра (день отмечается сразу). */
  r.put('/digest', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const v = parseNotifyAt(body?.notifyAt);
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    const now = new Date();
    const clock = localClock(user.tz, now);
    const sentOn = v.value && clock.minutes >= minutesOf(v.value) ? clock.date : null;
    await c.get('store').saveNotifyAt(user.id, v.value, sentOn, now.toISOString());
    return c.json(await digestView(c, false));
  });

  /** Прислать письмо сейчас, вне расписания. Почта не настроена — 503, Resend отказал — 502. */
  r.post('/digest/send', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const d = await sendDigestNow(c.env, c.get('store'), user, await profileOf(c));
    if (!d.result.sent) {
      if (d.result.reason === 'provider_error') { console.error(d.result.detail); return c.json({ ok: false, error: 'mail_failed', detail: d.result.detail }, 502); }
      return c.json({ ok: false, error: 'mail_not_configured' }, 503);
    }
    return c.json({ ok: true, subject: d.subject, sentOn: d.sentOn, id: d.result.id ?? null });
  });

  // --- Web Push: одно напоминание в день ---

  const pushMeta = { defaultAt: DEFAULT_NOTIFY_AT, windowMinutes: SEND_WINDOW_MINUTES, stepMinutes: CRON_STEP_MINUTES };
  /** Состояние напоминания: открытый ключ VAPID для PushManager, время, состояние дня, следующий срок, устройства (без endpoint и ключей).
   *  Испорченные ключи VAPID — PushError vapid_invalid → 503 через app.onError. */
  const pushView = async (c: Ctx) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const now = new Date();
    const { keys, source } = await vapidKeys(c.env, store, now.toISOString());
    const setting = await store.getPushSetting(user.id);
    const p = { notifyAt: setting?.pushAt ?? null, digestSentOn: setting?.sentOn ?? null };
    const s = digestState(p, user.tz, now);
    const subs = await store.listPushSubscriptions(user.id);
    return {
      ok: true, ...pushMeta, publicKey: keys.publicKey, keySource: source, pushAt: setting?.pushAt ?? null, enabled: s.state !== 'off', tz: user.tz, localTime: s.time, today: s.date,
      state: s.state, sentOn: setting?.sentOn ?? null, note: setting?.note ?? null, next: nextDigest(p, user.tz, now), subscriptions: subs.map(publicSubscription),
    };
  };

  r.get('/push', requireAuth, async (c) => c.json(await pushView(c)));

  /** Время напоминания: {pushAt: "HH:MM"} — включить или переставить; {pushAt: null} — выключить (подписки устройств остаются). */
  r.put('/push', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const body = await bodyOf(c);
    const v = parseNotifyAt(body?.pushAt);
    if (!v.ok) return c.json({ ok: false, error: 'notify_invalid', reason: v.reason }, 400);
    const now = new Date();
    await c.get('store').savePushAt(user.id, v.value, sentOnIfPassed(v.value, user.tz, now), now.toISOString());
    return c.json(await pushView(c));
  });

  /** Подписка браузера: {endpoint, keys:{p256dh, auth}, userAgent?, pushAt?}. Если напоминание ещё не включено — включается
   *  на pushAt, иначе на время письма, иначе на время по умолчанию. */
  r.post('/push/subscribe', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await bodyOf(c);
    const v = parseSubscribeBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'push_invalid', reason: v.reason }, 400);
    const at = body?.pushAt === undefined ? { ok: true as const, value: null } : parseNotifyAt(body.pushAt);
    if (!at.ok) return c.json({ ok: false, error: 'notify_invalid', reason: at.reason }, 400);
    const now = new Date();
    const existing = (await store.listPushSubscriptions(user.id)).find((s: { endpoint: string }) => s.endpoint === v.value.endpoint);
    await store.upsertPushSubscription({ id: existing?.id ?? crypto.randomUUID(), userId: user.id, ...v.value, createdAt: existing?.createdAt ?? now.toISOString(), lastSentAt: existing?.lastSentAt ?? null, lastError: null });
    const setting = await store.getPushSetting(user.id);
    if (!setting?.pushAt || at.value) {
      const pushAt = at.value ?? (await store.getProfile(user.id))?.notifyAt ?? DEFAULT_NOTIFY_AT;
      await store.savePushAt(user.id, pushAt, sentOnIfPassed(pushAt, user.tz, now), now.toISOString());
    }
    return c.json(await pushView(c));
  });

  /** Отписать это устройство: {endpoint}. Последнее устройство выключает и напоминание — слать больше некуда. */
  r.delete('/push/subscribe', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const body = await bodyOf(c);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) return c.json({ ok: false, error: 'push_invalid', reason: 'endpoint' }, 400);
    const removed = await store.deletePushSubscription(endpoint, user.id);
    const now = new Date();
    if ((await store.listPushSubscriptions(user.id)).length === 0 && (await store.getPushSetting(user.id))?.pushAt) await store.savePushAt(user.id, null, null, now.toISOString());
    return c.json({ ...(await pushView(c)), removed });
  });

  /** Прислать напоминание сейчас на все устройства; день не отмечается. Устройств нет — 404, ни одно не приняло — 502. */
  r.post('/push/send', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    if ((await store.listPushSubscriptions(user.id)).length === 0) return c.json({ ok: false, error: 'push_no_subscriptions' }, 404);
    const s = await sendPushNow(c.env, store, user, await store.getProfile(user.id));
    if (s.delivered === 0) { console.error(JSON.stringify(s.devices)); return c.json({ ok: false, error: 'push_failed', devices: s.devices, reminder: s.reminder }, 502); }
    return c.json({ ok: true, delivered: s.delivered, devices: s.devices, reminder: s.reminder });
  });

  /** Напоминание дня для приложения Windows (5.2): текст и срок без отправки — приложение показывает его нативным уведомлением само,
   *  когда окно свёрнуто в трей. at — время напоминания, если оно включено, иначе время письма, иначе по умолчанию;
   *  todayDone — день уже пройден (занятие, репетиция или срез), напоминать не о чем. */
  r.get('/push/reminder', requireAuth, async (c) => {
    const user = c.get('auth')!.user;
    const store = c.get('store');
    const now = new Date();
    const setting = await store.getPushSetting(user.id);
    const p = await store.getProfile(user.id);
    const at = setting?.pushAt ?? p?.notifyAt ?? DEFAULT_NOTIFY_AT;
    const clock = localClock(user.tz, now);
    const data = await collectDigest(store, user, p);
    const reminder = buildReminder(data, c.env);
    return c.json({
      ok: true, at, tz: user.tz, localTime: clock.time, today: clock.date, windowMinutes: SEND_WINDOW_MINUTES, todayDone: data.todayDone,
      reminder: { title: reminder.title, body: reminder.body },
    });
  });

  return r;
}
