import { useEffect, useState } from 'react';
import { api, errorText, type Digest } from '../api';
import { longDate, tzLabel } from '../text';

type Props = { refreshKey?: number };

/** Строка состояния письма: что было сегодня и когда следующее. */
export function digestStatusText(d: Digest): string {
  if (!d.enabled) return 'Выключено. Включите — и каждое утро в почте будет задание дня и прогресс.';
  const next = d.next ? `следующее ${d.next.date === d.today ? 'сегодня' : longDate(d.next.date)} в ${d.next.time}` : '';
  if (d.state === 'sent') {
    if (d.note === 'skipped:enabled_after') return `Письмо включено, когда сегодняшнее время уже прошло; первое — ${next.replace(/^следующее /, '')}.`;
    if (d.note === 'skipped:late') return `Сегодня окно отправки прошло; ${next}.`;
    if (d.note === 'skipped:mail_not_configured') return `Сегодня письмо не ушло — почта на сервере не настроена; ${next}.`;
    if (d.note?.startsWith('error:')) return `Сегодня отправить не удалось (${d.note.slice(6)}); ${next}.`;
    return `Сегодняшнее письмо отправлено; ${next}.`;
  }
  if (d.state === 'early') return `Сегодня ещё не отправлялось; ${next} (придёт в течение ${d.stepMinutes} минут после назначенного времени).`;
  if (d.state === 'due') return `Время наступило — письмо уйдёт в ближайшие ${d.stepMinutes} минут.`;
  return `Сегодня окно отправки прошло (${d.windowMinutes / 60} часа после назначенного времени); ${next}.`;
}

/** Карточка «Ежедневное письмо»: время в поясе ученика, включить/выключить, предпросмотр сегодняшнего текста
 *  и кнопка «Прислать сейчас». Письмо — одно в день, задание дня и прогресс; расписание держит отдельный Worker. */
export function DigestCard({ refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; d: Digest | null; error: string | null }>({ loaded: false, d: null, error: null });
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    api.digest().then(d => { setState({ loaded: true, d, error: null }); setTime(d.notifyAt ?? d.defaultAt); })
      .catch(e => setState({ loaded: true, d: null, error: errorText(e) }));
  }, [refreshKey]);

  async function save(notifyAt: string | null) {
    setBusy('save'); setNote(null);
    try {
      const d = await api.saveDigest(notifyAt);
      setState({ loaded: true, d: { ...d, preview: state.d?.preview }, error: null });
      setTime(d.notifyAt ?? d.defaultAt);
      setNote({ kind: 'ok', text: d.enabled ? `Письмо будет приходить в ${d.notifyAt} (${tzLabel(d.tz)}).` : 'Письмо выключено.' });
    } catch (e) { setNote({ kind: 'bad', text: errorText(e) }); }
    finally { setBusy(null); }
  }

  async function sendNow() {
    setBusy('send'); setNote(null);
    try {
      const r = await api.sendDigest();
      setNote({ kind: 'ok', text: `Отправлено: «${r.subject}». Проверьте почту — письмо приходит в течение минуты.` });
      api.digest().then(d => setState({ loaded: true, d, error: null })).catch(() => {});
    } catch (e) { setNote({ kind: 'bad', text: errorText(e) }); }
    finally { setBusy(null); }
  }

  const d = state.d;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Ежедневное письмо</h2>
        {d && <span className="muted" style={{ fontSize: 14 }}>{d.enabled ? `в ${d.notifyAt}` : 'выключено'}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {d && (
        <>
          <p style={{ margin: '12px 0 0' }}>{digestStatusText(d)}</p>
          <p className="muted" style={{ fontSize: 14, margin: '4px 0 0' }}>
            Одно письмо в день: задание дня по программе, карточки к повтору, готовность, серия и минуты недели. Пояс — {tzLabel(d.tz)}, сейчас там {d.localTime}; пояс меняется в анкете.
            {d.mail === 'missing' && <> <span className="bad">Почта на сервере не настроена — письма не уйдут, пока не задан ключ RESEND_API_KEY.</span></>}
          </p>
          <form className="row goal-form" onSubmit={e => { e.preventDefault(); save(time); }} style={{ marginTop: 12 }}>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <span>Время</span>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} required style={{ width: 130 }} />
            </label>
            <button className="btn" type="submit" disabled={busy != null || !time || (d.enabled && time === d.notifyAt)}>{busy === 'save' ? 'Сохраняю…' : d.enabled && time === d.notifyAt ? 'Сохранено' : d.enabled ? 'Переставить' : 'Включить'}</button>
            {d.enabled && <button className="link" type="button" disabled={busy != null} onClick={() => save(null)}>выключить</button>}
            <button className="link" type="button" disabled={busy != null} onClick={sendNow}>{busy === 'send' ? 'отправляю…' : 'прислать сейчас'}</button>
          </form>
          {note && <p className={note.kind === 'ok' ? 'hint ok' : 'error'} role="status">{note.text}</p>}
          {d.preview && (
            <div style={{ marginTop: 12 }}>
              <button className="link" type="button" onClick={() => setPreview(v => !v)}>{preview ? 'Скрыть сегодняшний текст' : `Показать сегодняшний текст: «${d.preview.subject}»`}</button>
              {preview && <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, margin: '10px 0 0', padding: 14, border: '1px solid var(--line)', borderRadius: 12 }}>{d.preview.text}</pre>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
