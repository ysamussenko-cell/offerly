import { useEffect, useState } from 'react';
import { api, errorText, type Achievement, type Achievements as Catalogue } from '../api';
import { longDate, longDateAt } from '../text';

type Props = { refreshKey?: number };

/** Подпись прогресса: «3 из 5», «открыто 3 ноября». */
export function progressText(a: Achievement): string {
  if (a.unlocked) return a.detail ? `открыто · ${longDate(a.detail)}` : a.unlockedAt ? `открыто · ${longDateAt(a.unlockedAt)}` : 'открыто';
  return a.progress.target === 1 ? 'ещё впереди' : `${a.progress.value} из ${a.progress.target}`;
}

/** Карточка «Достижения» на главном экране: открытые — с датой, ближайшие — с прогрессом; достижения привязаны
 *  к навыку (серии верных по теме, письмо без правок, растяжка, погашенные карточки, бонусы), не к кликам. */
export function AchievementsCard({ refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; c: Catalogue | null; error: string | null }>({ loaded: false, c: null, error: null });
  const [all, setAll] = useState(false);

  useEffect(() => {
    api.achievements().then(c => {
      setState({ loaded: true, c, error: null });
      // «новое» показано — гасим на сервере, в этом рендере отметка ещё видна
      if (c.fresh > 0) api.achievementsSeen().catch(() => {});
    }).catch(e => setState({ loaded: true, c: null, error: errorText(e) }));
  }, [refreshKey]);

  const c = state.c;
  const unlocked = c?.achievements.filter(a => a.unlocked) ?? [];
  const locked = c?.achievements.filter(a => !a.unlocked) ?? [];
  const near = locked.filter(a => a.progress.value > 0);
  const shownLocked = all ? locked : near.slice(0, 4);

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Достижения</h2>
        {c && <span className="muted" style={{ fontSize: 14 }}>{c.unlocked} из {c.total}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Считаю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {c && (
        <>
          <p className="muted" style={{ marginTop: 12, fontSize: 14 }}>
            За навык, а не за клики: пять верных подряд по теме, письмо без правок, растяжка ступенью выше, погашенные карточки, решённые бонусы. Условия считаются по вашим ответам и не сбрасываются.
          </p>
          {unlocked.length > 0 && (
            <ul className="ach-list">
              {unlocked.map(a => (
                <li key={a.code} className={`ach on${a.new ? ' fresh' : ''}`}>
                  <span className="ach-mark" aria-hidden="true" />
                  <div>
                    <b>{a.title}{a.new && <span className="tag today" style={{ marginLeft: 8 }}>новое</span>}</b>
                    <span className="muted">{a.description}</span>
                    <small className="muted">{progressText(a)}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {unlocked.length === 0 && <p style={{ margin: '0 0 8px' }}>Открытых пока нет — первые появятся после занятий: разминка без ошибок, пять верных подряд по теме дня, погашенная карточка.</p>}
          {(shownLocked.length > 0 || locked.length > 0) && (
            <>
              <h3 className="result-h" style={{ marginTop: 14 }}>{all ? 'Все впереди' : 'Ближайшие'}</h3>
              {shownLocked.length === 0 && <p className="muted" style={{ fontSize: 14, margin: 0 }}>Прогресса ни по одному ещё нет.</p>}
              {shownLocked.length > 0 && (
                <ul className="ach-list">
                  {shownLocked.map(a => (
                    <li key={a.code} className="ach">
                      <span className="ach-mark" aria-hidden="true" />
                      <div>
                        <b>{a.title}</b>
                        <span className="muted">{a.description}</span>
                        {a.progress.target > 1 && <div className="progress" style={{ margin: '4px 0 2px', height: 4 }} aria-label={`${a.progress.value} из ${a.progress.target}`}><span style={{ width: `${Math.round(a.progress.value / a.progress.target * 100)}%` }} /></div>}
                        <small className="muted">{progressText(a)}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <button className="link" type="button" onClick={() => setAll(v => !v)} style={{ marginTop: 8 }}>{all ? 'Только ближайшие' : `Показать все (${locked.length})`}</button>
            </>
          )}
        </>
      )}
    </section>
  );
}
