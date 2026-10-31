import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText, type Settings as SettingsData } from '../api';
import { countsText, keyErrorText, keyPlaceholder, keyStatusText, notificationsText, validateKeyInput } from '../settings';

type Props = { onClose: () => void; refreshKey?: number };
type Note = { kind: 'ok' | 'bad'; text: string } | null;

/** Экран настроек (4.6): свой ключ провайдера модели, общее время уведомлений, экспорт данных.
 *  Ключ уходит на сервер один раз и хранится там зашифрованным; обратно приходят только провайдер, модель и последние четыре знака. */
export default function Settings({ onClose, refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; s: SettingsData | null; error: string | null }>({ loaded: false, s: null, error: null });

  useEffect(() => {
    api.settings().then(s => setState({ loaded: true, s, error: null })).catch(e => setState({ loaded: true, s: null, error: errorText(e) }));
  }, [refreshKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const got = (s: SettingsData) => setState({ loaded: true, s, error: null });
  const s = state.s;
  return (
    <div className="stack" style={{ marginTop: 0 }}>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Настройки</h2>
          <button className="link" type="button" onClick={onClose}>назад</button>
        </div>
        <p className="muted" style={{ fontSize: 14, margin: '8px 0 0' }}>Модель, время уведомлений и копия ваших данных. Часовой пояс, цель и дата собеседования — в анкете.</p>
        {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
        {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      </section>
      {s && <ProviderCard s={s} onChange={got} />}
      {s && <NotificationsCard s={s} onChange={got} />}
      {s && <DataCard s={s} />}
    </div>
  );
}

/** Карточка модели: встроенная по умолчанию, свой ключ — выбор провайдера, ключ, модель; проверка пробным вызовом; убрать. */
export function ProviderCard({ s, onChange }: { s: SettingsData; onChange: (s: SettingsData) => void }) {
  const p = s.provider;
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(p.key?.provider ?? p.providers[0]?.id ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(p.key?.custom ? p.key.model ?? '' : '');
  const [busy, setBusy] = useState<'save' | 'check' | 'delete' | null>(null);
  const [note, setNote] = useState<Note>(null);
  const chosen = p.providers.find(x => x.id === provider);
  const clientError = open && apiKey ? validateKeyInput(chosen, apiKey, model) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const bad = validateKeyInput(chosen, apiKey, model);
    if (bad) { setNote({ kind: 'bad', text: bad }); return; }
    setBusy('save'); setNote(null);
    try {
      const r = await api.saveKey(provider, apiKey.trim(), model.trim());
      onChange(r); setApiKey(''); setOpen(false);
      setNote({ kind: 'ok', text: `Ключ ${r.provider.key?.short} сохранён (${r.provider.key?.hint}). Нажмите «Проверить» — один короткий запрос покажет, что ключ и модель работают.` });
    } catch (err) { setNote({ kind: 'bad', text: keyErrorText(err) }); }
    finally { setBusy(null); }
  }
  async function check() {
    setBusy('check'); setNote(null);
    try {
      const r = await api.checkKey();
      onChange(r);
      setNote({ kind: 'ok', text: `Провайдер ответил: «${r.reply}». Ключ работает — задания и проверка пойдут через ${r.provider.key?.short}.` });
    } catch (err) {
      setNote({ kind: 'bad', text: keyErrorText(err) });
      api.settings().then(onChange).catch(() => {});
    } finally { setBusy(null); }
  }
  async function remove() {
    setBusy('delete'); setNote(null);
    try {
      const r = await api.deleteKey();
      onChange(r); setModel(''); setApiKey('');
      setNote({ kind: 'ok', text: 'Ключ удалён. Работает встроенная модель.' });
    } catch (err) { setNote({ kind: 'bad', text: keyErrorText(err) }); }
    finally { setBusy(null); }
  }

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Модель</h2>
        <span className="muted" style={{ fontSize: 14 }}>{p.key ? (p.key.readable ? `свой ключ · ${p.key.short}` : 'ключ не читается') : 'встроенная'}</span>
      </div>
      <p style={{ margin: '12px 0 0' }}>{keyStatusText(p)}</p>
      <p className="muted" style={{ fontSize: 14, margin: '4px 0 0' }}>
        Свой ключ даёт более сильную модель и свои расходы; встроенная работает бесплатно. Ключ хранится на сервере только зашифрованным
        {p.keySource === 'db' ? ' (мастер-ключ создан сервером; секрет KEYS_SECRET в проекте надёжнее)' : ' (мастер-ключ — секрет проекта)'} и обратно не показывается.
        Если провайдер не ответит, задание выполнит встроенная модель.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        {!open && <button className="btn" type="button" disabled={busy != null} onClick={() => setOpen(true)}>{p.key ? 'Заменить ключ' : 'Подключить свой ключ'}</button>}
        {p.key && p.key.readable && <button className="btn secondary" type="button" disabled={busy != null} onClick={check}>{busy === 'check' ? 'Проверяю…' : 'Проверить'}</button>}
        {p.key && <button className="link" type="button" disabled={busy != null} onClick={remove}>{busy === 'delete' ? 'убираю…' : 'убрать ключ'}</button>}
      </div>
      {open && (
        <form className="stack" onSubmit={save} style={{ marginTop: 12, gap: 12 }}>
          <label className="field">
            <span>Провайдер</span>
            <select value={provider} onChange={e => { setProvider(e.target.value); setModel(''); }}>
              {p.providers.map(x => <option key={x.id} value={x.id}>{x.name}{x.free ? '' : ' — платный'}</option>)}
            </select>
            {chosen?.keyUrl && <small><a className="link" href={chosen.keyUrl} target="_blank" rel="noreferrer">Где взять ключ {chosen.short}</a></small>}
          </label>
          <label className="field">
            <span>Ключ</span>
            <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={keyPlaceholder(chosen?.prefix ?? null)} required className="mono" />
            {clientError && <small className="bad">{clientError}</small>}
          </label>
          <label className="field">
            <span>Модель <span className="muted">— необязательно</span></span>
            <input type="text" autoComplete="off" spellCheck={false} value={model} onChange={e => setModel(e.target.value)} placeholder={chosen ? `по умолчанию ${chosen.defaultModel}` : ''} className="mono" />
          </label>
          <div className="row">
            <button className="btn" type="submit" disabled={busy != null || !apiKey || clientError != null}>{busy === 'save' ? 'Сохраняю…' : 'Сохранить ключ'}</button>
            <button className="link" type="button" disabled={busy != null} onClick={() => { setOpen(false); setApiKey(''); setNote(null); }}>отмена</button>
          </div>
        </form>
      )}
      {note && <p className={note.kind === 'ok' ? 'hint ok' : 'error'} role="status" style={{ marginTop: 12 }}>{note.text}</p>}
    </section>
  );
}

/** Карточка уведомлений: одно время на письмо и напоминание, каждый канал — галочкой. Подробности и «прислать сейчас» — в своих карточках на главном. */
export function NotificationsCard({ s, onChange }: { s: SettingsData; onChange: (s: SettingsData) => void }) {
  const n = s.notifications;
  const [at, setAt] = useState(n.mail.at ?? n.push.at ?? n.defaultAt);
  const [mail, setMail] = useState(n.mail.enabled);
  const [push, setPush] = useState(n.push.enabled);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const dirty = at !== (n.mail.at ?? n.push.at ?? n.defaultAt) || mail !== n.mail.enabled || push !== n.push.enabled;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setNote(null);
    try {
      const r = await api.saveNotifications(at, mail, push);
      onChange(r);
      setNote({ kind: 'ok', text: notificationsText(r.notifications) });
    } catch (err) { setNote({ kind: 'bad', text: errorText(err) }); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Уведомления</h2>
        <span className="muted" style={{ fontSize: 14 }}>{n.mail.enabled || n.push.enabled ? `в ${n.mail.at ?? n.push.at}${n.mail.enabled && n.push.enabled && n.mail.at !== n.push.at ? ` и ${n.push.at}` : ''}` : 'выключены'}</span>
      </div>
      <p style={{ margin: '12px 0 0' }}>{notificationsText(n)}</p>
      <form className="stack" onSubmit={save} style={{ marginTop: 12, gap: 10 }}>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <span>Время</span>
          <input type="time" value={at} onChange={e => setAt(e.target.value)} required={mail || push} style={{ width: 130 }} />
          <span className="muted" style={{ fontSize: 13 }}>{n.tz}</span>
        </label>
        <label className="row" style={{ gap: 8, fontSize: 15 }}>
          <input type="checkbox" checked={mail} onChange={e => setMail(e.target.checked)} />
          <span>Письмо на почту{!n.mail.configured && <span className="bad"> — почта на сервере не настроена, письма не уйдут</span>}</span>
        </label>
        <label className="row" style={{ gap: 8, fontSize: 15 }}>
          <input type="checkbox" checked={push} disabled={n.push.devices === 0} onChange={e => setPush(e.target.checked)} />
          <span>Напоминание на устройствах{n.push.devices > 0 ? ` (${n.push.devices})` : <span className="muted"> — подключите устройство в карточке «Напоминание» на главном</span>}</span>
        </label>
        <div className="row">
          <button className="btn" type="submit" disabled={busy || !dirty || ((mail || push) && !at)}>{busy ? 'Сохраняю…' : dirty ? 'Сохранить' : 'Сохранено'}</button>
        </div>
      </form>
      {note && <p className={note.kind === 'ok' ? 'hint ok' : 'error'} role="status" style={{ marginTop: 12 }}>{note.text}</p>}
    </section>
  );
}

/** Карточка данных: что накопилось и ссылка на JSON-файл со всем, кроме ключа и адресов push-подписок. */
export function DataCard({ s }: { s: SettingsData }) {
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Данные</h2>
        <span className="muted mono" style={{ fontSize: 14 }}>{s.data.file}</span>
      </div>
      <p style={{ margin: '12px 0 0' }}>Накоплено: {countsText(s.data.counts)}.</p>
      <p className="muted" style={{ fontSize: 14, margin: '4px 0 0' }}>
        Один JSON-файл: профиль и анкета, тесты и срезы с ответами, карточки ошибок, программа, занятия по шагам, репетиции с разбором, достижения, записи речи (текст и мерки, без звука).
        Без ключа провайдера и адресов push-подписок.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <a className="btn" href={api.exportUrl} download={s.data.file}>Скачать копию данных</a>
      </div>
    </section>
  );
}
