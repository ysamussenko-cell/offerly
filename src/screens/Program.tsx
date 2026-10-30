import { useEffect, useState } from 'react';
import { api, errorText, type Program, type ProgramDay } from '../api';
import { daysText, longDate, plural } from '../text';

type Props = { refreshKey?: number; interviewDate?: string | null };

const lessonsText = (n: number) => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;
const rehearsalsText = (n: number) => `${n} ${plural(n, 'репетиция', 'репетиции', 'репетиций')}`;
const checkpointsText = (n: number) => `${n} ${plural(n, 'срез', 'среза', 'срезов')}`;
/** «2 ноя» — короткая дата в строке дня. */
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
};

/** Карточка «Программа» на главном экране: план на четыре недели целиком, по неделям — день, формат, тема,
 *  формат письма и причина выбора темы. Темы занятий можно менять местами; пересборка сохраняет пройденные дни. */
export function ProgramCard({ refreshKey, interviewDate }: Props) {
  const [state, setState] = useState<{ loaded: boolean; program: Program | null; error: string | null }>({ loaded: false, program: null, error: null });
  const [busy, setBusy] = useState(false);
  const [swap, setSwap] = useState<{ on: boolean; first: string | null }>({ on: false, first: null });
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    api.program().then(r => setState({ loaded: true, program: r.program, error: null })).catch(e => setState({ loaded: true, program: null, error: errorText(e) }));
  }, [refreshKey, interviewDate]);

  async function generate() {
    setBusy(true); setState(s => ({ ...s, error: null }));
    try { const r = await api.generateProgram(); setState({ loaded: true, program: r.program, error: null }); setSwap({ on: false, first: null }); }
    catch (e) { setState(s => ({ ...s, error: errorText(e) })); } finally { setBusy(false); }
  }

  async function pick(d: ProgramDay) {
    if (!swap.on || d.format !== 'lesson' || d.status !== 'planned' || d.past) return;
    if (!swap.first) { setSwap({ on: true, first: d.id }); return; }
    if (swap.first === d.id) { setSwap({ on: true, first: null }); return; }
    setBusy(true); setState(s => ({ ...s, error: null }));
    try { const r = await api.swapProgramDays(swap.first, d.id); setState({ loaded: true, program: r.program, error: null }); setSwap({ on: true, first: null }); }
    catch (e) { setState(s => ({ ...s, error: errorText(e) })); setSwap({ on: true, first: null }); } finally { setBusy(false); }
  }

  const p = state.program;
  const weeks = p ? [...new Set(p.days.map(d => d.week))] : [];
  const currentWeek = p?.days.find(d => d.today)?.week ?? p?.days.find(d => !d.past)?.week ?? weeks[0];
  const isOpen = (w: number) => open.has(w) || w === currentWeek;
  const toggle = (w: number) => setOpen(s => { const n = new Set(s); if (n.has(w)) n.delete(w); else n.add(w); return n; });

  return (
    <section className="card">
      <h2>Программа</h2>
      {!state.loaded && <p className="muted">Смотрю…</p>}
      {state.loaded && !p && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            План на четыре недели по вашим ошибкам и дате собеседования: одна слабая тема в день, письмо по очереди в двух форматах
            (отзыв рецензента и объяснение неспециалисту), по воскресеньям репетиция интервью, по субботам смешанное повторение,
            раз в две недели контрольный срез. План виден целиком, темы можно переставлять.
          </p>
          <button className="btn" type="button" onClick={generate} disabled={busy}>{busy ? 'Составляю…' : 'Составить программу'}</button>
        </>
      )}
      {state.loaded && p && (
        <>
          <p style={{ marginTop: 0 }}>
            {longDate(p.startDate)} — {longDate(p.endDate)} · {daysText(p.totalDays)}
            <span className="muted"> · {lessonsText(p.counts.lessons)}, {rehearsalsText(p.counts.rehearsals)}, {checkpointsText(p.counts.checkpoints)}{p.counts.done ? `, пройдено ${p.counts.done}` : ''}</span>
          </p>
          {p.interviewDate && <p className="muted" style={{ marginTop: -8, fontSize: 14 }}>Собеседование {longDate(p.interviewDate)} — программа заканчивается накануне.</p>}
          <ul className="chips" style={{ marginBottom: 12 }}>
            {p.topics.map(t => <li key={t.id}>{t.label}{t.days > 1 ? ` · ${t.days}` : ''}</li>)}
          </ul>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={`btn secondary${swap.on ? ' active' : ''}`} type="button" onClick={() => setSwap(s => ({ on: !s.on, first: null }))} disabled={busy}>
              {swap.on ? 'Готово' : 'Переставить темы'}
            </button>
            <button className="link" type="button" onClick={generate} disabled={busy}>{busy ? 'Пересобираю…' : 'Пересобрать по свежим ошибкам'}</button>
          </div>
          {swap.on && <p className="hint warn" style={{ margin: '0 0 12px' }}>{swap.first ? 'Теперь выберите второе занятие — темы поменяются местами.' : 'Выберите два занятия, чтобы поменять их темы местами. Репетиции, срезы и пройденные дни не двигаются.'}</p>}
          <div className="weeks">
            {weeks.map(w => {
              const days = p.days.filter(d => d.week === w);
              return (
                <div key={w} className={`week${w === currentWeek ? ' current' : ''}`}>
                  <button className="week-h" type="button" onClick={() => toggle(w)} aria-expanded={isOpen(w)}>
                    <b>Неделя {w}</b>
                    <span className="muted">{shortDate(days[0].date)} — {shortDate(days[days.length - 1].date)}{w === currentWeek ? ' · текущая' : ''}</span>
                  </button>
                  {isOpen(w) && (
                    <ol className="days">
                      {days.map(d => {
                        const movable = swap.on && d.format === 'lesson' && d.status === 'planned' && !d.past;
                        const cls = ['day', d.format, d.status, d.today ? 'today' : '', d.past ? 'past' : '', movable ? 'movable' : '', swap.first === d.id ? 'picked' : ''].filter(Boolean).join(' ');
                        return (
                          <li key={d.id} className={cls} onClick={() => pick(d)} role={movable ? 'button' : undefined} tabIndex={movable ? 0 : undefined}
                            onKeyDown={e => { if (movable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(d); } }}>
                            <div className="day-date"><b>{d.weekday}</b><span>{shortDate(d.date)}</span></div>
                            <div className="day-body">
                              <div className="day-title">
                                {d.format === 'lesson' ? d.topicLabel : d.formatLabel[0].toUpperCase() + d.formatLabel.slice(1)}
                                {d.writingLabel && <span className="tag">{d.writingLabel}</span>}
                                {d.status === 'done' && <span className="tag ok">пройдено{d.score != null ? ` · ${d.score}` : ''}</span>}
                                {d.status === 'skipped' && <span className="tag">пропущено</span>}
                                {d.status === 'planned' && d.past && <span className="tag">не пройдено</span>}
                                {d.today && <span className="tag today">сегодня</span>}
                              </div>
                              {d.reason && <div className="day-reason muted">{d.reason}{d.minutes ? ` · ${d.minutes} мин` : ''}</div>}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Занятия по дням программы начнутся со следующей задачи (3.2); пересборка не трогает пройденные дни и начало программы.</p>
        </>
      )}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
    </section>
  );
}
