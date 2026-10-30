import { useMemo, useState, type FormEvent } from 'react';
import { api, errorText, type Answers, type InterviewFormat, type Profile, type User } from '../api';
import { countdownText, FORMAT_LABELS, LANGUAGES, longDate, minutesText, timeZoneList, todayIn, tzLabel } from '../text';

const FORMATS: InterviewFormat[] = ['written', 'video', 'ai', 'unknown'];
const MINUTES = [10, 15, 20, 30, 45, 60];
const OTHER = '__other__';

const browserTz = (): string | null => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

/** Начальные ответы: из прежней анкеты, иначе из разбора резюме и браузера. */
export function initialAnswers(profile: Profile | null, user: User): Answers {
  const onboarded = Boolean(profile?.onboarded);
  return {
    targetRole: profile?.targetRole ?? '',
    interviewDate: profile?.interviewDate ?? null,
    interviewFormat: profile?.interviewFormat ?? 'unknown',
    minutesPerDay: profile?.minutesPerDay ?? 20,
    tz: onboarded ? user.tz : (browserTz() ?? user.tz),
    nativeLanguage: profile?.nativeLanguage ?? 'русский',
  };
}

type Props = { profile: Profile | null; user: User; onSaved: (p: Profile, u: User) => void; onCancel?: () => void };

/** Анкета знакомства: шесть вопросов на одном экране. */
export default function Questionnaire({ profile, user, onSaved, onCancel }: Props) {
  const [a, setA] = useState<Answers>(() => initialAnswers(profile, user));
  const [langChoice, setLangChoice] = useState<string>(() => LANGUAGES.includes(a.nativeLanguage) ? a.nativeLanguage : OTHER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneList(a.tz), []);
  const today = todayIn(a.tz);
  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setA(prev => ({ ...prev, [k]: v }));

  const canSubmit = a.targetRole.trim().length >= 2 && a.nativeLanguage.trim().length >= 2 && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.saveAnswers({ ...a, targetRole: a.targetRole.trim(), nativeLanguage: a.nativeLanguage.trim() });
      onSaved(r.profile, r.user);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2>{profile?.onboarded ? 'Анкета' : 'Шесть вопросов'}</h2>
      <p className="muted">
        По ответам тренер поставит цель, рассчитает срок и подберёт нагрузку. Всё можно изменить позже.
      </p>

      <form onSubmit={submit} className="stack questions">
        <label className="field q">
          <span><b className="qn">1</b>На какую позицию готовитесь</span>
          <input type="text" value={a.targetRole} onChange={e => set('targetRole', e.target.value)} maxLength={120} required autoFocus
            placeholder="например, эксперт по оценке ответов ИИ" disabled={busy} />
          {profile?.analyzed && profile.targetRole && !profile.onboarded && (
            <small className="muted">Подставлено из резюме — поправьте, если цель другая.</small>
          )}
        </label>

        <label className="field q">
          <span><b className="qn">2</b>Дата собеседования</span>
          <div className="row">
            <input type="date" value={a.interviewDate ?? ''} min={today} onChange={e => set('interviewDate', e.target.value || null)} disabled={busy} style={{ maxWidth: 220 }} />
            {a.interviewDate
              ? <span className="muted" style={{ fontSize: 14 }}>{countdownText(a.interviewDate, a.tz)}</span>
              : <span className="muted" style={{ fontSize: 14 }}>Если даты ещё нет, оставьте пустым — программа будет на четыре недели.</span>}
          </div>
        </label>

        <fieldset className="field q">
          <legend><b className="qn">3</b>Формат собеседования</legend>
          <div className="row" role="radiogroup">
            {FORMATS.map(f => (
              <button key={f} type="button" role="radio" aria-checked={a.interviewFormat === f} className={`tab ${a.interviewFormat === f ? 'active' : ''}`}
                onClick={() => set('interviewFormat', f)} disabled={busy}>{FORMAT_LABELS[f]}</button>
            ))}
          </div>
        </fieldset>

        <fieldset className="field q">
          <legend><b className="qn">4</b>Сколько минут в день готовы заниматься</legend>
          <div className="row" role="radiogroup">
            {MINUTES.map(m => (
              <button key={m} type="button" role="radio" aria-checked={a.minutesPerDay === m} className={`tab ${a.minutesPerDay === m ? 'active' : ''}`}
                onClick={() => set('minutesPerDay', m)} disabled={busy}>{m}</button>
            ))}
          </div>
          <small className="muted">Одно занятие — разминка, письмо или речь и повтор ошибок. Двадцать минут хватает на все три части.</small>
        </fieldset>

        <label className="field q">
          <span><b className="qn">5</b>Часовой пояс</span>
          <select value={a.tz} onChange={e => set('tz', e.target.value)} disabled={busy}>
            {zones.map(z => <option key={z} value={z}>{tzLabel(z)}</option>)}
          </select>
          <small className="muted">Нужен для напоминаний и для отсчёта дней до собеседования.</small>
        </label>

        <div className="field q">
          <span><b className="qn">6</b>Родной язык</span>
          <div className="row">
            <select value={langChoice} disabled={busy} style={{ maxWidth: 240 }}
              onChange={e => { const v = e.target.value; setLangChoice(v); set('nativeLanguage', v === OTHER ? '' : v); }}>
              {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
              <option value={OTHER}>другой</option>
            </select>
            {langChoice === OTHER && (
              <input type="text" value={a.nativeLanguage} onChange={e => set('nativeLanguage', e.target.value)} maxLength={40}
                placeholder="какой" disabled={busy} style={{ maxWidth: 220 }} />
            )}
          </div>
          <small className="muted">Тренер будет объяснять типичные ошибки носителей вашего языка.</small>
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="btn" type="submit" disabled={!canSubmit}>{busy ? 'Сохраняю…' : profile?.onboarded ? 'Сохранить' : 'Готово'}</button>
          {onCancel && <button className="link" type="button" disabled={busy} onClick={onCancel}>{profile?.onboarded ? 'Отмена' : 'Заполнить позже'}</button>}
        </div>
      </form>
    </section>
  );
}

/** Карточка ответов анкеты: цель, срок, формат, нагрузка. */
export function AnswersCard({ profile, user, onEdit }: { profile: Profile; user: User; onEdit: () => void }) {
  return (
    <section className="card">
      <h2>Подготовка</h2>
      <dl className="facts">
        <div><dt>Цель</dt><dd>{profile.targetRole ?? '—'}</dd></div>
        <div>
          <dt>Собеседование</dt>
          <dd>{profile.interviewDate ? longDate(profile.interviewDate) : 'дата не назначена'}</dd>
          {profile.interviewDate && <small className="muted">{countdownText(profile.interviewDate, user.tz)}</small>}
        </div>
        <div><dt>Формат</dt><dd>{FORMAT_LABELS[profile.interviewFormat ?? 'unknown']}</dd></div>
        <div><dt>В день</dt><dd>{profile.minutesPerDay != null ? minutesText(profile.minutesPerDay) : '—'}</dd></div>
        <div><dt>Часовой пояс</dt><dd style={{ fontSize: 16 }}>{tzLabel(user.tz)}</dd></div>
        <div><dt>Родной язык</dt><dd>{profile.nativeLanguage ?? '—'}</dd></div>
      </dl>
      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn secondary" type="button" onClick={onEdit}>Изменить ответы</button>
      </div>
      <p className="muted" style={{ marginTop: 16, fontSize: 14 }}>Следующий шаг — тест уровня по вашей специальности; появится в ближайших обновлениях.</p>
    </section>
  );
}
