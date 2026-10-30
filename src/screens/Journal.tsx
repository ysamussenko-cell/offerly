import { useEffect, useState } from 'react';
import { api, errorText, type ErrorCard } from '../api';
import { longDate, plural } from '../text';

const cardsText = (n: number) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;

type Props = { refreshKey?: number };

/** Карточка «Журнал ошибок» на главном экране: сколько карточек ждёт повтора, список по темам —
 *  правило одной строкой, как написано и как надо. Повторы по FSRS и гашение — 3.3. */
export function JournalCard({ refreshKey }: Props) {
  const [state, setState] = useState<{ loaded: boolean; cards: ErrorCard[]; error: string | null }>({ loaded: false, cards: [], error: null });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.cards().then(r => setState({ loaded: true, cards: r.cards, error: null })).catch(e => setState({ loaded: true, cards: [], error: errorText(e) }));
  }, [refreshKey]);

  const active = state.cards.filter(c => !c.retired);
  const retired = state.cards.length - active.length;
  const topics = new Map<string, number>();
  for (const c of active) topics.set(c.topicLabel, (topics.get(c.topicLabel) ?? 0) + 1);

  return (
    <section className="card">
      <h2>Журнал ошибок</h2>
      {!state.loaded && <p className="muted">Смотрю…</p>}
      {state.loaded && state.error && <p className="error" role="alert">{state.error}</p>}
      {state.loaded && !state.error && !state.cards.length && (
        <p className="muted" style={{ margin: 0 }}>Пока пусто. Карточки появятся из ошибок теста уровня и занятий: каждая гаснет после трёх верных повторов.</p>
      )}
      {state.loaded && !state.error && state.cards.length > 0 && (
        <>
          <p style={{ marginTop: 0 }}>
            {cardsText(active.length)} к повтору{retired ? `, ${retired} погашено` : ''}.
            <span className="muted"> Карточки со сроком на сегодня повторяются в конце дневного занятия; интервалы по FSRS — следующая задача.</span>
          </p>
          <ul className="chips" style={{ marginBottom: 10 }}>
            {[...topics.entries()].map(([label, n]) => <li key={label}>{label}{n > 1 ? ` · ${n}` : ''}</li>)}
          </ul>
          <button className="link" type="button" onClick={() => setOpen(v => !v)}>{open ? 'Скрыть карточки' : 'Показать карточки'}</button>
          {open && (
            <ol className="examples" style={{ marginTop: 12 }}>
              {active.map(c => (
                <li key={c.id}>
                  <div className="ex-src muted">{c.topicLabel.toLowerCase()}{c.due ? ` · повтор ${longDate(c.due)}` : ''}</div>
                  {c.example && <p className="ex-quote mono" lang="en"><s>{c.example}</s></p>}
                  {c.correction && <p className="ex-fix mono" lang="en">{c.correction}</p>}
                  {c.rule && <p className="ex-note">{c.rule}</p>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
