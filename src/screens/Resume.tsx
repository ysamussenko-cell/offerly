import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, errorText, failedAnalysis, type Profile } from '../api';
import { yearsText } from '../text';
import { useHotkeys } from '../KeyHints';

const ACCEPT = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
const MIN_CHARS = 200;

type Phase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'analyzing' };

/** Загрузка резюме: файл или вставленный текст → профиль. Экран показывается, пока профиля нет или его меняют. */
export default function Resume({ profile, onProfile, onCancel }: { profile: Profile | null; onProfile: (p: Profile, notice?: string) => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = phase.kind !== 'idle';
  // Esc — оставить текущее резюме (когда экран открыт поверх готового профиля).
  useHotkeys({ cancel: Boolean(onCancel) && !busy, busy }, { onCancel: () => onCancel?.() });

  async function run(task: () => Promise<{ profile: Profile }>) {
    setError(null);
    try {
      const r = await task();
      onProfile(r.profile);
    } catch (e) {
      // Разбор не удался, но текст сохранён — показать профиль с кнопкой повтора; причина переходит на карточку.
      const failed = failedAnalysis(e);
      if (failed) onProfile(failed.profile, failed.notice);
      else setError(errorText(e));
    } finally { setPhase({ kind: 'idle' }); }
  }

  function sendFile(file: File | undefined) {
    if (!file) return;
    setPhase({ kind: 'reading' });
    run(async () => { setPhase({ kind: 'analyzing' }); return api.uploadResume(file); });
  }

  function submitText(e: FormEvent) {
    e.preventDefault();
    setPhase({ kind: 'analyzing' });
    run(() => api.pasteResume(text));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault(); setDragOver(false);
    sendFile(e.dataTransfer.files?.[0]);
  }

  const status = phase.kind === 'reading' ? 'Читаю файл…' : phase.kind === 'analyzing' ? 'Разбираю резюме — обычно десять-двадцать секунд…' : null;

  return (
    <section className="card">
      <h2>{profile ? 'Другое резюме' : 'Резюме'}</h2>
      <p className="muted">
        По резюме тренер поймёт вашу специальность, отрасль и словарь — все задания будут в вашем контексте.
        Файл не хранится: из него берётся только текст.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className={`tab ${mode === 'file' ? 'active' : ''}`} onClick={() => setMode('file')} disabled={busy}>Файл PDF или DOCX</button>
        <button type="button" className={`tab ${mode === 'text' ? 'active' : ''}`} onClick={() => setMode('text')} disabled={busy}>Вставить текст</button>
      </div>

      {mode === 'file' ? (
        <div
          className={`drop ${dragOver ? 'over' : ''}`}
          onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={busy ? undefined : onDrop}
        >
          <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={e => { sendFile(e.target.files?.[0]); e.target.value = ''; }} />
          <p style={{ margin: 0 }}>{status ?? 'Перетащите файл сюда или выберите на устройстве.'}</p>
          <p className="muted" style={{ margin: '6px 0 14px', fontSize: 14 }}>PDF, DOCX или TXT, до 8 МБ. Сканы без текстового слоя не читаются — для них вставьте текст.</p>
          <button className="btn" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Подождите…' : 'Выбрать файл'}</button>
        </div>
      ) : (
        <form onSubmit={submitText} className="stack">
          <label className="field">
            <span>Текст резюме — с hh.ru, LinkedIn или из документа</span>
            <textarea rows={12} value={text} onChange={e => setText(e.target.value)} disabled={busy}
              placeholder="Опыт работы, должности, обязанности, навыки, образование…" />
          </label>
          <div className="row">
            <button className="btn" type="submit" disabled={busy || text.trim().length < MIN_CHARS}>{busy ? 'Разбираю…' : 'Разобрать'}</button>
            <span className="muted" style={{ fontSize: 14 }}>
              {text.trim().length < MIN_CHARS ? `Ещё хотя бы ${MIN_CHARS - text.trim().length} знаков` : `${text.trim().length} знаков`}
            </span>
          </div>
          {status && <p className="muted" style={{ margin: 0 }}>{status}</p>}
        </form>
      )}

      {error && <p className="error" role="alert" style={{ marginTop: 12 }}>{error}</p>}
      {onCancel && <div style={{ marginTop: 12 }}><button className="link" type="button" disabled={busy} onClick={onCancel} aria-keyshortcuts="Escape">Оставить текущее резюме</button></div>}
    </section>
  );
}

/** Карточка профиля: что тренер понял из резюме. Пока анкета не заполнена — ведёт к ней. */
export function ProfileCard({ profile, notice, onReplace, onRetry, onNext }: { profile: Profile; notice?: string | null; onReplace: () => void; onRetry: () => Promise<void>; onNext?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = profile.resumeAt ? new Date(profile.resumeAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : null;

  async function retry() {
    setBusy(true); setError(null);
    try { await onRetry(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  // Причина неудачного разбора с экрана загрузки — пока профиль не собран и повтор не идёт.
  const shown = error ?? (busy || profile.analyzed ? null : notice ?? null);

  return (
    <section className="card">
      <h2>Что я понял из резюме</h2>
      {profile.analyzed ? (
        <>
          <dl className="facts">
            <div><dt>Специальность</dt><dd>{profile.specialty ?? '—'}</dd></div>
            <div><dt>Отрасль</dt><dd>{profile.industry ?? '—'}</dd></div>
            <div><dt>Стаж</dt><dd>{profile.years != null ? yearsText(profile.years) : 'не определён'}</dd></div>
            {profile.targetRole && <div><dt>Целевая позиция</dt><dd>{profile.targetRole}</dd></div>}
          </dl>
          {profile.summary && <p style={{ marginTop: 16 }}>{profile.summary}</p>}
          {profile.keywords.length > 0 && (
            <>
              <p className="muted" style={{ margin: '16px 0 8px', fontSize: 14 }}>Термины, на которых будут строиться задания</p>
              <ul className="chips">{profile.keywords.map(k => <li key={k} className="mono">{k}</li>)}</ul>
            </>
          )}
        </>
      ) : (
        <p className="muted">Текст резюме сохранён{when ? ` ${when}` : ''}, но профиль ещё не собран.</p>
      )}
      {shown && <p className="error" role="alert" style={{ marginTop: 12 }}>{shown}</p>}
      <div className="row" style={{ marginTop: 20 }}>
        {!profile.analyzed && <button className="btn" type="button" disabled={busy} onClick={retry}>{busy ? 'Разбираю…' : 'Разобрать снова'}</button>}
        {onNext && <button className="btn" type="button" disabled={busy} onClick={onNext}>Дальше — шесть вопросов</button>}
        <button className={profile.analyzed && !onNext ? 'btn secondary' : 'link'} type="button" disabled={busy} onClick={onReplace}>Загрузить другое резюме</button>
        <span className="muted" style={{ fontSize: 14 }}>
          {profile.resumeName && profile.resumeName !== 'текст' ? profile.resumeName : 'вставленный текст'}{when ? `, ${when}` : ''}
        </span>
      </div>
      {onNext && <p className="muted" style={{ marginTop: 16, fontSize: 14 }}>Дальше — короткая анкета: цель, дата и формат собеседования, нагрузка. Две минуты.</p>}
    </section>
  );
}
