import { useEffect, useState } from 'react';
import { api, errorText, type ErrorCard } from '../api';
import { longDate, plural, daysText, daysBetween } from '../text';

const cardsText = (n: number) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type Props = { refreshKey?: number };

/** Строка состояния карточки: когда повтор, сколько верных подряд и сколько осталось до гашения. */
export function cardStatus(c: ErrorCard, today: string): string {
  if (c.retired) return 'погашена';
  const when = c.due == null || c.due <= today ? 'повтор сегодня' : `повтор ${longDate(c.due)}`;
  const streak = c.streak > 0 ? `${c.streak} из 3 верных подряд` : c.lapses > 0 ? 'серия сброшена' : 'ещё не повторялась';
  return `${when} · ${streak}`;
}

/** Карточка «Журнал ошибок» на главном экране: сколько карточек ждёт повтора сегодня и позже, сколько погашено;
 *  список по темам — правило одной строкой, как написано и как надо, срок и серия верных. */
export function JournalCard({ refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; cards: ErrorCard[]; error: string | null }>({ loaded: false, cards: [], error: null });
  const [open, setOpen] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  useEffect(() => {
    api.cards().then(r => setState({ loaded: true, cards: r.cards, error: null })).catch(e => setState({ loaded: true, cards: [], error: errorText(e) }));
  }, [refreshKey]);

  const today = localToday();
  const active = state.cards.filter(c => !c.retired);
  const retired = state.cards.filter(c => c.retired);
  const dueToday = active.filter(c => c.due == null || c.due <= today);
  const nextDue = active.filter(c => c.due != null && c.due > today).map(c => c.due as string).sort()[0];
  const topics = new Map<string, number>();
  for (const c of active) topics.set(c.topicLabel, (topics.get(c.topicLabel) ?? 0) + 1);
  const shown = showRetired ? state.cards : active;

  return (
    <section className="card">
      <h2>Журнал ошибок</h2>
      {!state.loaded && <p className="muted">Смотрю…</p>}
      {state.loaded && state.error && <p className="error" role="alert">{state.error}</p>}
      {state.loaded && !state.error && !state.cards.length && (
        <p className="muted" style={{ margin: 0 }}>Пока пусто. Карточки появляются из ошибок теста уровня и занятий: неверное исправление, неверный вариант, ошибка в письме. Каждая повторяется в конце занятия по расписанию FSRS и гаснет после трёх верных подряд.</p>
      )}
      {state.loaded && !state.error && state.cards.length > 0 && (
        <>
          <p style={{ marginTop: 0 }}>
            {active.length ? <>{cardsText(active.length)} в работе{dueToday.length ? <>, <b>{dueToday.length} к повтору сегодня</b></> : nextDue ? `, ближайший повтор ${longDate(nextDue)}` : ''}</> : 'Все карточки погашены'}
            {retired.length ? `${active.length ? ', ' : ': '}${retired.length} погашено` : ''}.
            <span className="muted"> Повторы — в конце дневного занятия, до пяти за раз; интервал считает FSRS по вашим ответам, неверный ответ возвращает карточку завтра, три верных подряд гасят её.</span>
          </p>
          {topics.size > 0 && (
            <ul className="chips" style={{ marginBottom: 10 }}>
              {[...topics.entries()].map(([label, n]) => <li key={label}>{label}{n > 1 ? ` · ${n}` : ''}</li>)}
            </ul>
          )}
          <div className="row" style={{ gap: 16 }}>
            <button className="link" type="button" onClick={() => setOpen(v => !v)}>{open ? 'Скрыть карточки' : 'Показать карточки'}</button>
            {open && retired.length > 0 && <button className="link" type="button" onClick={() => setShowRetired(v => !v)}>{showRetired ? 'Без погашенных' : `Показать погашенные (${retired.length})`}</button>}
          </div>
          {open && (
            <ol className="examples" style={{ marginTop: 12 }}>
              {shown.map(c => (
                <li key={c.id} style={c.retired ? { opacity: 0.6 } : undefined}>
                  <div className="ex-src muted">{c.topicLabel.toLowerCase()} · {cardStatus(c, today)}{c.lapses > 0 && !c.retired ? ` · ${c.lapses} ${plural(c.lapses, 'сбой', 'сбоя', 'сбоев')}` : ''}</div>
                  {c.example && <p className="ex-quote mono" lang="en"><s>{c.example}</s></p>}
                  {c.correction && <p className="ex-fix mono" lang="en">{c.correction}</p>}
                  {c.rule && <p className="ex-note">{c.rule}</p>}
                </li>
              ))}
            </ol>
          )}
          {open && !shown.length && <p className="muted hint">Активных карточек нет{retired.length ? `; погашено ${retired.length}` : ''}.</p>}
        </>
      )}
    </section>
  );
}

/** Подпись к итогу повтора карточки в занятии. */
export function reviewOutcome(card: { due: string | null; streak: number; left: number; retired: boolean }, correct: boolean, today: string): string {
  if (card.retired) return 'Карточка погашена: три верных подряд.';
  if (!correct) return 'Серия сброшена, карточка вернётся завтра.';
  const days = card.due ? Math.max(1, daysBetween(today, card.due)) : null;
  return `${card.streak} из 3 верных подряд${days ? `, следующий повтор через ${daysText(days)}` : ''}.`;
}
