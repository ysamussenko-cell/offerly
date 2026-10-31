import { useEffect, useState } from 'react';
import { api, errorText, type AssessmentMode as Mode, type Checkpoint as View, type CheckpointToday, type Comparison } from '../api';
import { longDate, minutesText, plural } from '../text';

const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const signed = (n: number) => n > 0 ? `+${n}` : `${n}`;
const pointsText = (n: number) => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;
const tasksText = (n: number) => `${n} ${plural(n, 'задание', 'задания', 'заданий')}`;

/** Короткие подписи осей — как в радаре. */
const AXIS_SHORT: Record<string, string> = { grammar: 'Грамматика', vocabulary: 'Словарь', coherence: 'Связность', taskResponse: 'Ответ на вопрос', fluency: 'Беглость речи' };

/** Сравнение с прошлым тестом или срезом: вывод одной строкой, балл и уровень до/после, оси с разницей.
 *  Разница меньше significant — в пределах погрешности, цветом не выделяется. */
export function ComparisonView({ c, significant }: { c: Comparison; significant: number }) {
  const tone = (d: number | null) => d == null || Math.abs(d) < significant ? 'same' : d > 0 ? 'up' : 'down';
  return (
    <div className={`compare ${c.level.change}`} aria-label="Сравнение с прошлым тестом">
      <p className="compare-verdict">{c.verdict}</p>
      <div className="compare-row">
        <div className="compare-cell">
          <small className="muted">{cap(c.previous.kindLabel)}{c.previous.finishedAt ? ` · ${longDate(c.previous.finishedAt.slice(0, 10))}` : ''}</small>
          <div className="compare-num"><b>{c.overall.before}</b><span className="muted">· {c.level.before}</span></div>
        </div>
        <span className={`compare-arrow ${tone(c.overall.delta)}`} aria-hidden="true">→</span>
        <div className="compare-cell">
          <small className="muted">Сейчас</small>
          <div className="compare-num"><b>{c.overall.after}</b><span className="muted">· {c.level.after}</span><span className={`delta ${tone(c.overall.delta)}`}>{signed(c.overall.delta)}</span></div>
        </div>
      </div>
      <ul className="axes-mini compare-axes">
        {c.axes.map(a => (
          <li key={a.id} className={a.after == null ? 'off' : ''}>
            <span>{AXIS_SHORT[a.id] ?? a.label}</span>
            <b>
              {a.before == null ? '—' : a.before}<span className="muted"> → </span>{a.after == null ? '—' : a.after}
              {a.delta != null && <span className={`delta ${tone(a.delta)}`}>{signed(a.delta)}</span>}
            </b>
          </li>
        ))}
      </ul>
      <p className="muted hint" style={{ margin: 0 }}>
        {c.improved.length ? `Выросли: ${c.improved.map(id => AXIS_SHORT[id].toLowerCase()).join(', ')}. ` : ''}
        {c.declined.length ? `Просели: ${c.declined.map(id => AXIS_SHORT[id].toLowerCase()).join(', ')}. ` : ''}
        Разница меньше {pointsText(significant)} — в пределах погрешности короткого теста.
      </p>
    </div>
  );
}

type CardProps = { onOpen: (mode: Mode) => void; refreshKey?: number };

/** Карточка «Контрольный срез» на главном экране: срез ли сегодня по программе, когда следующий, начать или продолжить,
 *  итог последнего среза со сравнением. */
export function CheckpointCard({ onOpen, refreshKey }: CardProps) {
  const [state, setState] = useState<{ loaded: boolean; t: CheckpointToday | null; error: string | null }>({ loaded: false, t: null, error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.checkpoint().then(t => setState({ loaded: true, t, error: null })).catch(e => setState({ loaded: true, t: null, error: errorText(e) }));
  }, [refreshKey]);

  async function restart() {
    setBusy(true); setError(null);
    try { await api.abandonCheckpoint(); onOpen('test'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const t = state.t;
  const c: View | null = t?.checkpoint ?? null;
  const d = t?.day ?? null;
  const doneToday = !!c && c.status === 'finished' && !!t && c.finishedAt?.slice(0, 10) === t.today;
  const active = c?.status === 'active';
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Контрольный срез</h2>
        {t && <span className="muted" style={{ fontSize: 14 }}>{t.scheduled ? 'сегодня по программе' : t.next ? `следующий ${longDate(t.next.date)}` : 'вне плана'}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {t && d && !active && !doneToday && (
        <p style={{ marginTop: 12 }}>
          <b>{cap(d.formatLabel)}</b>{d.minutes ? <span className="muted"> · {minutesText(d.minutes)}</span> : null}
          {d.reason && <span className="muted" style={{ display: 'block', fontSize: 14 }}>{cap(d.reason)}</span>}
        </p>
      )}
      {t && !active && !doneToday && (
        <>
          <p className="muted" style={{ marginTop: d ? 0 : 12, fontSize: 14 }}>
            Укороченный тест уровня: {tasksText(t.adaptive)} на грамматику и лексику со старта с вашего текущего уровня, чтение с двумя вопросами и письмо на 60–80 слов — {t.total} шагов,
            около пятнадцати минут. После письма — пять осей и честное сравнение с прошлым тестом: уровень вырос, не изменился или снизился. Срез становится новой точкой отсчёта
            готовности, оставшиеся дни программы пересобираются по свежему профилю ошибок. Можно прервать и продолжить.
          </p>
          {!t.scheduled && <p className="muted" style={{ fontSize: 14 }}>Сегодня по программе не срез{t.next ? ` — следующий ${longDate(t.next.date)}` : ''}; пройти его можно и вне плана, тогда программа не трогается.</p>}
          <button className={t.scheduled ? 'btn' : 'btn secondary'} type="button" onClick={() => onOpen('test')} disabled={busy}>Начать срез</button>
        </>
      )}
      {t && active && c && (
        <>
          <p style={{ marginTop: 12 }}>Срез начат{c.day ? ` по программе (день ${c.day.position})` : ' вне плана'}: отвечено {c.answered} из {c.total}.</p>
          <div className="row">
            <button className="btn" type="button" onClick={() => onOpen('test')} disabled={busy}>Продолжить</button>
            <button className="link" type="button" onClick={restart} disabled={busy}>Начать заново</button>
          </div>
        </>
      )}
      {t && c && c.status === 'finished' && c.level && (
        <>
          <div className="level-row" style={{ marginTop: doneToday ? 12 : 16 }}>
            <span className="level-badge">{c.level}</span>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{doneToday ? 'Срез пройден' : 'Последний срез'}{c.result ? ` · ${c.result.overall} из 100` : ' — предварительно'}</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>{c.finishedAt ? longDate(c.finishedAt.slice(0, 10)) : ''}{c.day ? ` · день ${c.day.position} программы` : ' · вне плана'}{c.summary ? ` · грамматика и лексика: ${c.summary.adaptiveCorrect} из ${c.summary.adaptiveTotal}` : ''}</p>
            </div>
          </div>
          {c.comparison && <p style={{ margin: '10px 0 0', fontSize: 15 }}>{c.comparison.verdict}</p>}
          {!c.comparison && c.result && <p className="muted" style={{ margin: '10px 0 0', fontSize: 14 }}>Сравнивать пока не с чем: это первая оценка.</p>}
          {!c.result && <p className="muted" style={{ fontSize: 14 }}>Оси ещё не посчитаны. Откройте разбор — оценка посчитается по сохранённым ответам.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={() => onOpen('result')}>{c.result ? 'Открыть разбор' : 'Рассчитать оценку'}</button>
          </div>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
