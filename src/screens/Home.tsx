import { useEffect, useState } from 'react';
import { api, errorText, type Dashboard, type WeekDay } from '../api';
import { daysText, longDate, minutesText, plural } from '../text';

type Props = { refreshKey?: number; onOpenLesson?: () => void };

const KIND_LABELS: Record<string, string> = { placement: 'тест уровня', checkpoint: 'контрольный срез', baseline: 'исходный срез' };
const pointsText = (n: number) => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;
const lessonsText = (n: number) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const missesText = (n: number) => `${n} ${plural(n, 'пропуск', 'пропуска', 'пропусков')}`;
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
};
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`).replace('.', ',');

/** Подпись статуса дня недели в плане. */
export const WEEK_STATUS_LABELS: Record<WeekDay['status'], string> = {
  done: 'пройдено', active: 'идёт', today: 'сегодня', planned: 'план', missed: 'пропущено', frozen: 'заморозка', unavailable: 'позже', free: 'свободно',
};

/** «через 20 дней», «сегодня», «завтра», «дата прошла» по числу дней. */
export function countdownByDays(d: number): string {
  if (d < 0) return 'дата прошла';
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  return `через ${daysText(d)}`;
}

/** Строка прогноза: «при текущем темпе B2 через 2 дня», «темп нулевой — ступень не приближается», «верхняя ступень». */
export function forecastText(f: Dashboard['readiness']['forecast']): string {
  if (!f.next) return 'Верхняя ступень взята.';
  const need = `До ${f.next.level} — ${pointsText(f.next.points)}`;
  if (f.next.days == null) return `${need}; за последнюю неделю готовность не росла — ступень не приближается.`;
  return `${need}; при текущем темпе (${signed(f.perDay)} в день) — через ${daysText(f.next.days)}.`;
}

/** Карточка главного экрана: готовность 0–100 с разбором и прогнозом, обратный отсчёт до собеседования,
 *  серия дней с заморозкой, недельная цель в минутах (своя или по анкете) и план текущей недели. */
export function HomeCard({ refreshKey, onOpenLesson }: Props) {
  const [state, setState] = useState<{ loaded: boolean; d: Dashboard | null; error: string | null }>({ loaded: false, d: null, error: null });
  const [edit, setEdit] = useState<{ on: boolean; value: string; busy: boolean; error: string | null }>({ on: false, value: '', busy: false, error: null });

  useEffect(() => {
    api.dashboard().then(d => setState({ loaded: true, d, error: null })).catch(e => setState({ loaded: true, d: null, error: errorText(e) }));
  }, [refreshKey]);

  async function saveGoal(minutes: number | null) {
    setEdit(s => ({ ...s, busy: true, error: null }));
    try { const d = await api.saveGoal(minutes); setState({ loaded: true, d, error: null }); setEdit({ on: false, value: '', busy: false, error: null }); }
    catch (e) { setEdit(s => ({ ...s, busy: false, error: errorText(e) })); }
  }

  const d = state.d;
  const r = d?.readiness;
  const f = r?.forecast;
  const todayCell = d?.week.find(w => w.today);

  return (
    <section className="card home">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Готовность к собеседованию</h2>
        {d && <span className="muted" style={{ fontSize: 14 }}>{longDate(d.today)}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Считаю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {d && r && f && (
        <>
          <div className="level-row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
            <span className="level-badge readiness" aria-label={r.value == null ? 'Готовность не посчитана' : `Готовность ${r.value} из 100`}>{r.value ?? '—'}</span>
            <div style={{ flex: 1, minWidth: 200 }}>
              {r.value == null ? (
                <p style={{ margin: 0 }}>Готовность появится после теста уровня: пять осей дают базу, занятия её поднимают, пропуски понемногу снижают. Карточка «Тест уровня» ниже.</p>
              ) : (
                <>
                  <p style={{ margin: 0, fontWeight: 600 }}>из 100 · уровень {r.level}{f.target.reached ? ` · целевой ${f.target.level} взят` : ` · цель ${f.target.level} — от ${f.target.points} баллов`}</p>
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 14 }}>{forecastText(f)}</p>
                </>
              )}
            </div>
          </div>
          {r.value != null && (
            <>
              <div className="progress target" aria-hidden="true" style={{ margin: '12px 0 8px' }}>
                <span style={{ width: `${r.value}%` }} />
                <i style={{ left: `${f.target.points}%` }} title={`Цель ${f.target.level}`} />
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                База {r.base} — {KIND_LABELS[r.baseKind ?? ''] ?? r.baseKind} {r.baseDate ? shortDate(r.baseDate) : ''}
                {r.lessons > 0 && <> · занятия {signed(r.gained)} ({lessonsText(r.lessons)}{r.bonuses > 0 ? `, ${r.bonuses === 1 ? 'один бонус' : `бонусов ${r.bonuses}`} ×${d.bonusMultiplier}` : ''})</>}
                {r.missed > 0 && <> · пропуски {signed(-r.lost)} ({missesText(r.missed)}{r.lost >= d.missCap ? ', дальше не снижается' : ''})</>}
                {r.lessons === 0 && r.missed === 0 && <> · занятий после него ещё не было</>}
                {f.atInterview != null && d.countdown.daysLeft != null && d.countdown.daysLeft > 0 && <> · к собеседованию при этом темпе — {f.atInterview}</>}
              </p>
            </>
          )}

          <dl className="facts home-facts">
            <div>
              <dt>Собеседование</dt>
              {d.countdown.daysLeft == null ? (
                <dd className="muted" style={{ fontWeight: 500, fontSize: 15 }}>дата не задана — укажите в анкете</dd>
              ) : (
                <>
                  <dd>{countdownByDays(d.countdown.daysLeft)}</dd>
                  <small className="muted">{longDate(d.countdown.interviewDate!)}</small>
                </>
              )}
            </div>
            <div>
              <dt>Серия</dt>
              <dd className={d.streak.current > 0 ? 'streak on' : 'streak'}>{daysText(d.streak.current)}</dd>
              <small className="muted">
                {d.streak.todayDone ? 'сегодня засчитано' : d.streak.current > 0 ? 'сегодня ещё не пройдено' : d.streak.lastDone ? `последнее занятие ${shortDate(d.streak.lastDone)}` : 'занятий ещё не было'}
                {d.streak.best > d.streak.current ? ` · лучшая ${d.streak.best}` : ''}
                {' · '}{d.streak.freezeAvailable ? 'заморозка на эту неделю есть' : 'заморозка недели потрачена'}
              </small>
            </div>
            <div>
              <dt>Недельная цель</dt>
              <dd>{d.goal.done} из {d.goal.minutes} мин</dd>
              <div className="progress" style={{ margin: '4px 0 2px' }} aria-label={`Выполнено ${d.goal.percent}%`}><span style={{ width: `${d.goal.percent}%` }} /></div>
              <small className="muted">
                {d.goal.left > 0 ? `осталось ${minutesText(d.goal.left)}` : 'цель недели выполнена'}
                {' · '}{d.goal.custom ? 'своя' : `по анкете: ${d.goal.minutes / d.goalDays} мин × ${d.goalDays} дней`}
                {' · '}<button className="link" type="button" onClick={() => setEdit({ on: !edit.on, value: String(d.goal.minutes), busy: false, error: null })}>{edit.on ? 'отмена' : 'изменить'}</button>
              </small>
            </div>
          </dl>
          {edit.on && (
            <form className="row goal-form" onSubmit={e => { e.preventDefault(); saveGoal(Number(edit.value)); }}>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <span>Минут в неделю</span>
                <input type="number" inputMode="numeric" min={d.goalMin} max={d.goalMax} step={5} value={edit.value} onChange={e => setEdit(s => ({ ...s, value: e.target.value }))} style={{ width: 110 }} autoFocus />
              </label>
              <button className="btn" type="submit" disabled={edit.busy}>{edit.busy ? 'Сохраняю…' : 'Сохранить'}</button>
              {d.goal.custom && <button className="link" type="button" disabled={edit.busy} onClick={() => saveGoal(null)}>вернуть по анкете ({d.goal.default} мин)</button>}
              {edit.error && <p className="error" role="alert" style={{ width: '100%' }}>{edit.error}</p>}
            </form>
          )}

          <h3 className="result-h" style={{ marginTop: 20 }}>План недели</h3>
          <ol className="week-strip" aria-label="План недели">
            {d.week.map(w => (
              <li key={w.date} className={`wd ${w.status}${w.today ? ' is-today' : ''}`}>
                <div className="wd-date"><b>{w.weekday}</b><span>{shortDate(w.date)}</span></div>
                <div className="wd-body">
                  <span className="wd-title">{w.day ? (w.day.format === 'lesson' ? w.day.topicLabel : w.day.formatLabel) : '—'}</span>
                  <span className="wd-status">
                    {WEEK_STATUS_LABELS[w.status]}
                    {w.status === 'done' && w.score != null ? ` · ${w.score}` : ''}
                    {w.minutes > 0 ? ` · ${w.minutes} мин` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {!d.program.exists && <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>Программы ещё нет — план недели заполнится после «Составить программу» в карточке «Программа».</p>}
          {d.program.exists && todayCell && (todayCell.status === 'today' || todayCell.status === 'active') && onOpenLesson && (
            <p style={{ margin: '10px 0 0' }}><button className="btn" type="button" onClick={onOpenLesson}>{todayCell.status === 'active' ? 'Продолжить занятие' : 'Начать занятие'}</button></p>
          )}
          <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>
            Готовность растёт до {d.gainPerLesson} за занятие (по баллу; верно решённый бонус умножает вклад занятия на {d.bonusMultiplier}) и снижается на {d.missPenalty} за пропущенное занятие программы, не больше {d.missCap} в сумме.
            Серия — дни подряд с занятием; одна дыра в неделю закрывается заморозкой сама. Репетиции и срезы до их появления серию не трогают.
          </p>
        </>
      )}
    </section>
  );
}
