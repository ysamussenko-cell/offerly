import { useEffect, useState } from 'react';
import { api, errorText, type Dashboard, type DayFormat, type WeekDay } from '../api';
import { daysText, longDate, minutesText } from '../text';

type Props = { refreshKey?: number; /** Открыть сегодняшний день программы по его формату: занятие, репетиция или срез. */ onOpenDay?: (format: DayFormat) => void };

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Статус дня недели — только для подсказки и экранного чтеца; на полосе подписей нет. */
export const WEEK_STATUS_LABELS: Record<WeekDay['status'], string> = {
  done: 'пройдено', active: 'идёт', today: 'сегодня', planned: 'план', missed: 'пропущено', frozen: 'заморозка', unavailable: 'позже', free: 'свободно',
};

/** Кнопка сегодняшнего дня по формату. */
export function todayButtonText(format: DayFormat, active: boolean): string {
  if (format === 'rehearsal') return active ? 'Продолжить репетицию' : 'Начать репетицию';
  if (format === 'checkpoint') return active ? 'Продолжить срез' : 'Начать срез';
  return active ? 'Продолжить занятие' : 'Начать занятие';
}

/** «через 20 дней», «сегодня», «завтра», «дата прошла» по числу дней. */
export function countdownByDays(d: number): string {
  if (d < 0) return 'дата прошла';
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  return `через ${daysText(d)}`;
}

/** Что показать в «Сегодня»: одна строка о дне и одно действие (или ничего). */
export type TodayView = { title: string; action: { format: DayFormat; label: string; primary: boolean } | null };

export function todayView(d: Pick<Dashboard, 'program' | 'week'>): TodayView {
  if (!d.program.exists) return { title: 'Программы ещё нет — составьте её в карточке «Программа».', action: null };
  const w = d.week.find(x => x.today);
  const day = w?.day;
  if (!w || !day) return { title: 'По программе сегодня свободно.', action: null };
  const name = day.format === 'lesson' ? day.topicLabel : cap(day.formatLabel);
  if (w.status === 'done') {
    return {
      title: `${name} — пройдено${w.score != null ? ` · ${w.score}` : ''}`,
      action: day.format === 'lesson' ? { format: 'lesson', label: 'Открыть разбор', primary: false } : null,
    };
  }
  const active = w.status === 'active';
  return { title: `${name}${day.minutes ? ` · ${minutesText(day.minutes)}` : ''}`, action: { format: day.format, label: todayButtonText(day.format, active), primary: true } };
}

/** Подпись отметки дня для подсказки: «чт 12 нояб — Союзы и инверсия, пройдено». */
export function weekMarkLabel(w: WeekDay): string {
  const what = w.day ? (w.day.format === 'lesson' ? w.day.topicLabel : w.day.formatLabel) : null;
  return `${w.weekday} ${shortDate(w.date)}${what ? ` — ${what}, ${WEEK_STATUS_LABELS[w.status]}` : ''}`;
}

/** Главная карточка «Сегодня» (7.1): день программы и одна кнопка; рядом готовность числом и срок до собеседования;
 *  неделя — семь отметок без подписей. Разбор готовности, серия и цель минут — не здесь. */
export function HomeCard({ refreshKey, onOpenDay }: Props) {
  const [state, setState] = useState<{ loaded: boolean; d: Dashboard | null; error: string | null }>({ loaded: false, d: null, error: null });

  useEffect(() => {
    api.dashboard().then(d => setState({ loaded: true, d, error: null })).catch(e => setState({ loaded: true, d: null, error: errorText(e) }));
  }, [refreshKey]);

  const d = state.d;
  const v = d ? todayView(d) : null;
  const value = d?.readiness.value ?? null;
  const days = d?.countdown.daysLeft ?? null;

  return (
    <section className="card home">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Сегодня</h2>
        {d && <span className="muted" style={{ fontSize: 14 }}>{longDate(d.today)}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {d && v && (
        <>
          <p className="today-title">{v.title}</p>
          {v.action && onOpenDay && (
            <button className={v.action.primary ? 'btn today-btn' : 'btn secondary today-btn'} type="button" onClick={() => onOpenDay(v.action!.format)}>{v.action.label}</button>
          )}

          <div className="home-facts">
            <div>
              <span className="level-badge readiness" aria-label={value == null ? 'Готовность не посчитана' : `Готовность ${value} из 100`}>{value ?? '—'}</span>
              <small className="muted">{value == null ? 'готовность — после теста уровня' : 'готовность из 100'}</small>
            </div>
            <div className="countdown">
              <b>{days == null ? '—' : countdownByDays(days)}</b>
              <small className="muted">{days == null ? 'дата собеседования не задана' : `собеседование · ${shortDate(d.countdown.interviewDate!)}`}</small>
            </div>
          </div>

          <ol className="week-marks" aria-label="Неделя">
            {d.week.map(w => (
              <li key={w.date} className={`wm ${w.status}${w.today ? ' is-today' : ''}`} title={weekMarkLabel(w)} aria-label={weekMarkLabel(w)}>
                <span aria-hidden="true">{w.weekday}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** Недельная цель в минутах (перенесена с главного в «Настройки» в 7.1): по анкете или своя. */
export function GoalCard() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ on: boolean; value: string; busy: boolean }>({ on: false, value: '', busy: false });

  useEffect(() => { api.dashboard().then(setD).catch(e => setError(errorText(e))); }, []);

  async function save(minutes: number | null) {
    setEdit(s => ({ ...s, busy: true })); setError(null);
    try { setD(await api.saveGoal(minutes)); setEdit({ on: false, value: '', busy: false }); }
    catch (e) { setEdit(s => ({ ...s, busy: false })); setError(errorText(e)); }
  }

  return (
    <section className="card goal">
      <h3>Недельная цель</h3>
      {d && (
        <p style={{ margin: 0 }}>
          {d.goal.minutes} мин в неделю · {d.goal.custom ? 'своя' : `по анкете: ${d.goal.minutes / d.goalDays} мин × ${d.goalDays} дней`}
          {' · '}<button className="link" type="button" onClick={() => setEdit({ on: !edit.on, value: String(d.goal.minutes), busy: false })}>{edit.on ? 'отмена' : 'изменить'}</button>
        </p>
      )}
      {d && edit.on && (
        <form className="row goal-form" onSubmit={e => { e.preventDefault(); save(Number(edit.value)); }}>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <span>Минут в неделю</span>
            <input type="number" inputMode="numeric" min={d.goalMin} max={d.goalMax} step={5} value={edit.value} onChange={e => setEdit(s => ({ ...s, value: e.target.value }))} style={{ width: 110 }} autoFocus />
          </label>
          <button className="btn" type="submit" disabled={edit.busy}>{edit.busy ? 'Сохраняю…' : 'Сохранить'}</button>
          {d.goal.custom && <button className="link" type="button" disabled={edit.busy} onClick={() => save(null)}>вернуть по анкете ({d.goal.default} мин)</button>}
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
