import { useEffect, useState } from 'react';
import { api, errorText, type Push } from '../api';
import { longDate, tzLabel } from '../text';
import { currentSubscription, permissionText, pushStatusText, pushSupport, subscribe, supportEnv, unsubscribe, PushClientError, SUPPORT_TEXT } from '../push';

type Props = { refreshKey?: number };

const when = (iso: string | null) => (iso ? `${longDate(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC` : null);

/** Карточка «Напоминание»: одно push-уведомление в день к назначенному времени — на этом и других устройствах.
 *  Подписка живёт в браузере (PushManager) и на сервере; расписание держит тот же Worker, что и письмо. */
export function PushCard({ refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; d: Push | null; error: string | null }>({ loaded: false, d: null, error: null });
  const [time, setTime] = useState('');
  const [here, setHere] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [busy, setBusy] = useState<'save' | 'subscribe' | 'unsubscribe' | 'send' | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const support = pushSupport(supportEnv());
  const permission: NotificationPermission | 'unsupported' = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  const load = () => api.push().then(d => { setState({ loaded: true, d, error: null }); setTime(d.pushAt ?? d.defaultAt); })
    .catch(e => setState({ loaded: true, d: null, error: errorText(e) }));

  useEffect(() => { load(); }, [refreshKey]);
  useEffect(() => { currentSubscription().then(s => setHere(s ? 'yes' : 'no')).catch(() => setHere('no')); }, [refreshKey, busy]);

  async function save(pushAt: string | null) {
    setBusy('save'); setNote(null);
    try {
      const d = await api.savePush(pushAt);
      setState({ loaded: true, d, error: null });
      setTime(d.pushAt ?? d.defaultAt);
      setNote({ kind: 'ok', text: d.enabled ? `Напоминание будет приходить в ${d.pushAt} (${tzLabel(d.tz)}).` : 'Напоминание выключено.' });
    } catch (e) { setNote({ kind: 'bad', text: errorText(e) }); }
    finally { setBusy(null); }
  }

  async function enableHere() {
    if (!state.d) return;
    setBusy('subscribe'); setNote(null);
    try {
      const sub = await subscribe(state.d.publicKey);
      const d = await api.subscribePush(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }, navigator.userAgent, state.d.enabled ? undefined : time || undefined);
      setState({ loaded: true, d, error: null });
      setTime(d.pushAt ?? d.defaultAt);
      setNote({ kind: 'ok', text: `Это устройство подписано. Напоминание придёт в ${d.pushAt} (${tzLabel(d.tz)}); нажмите «прислать сейчас», чтобы увидеть, как оно выглядит.` });
    } catch (e) { setNote({ kind: 'bad', text: e instanceof PushClientError ? e.message : errorText(e) }); }
    finally { setBusy(null); }
  }

  async function disableHere() {
    setBusy('unsubscribe'); setNote(null);
    try {
      const endpoint = await unsubscribe();
      if (endpoint) {
        const d = await api.unsubscribePush(endpoint);
        setState({ loaded: true, d, error: null });
        setNote({ kind: 'ok', text: d.enabled ? 'Это устройство отписано; на остальных напоминание остаётся.' : 'Это устройство отписано. Устройств не осталось — напоминание выключено.' });
      } else await load();
    } catch (e) { setNote({ kind: 'bad', text: errorText(e) }); }
    finally { setBusy(null); }
  }

  async function sendNow() {
    setBusy('send'); setNote(null);
    try {
      const r = await api.sendPush();
      setNote({ kind: 'ok', text: `Отправлено на ${r.delivered} из ${r.devices.length}: «${r.reminder.title} — ${r.reminder.body}». Уведомление появится в течение нескольких секунд.` });
      load();
    } catch (e) { setNote({ kind: 'bad', text: errorText(e) }); load(); }
    finally { setBusy(null); }
  }

  const d = state.d;
  const denied = permissionText(permission);
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Напоминание</h2>
        {d && <span className="muted" style={{ fontSize: 14 }}>{d.enabled ? `в ${d.pushAt}` : 'выключено'}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {d && (
        <>
          <p style={{ margin: '12px 0 0' }}>{pushStatusText(d)}</p>
          <p className="muted" style={{ fontSize: 14, margin: '4px 0 0' }}>
            Одно уведомление в день: задание дня, карточки к повтору, серия и минуты недели. Если занятие к этому времени уже пройдено, напоминание не приходит. Пояс — {tzLabel(d.tz)}, сейчас там {d.localTime}.
          </p>
          <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
            {support !== 'ok' && <span className="muted" style={{ fontSize: 14 }}>{SUPPORT_TEXT[support]}</span>}
            {support === 'ok' && here !== 'yes' && !denied && (
              <button className="btn" type="button" disabled={busy != null} onClick={enableHere}>{busy === 'subscribe' ? 'Подписываю…' : 'Включить на этом устройстве'}</button>
            )}
            {support === 'ok' && here === 'yes' && (
              <>
                <span className="ok" style={{ fontSize: 14 }}>Это устройство подписано.</span>
                <button className="link" type="button" disabled={busy != null} onClick={disableHere}>{busy === 'unsubscribe' ? 'отписываю…' : 'отписать это устройство'}</button>
              </>
            )}
            {denied && <span className="bad" style={{ fontSize: 14 }}>{denied}</span>}
          </div>
          {d.subscriptions.length > 0 && (
            <form className="row goal-form" onSubmit={e => { e.preventDefault(); save(time); }}>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <span>Время</span>
                <input type="time" value={time} onChange={e => setTime(e.target.value)} required style={{ width: 130 }} />
              </label>
              <button className="btn" type="submit" disabled={busy != null || !time || (d.enabled && time === d.pushAt)}>{busy === 'save' ? 'Сохраняю…' : d.enabled && time === d.pushAt ? 'Сохранено' : d.enabled ? 'Переставить' : 'Включить'}</button>
              {d.enabled && <button className="link" type="button" disabled={busy != null} onClick={() => save(null)}>выключить</button>}
              <button className="link" type="button" disabled={busy != null} onClick={sendNow}>{busy === 'send' ? 'отправляю…' : 'прислать сейчас'}</button>
            </form>
          )}
          {note && <p className={note.kind === 'ok' ? 'hint ok' : 'error'} role="status">{note.text}</p>}
          {d.subscriptions.length > 0 && (
            <ul className="muted" style={{ fontSize: 14, margin: '12px 0 0', paddingLeft: 18 }}>
              {d.subscriptions.map(s => (
                <li key={s.id}>
                  {s.device} — подписано {longDate(s.createdAt.slice(0, 10))}
                  {s.lastSentAt ? `, последнее напоминание ${when(s.lastSentAt)}` : ', напоминаний ещё не было'}
                  {s.lastError && <span className="bad">; последняя попытка не доставлена: {s.lastError}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
