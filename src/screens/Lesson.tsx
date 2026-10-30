import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Lesson as View, type LessonStepDone, type LessonToday } from '../api';
import { longDate, minutesText, plural } from '../text';
import { changedWords, wordDiff } from '../diff';

const LETTERS = ['A', 'B', 'C', 'D'];
const wordsText = (n: number) => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;
const cardsText = (n: number) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

type CardProps = { onOpen: () => void; refreshKey?: number };

/** Карточка «Сегодня» на главном экране: что по программе на сегодня, начать или продолжить занятие, итог пройденного. */
export function LessonCard({ onOpen, refreshKey }: CardProps) {
  const [state, setState] = useState<{ loaded: boolean; t: LessonToday | null; error: string | null }>({ loaded: false, t: null, error: null });
  useEffect(() => {
    api.lesson().then(t => setState({ loaded: true, t, error: null })).catch(e => setState({ loaded: true, t: null, error: errorText(e) }));
  }, [refreshKey]);

  const t = state.t;
  const l = t?.lesson ?? null;
  const d = t?.day ?? null;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Сегодня</h2>
        {t && <span className="muted" style={{ fontSize: 14 }}>{longDate(t.today)}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {t && !d && (
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          {t.reason === 'no_program' ? 'Занятие дня появится здесь, когда будет составлена программа — карточка «Программа» ниже.' : 'На сегодня дня программы нет: она закончилась или ещё не началась. Пересоберите программу в карточке «Программа».'}
        </p>
      )}
      {t && d && !t.available && (
        <>
          <p style={{ marginTop: 12 }}>
            <b>{cap(d.formatLabel)}</b>{d.minutes ? <span className="muted"> · {minutesText(d.minutes)}</span> : null}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>{d.reason ? `${cap(d.reason)}. ` : ''}{t.reason === 'rehearsal' ? 'Репетиция интервью появится в следующей версии (задача 4.1); сегодня можно повторить карточки журнала или пройти тест уровня.' : 'Контрольный срез появится в следующей версии (задача 4.3).'}</p>
        </>
      )}
      {t && d && t.available && (
        <>
          <p style={{ marginTop: 12 }}>
            <b>{d.topicLabel}</b>
            {d.writingLabel && <span className="tag" style={{ marginLeft: 8 }}>письмо: {d.writingLabel}</span>}
            {d.minutes ? <span className="muted"> · {minutesText(d.minutes)}</span> : null}
          </p>
          {d.reason && <p className="muted" style={{ marginTop: -8, fontSize: 14 }}>{d.reason}</p>}
          {!l && (
            <>
              <p className="muted" style={{ fontSize: 14 }}>Разминка из {t.warmup} заданий по теме дня, одно письмо формата дня с разбором и переписанным вариантом, затем повтор карточек журнала, у которых наступил срок (до {t.reviewMax}). Занятие можно прервать и продолжить с того же шага.</p>
              <button className="btn" type="button" onClick={onOpen}>Начать занятие</button>
            </>
          )}
          {l?.status === 'active' && (
            <>
              <div className="progress" aria-label={`Пройдено ${l.answered} из ${l.total}`}><span style={{ width: `${(l.answered / l.total) * 100}%` }} /></div>
              <p className="muted" style={{ marginTop: -8, fontSize: 14 }}>Пройдено {l.answered} из {l.total}: {partsLine(l)}.</p>
              <button className="btn" type="button" onClick={onOpen}>Продолжить занятие</button>
            </>
          )}
          {l?.status === 'finished' && (
            <>
              <div className="level-row" style={{ marginTop: 4 }}>
                <span className="level-badge">{l.score ?? '—'}</span>
                <p style={{ margin: 0, fontWeight: 600 }}>Занятие пройдено — {partsLine(l)}</p>
              </div>
              <button className="btn secondary" type="button" onClick={onOpen}>Открыть разбор</button>
            </>
          )}
        </>
      )}
    </section>
  );
}

function partsLine(l: View): string {
  const p = l.parts;
  const parts = [`разминка ${p.warmup.correct} из ${p.warmup.total}`];
  parts.push(p.writing.done ? `письмо ${p.writing.score ?? '—'}` : 'письмо впереди');
  if (p.review.total) parts.push(`карточки ${p.review.correct} из ${p.review.total}`);
  return parts.join(', ');
}

type Props = { onClose: () => void };

/** Экран занятия: один шаг на экране, после ответа — разбор (верно или нет, строка объяснения, как написано и как надо
 *  с подсветкой изменений), затем следующий шаг; после последнего — итог занятия. */
export default function Lesson({ onClose }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<'start' | 'answer' | null>('start');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  /** Разбор только что отвеченного шага; пока он на экране, следующий шаг ждёт кнопки «Дальше». */
  const [last, setLast] = useState<LessonStepDone | null>(null);
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    api.startLesson().then(r => setView(r.lesson)).catch(e => setError(errorText(e))).finally(() => setBusy(null));
  }, []);

  const cur = view?.current ?? null;
  useEffect(() => {
    if (!cur || startedFor.current === cur.stepId) return;
    startedFor.current = cur.stepId;
    setChoice(null); setText(cur.kind === 'correction' || cur.kind === 'card' ? cur.prompt : ''); setError(null);
  }, [cur]);

  const answerValue = (): string | null => {
    if (!cur) return null;
    if (cur.kind === 'mcq') return choice;
    return text.trim() || null;
  };
  const canSend = answerValue() != null && busy == null && !last;

  async function send() {
    const v = answerValue();
    if (!cur || v == null || busy || last) return;
    setBusy('answer'); setError(null);
    try {
      const r = await api.answerLesson(cur.stepId, v);
      setView(r.lesson); setLast(r.lesson.last);
    } catch (e) {
      setError(errorText(e));
      if ((e as any)?.code === 'lesson_stale') api.lesson().then(r => setView(r.lesson)).catch(() => {});
    } finally { setBusy(null); }
  }
  const next = () => setLast(null);

  // Горячие клавиши: 1–4 — вариант, Enter — отправить выбор или перейти дальше, Ctrl+Enter — отправить текст.
  const latest = useRef({ cur, busy, canSend, last, send, next });
  latest.current = { cur, busy, canSend, last, send, next };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const { cur, busy, canSend, last, send, next } = latest.current;
      if (busy) return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
      if (last) { if (e.key === 'Enter' && (!typing || e.ctrlKey || e.metaKey)) { e.preventDefault(); next(); } return; }
      if (!cur) return;
      if (cur.kind === 'mcq' && !typing && /^[1-4]$/.test(e.key)) { setChoice(LETTERS[Number(e.key) - 1]); e.preventDefault(); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (cur.kind === 'mcq' && !typing))) { e.preventDefault(); if (canSend) send(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (view?.status === 'finished' && !last) return <Summary view={view} onClose={onClose} />;

  const progress = view ? (view.answered / view.total) * 100 : 0;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Занятие{view ? ` · ${view.topicLabel}` : ''}</h2>
        {view && (last || cur) && <span className="muted" style={{ fontSize: 14 }}>Шаг {(last ?? cur)!.position} из {view.total} · {(last ?? cur)!.partLabel}</span>}
      </div>
      <div className="progress" aria-label={view ? `Пройдено ${view.answered} из ${view.total}` : undefined}><span style={{ width: `${progress}%` }} /></div>

      {busy === 'start' && <p className="muted">Собираю занятие: задания темы дня из банка, письмо формата дня, карточки к повтору. Если в банке по теме пусто, модель напишет задание — до минуты.</p>}
      {!cur && !last && busy !== 'start' && !error && <p className="muted">Шаг не выдан. Вернитесь на главную и начните снова.</p>}

      {last && <Review step={last} />}

      {!last && cur && cur.kind === 'mcq' && (
        <>
          <p className="muted hint" style={{ margin: '0 0 6px' }}>{cur.topicLabel}{cur.level ? ` · ${cur.level}` : ''}</p>
          <p className="task">{cur.prompt}</p>
          <div className="choices" role="radiogroup">
            {cur.options!.map((o, i) => (
              <button key={i} type="button" role="radio" aria-checked={choice === LETTERS[i]} className={`choice ${choice === LETTERS[i] ? 'active' : ''}`}
                onClick={() => setChoice(LETTERS[i])} disabled={busy != null}><span className="mono key">{i + 1}</span>{o}</button>
            ))}
          </div>
          <p className="muted hint">Клавиши 1–4 выбирают вариант, Enter отправляет.</p>
        </>
      )}

      {!last && cur && cur.kind === 'correction' && (
        <>
          <p className="muted hint" style={{ margin: '0 0 6px' }}>{cur.topicLabel}{cur.level ? ` · ${cur.level}` : ''}</p>
          <p className="task">{cur.prompt}</p>
          <label className="field">
            <span>В предложении одна ошибка. Исправьте её и ничего больше не меняйте.</span>
            <textarea className="mono" value={text} onChange={e => setText(e.target.value)} rows={3} style={{ minHeight: 80 }} disabled={busy != null} autoFocus />
          </label>
          <p className="muted hint">Ctrl+Enter отправляет.</p>
        </>
      )}

      {!last && cur && cur.kind === 'card' && (
        <>
          <p className="muted hint" style={{ margin: '0 0 6px' }}>Карточка из журнала · {cur.topicLabel}</p>
          <p className="task">{cur.prompt}</p>
          <label className="field">
            <span>Так вы написали раньше. Исправьте ошибку — как надо.</span>
            <textarea className="mono" value={text} onChange={e => setText(e.target.value)} rows={3} style={{ minHeight: 80 }} disabled={busy != null} autoFocus />
          </label>
          <p className="muted hint">Ctrl+Enter отправляет.</p>
        </>
      )}

      {!last && cur && cur.kind === 'writing' && (
        <>
          <p className="muted hint" style={{ margin: '0 0 6px' }}>{view?.writingLabel ? cap(view.writingLabel) : 'Письмо'}{cur.level ? ` · ${cur.level}` : ''}</p>
          <p className="task">{cur.prompt}</p>
          <label className="field">
            <span>Текст на английском, {cur.words!.min}–{cur.words!.max} слов. Отвечайте на задание, а не вокруг него.</span>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={8} disabled={busy != null} autoFocus lang="en" spellCheck={false} />
          </label>
          <WordCount n={countWords(text)} min={cur.words!.min} max={cur.words!.max} />
          <p className="muted hint">Ctrl+Enter отправляет.</p>
        </>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        {last ? (
          <button className="btn" type="button" onClick={next}>{view?.status === 'finished' ? 'К итогу' : 'Дальше'}</button>
        ) : (
          <button className="btn" type="button" onClick={send} disabled={!canSend}>{busy === 'answer' ? (cur?.kind === 'writing' ? 'Оцениваю…' : 'Проверяю…') : 'Ответить'}</button>
        )}
        <button className="link" type="button" onClick={onClose} disabled={busy === 'answer'}>Прервать — продолжу позже</button>
      </div>
      {busy === 'answer' && cur?.kind === 'writing' && <p className="muted hint">Письмо проверяется по рубрике и образцу — до минуты.</p>}
      {last && <p className="muted hint">Enter — дальше.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function WordCount({ n, min, max }: { n: number; min: number; max: number }) {
  const tone = n === 0 ? 'muted' : n < 30 ? 'bad' : n < min || n > max ? 'warn' : 'ok';
  return <p className={`hint ${tone}`}>{wordsText(n)} · цель {min}–{max}{n > 0 && n < 30 ? ' · меньше тридцати не принимается' : ''}</p>;
}

/** Подсветка: side = 'written' — что убрать (зачёркнуто), 'correction' — что добавлено (выделено). */
function Diff({ from, to, side }: { from: string; to: string; side: 'written' | 'correction' }) {
  const ops = wordDiff(from, to);
  return (
    <>
      {ops.map((o, i) => {
        if (o.type === 'same') return <span key={i}>{o.text} </span>;
        if (o.type === 'del') return side === 'written' ? <s key={i} className="diff-del">{o.text} </s> : null;
        return side === 'correction' ? <mark key={i} className="diff-ins">{o.text} </mark> : null;
      })}
    </>
  );
}

/** Разбор шага: верно или нет, одна строка объяснения, как написано и как надо с подсветкой изменений. */
function Review({ step }: { step: LessonStepDone }) {
  const written = step.written ?? step.answer ?? '';
  const correction = step.correction ?? '';
  const changed = written && correction ? changedWords(wordDiff(written, correction)) : 0;
  const w = step.writing;
  return (
    <div className={`review ${step.correct === 1 ? 'ok' : step.correct === 0 ? 'bad' : 'graded'}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b className="verdict">{step.correct === 1 ? 'Верно' : step.correct === 0 ? 'Неверно' : `Письмо: ${step.score ?? '—'} из 100${w ? ` · ${w.level}` : ''}`}</b>
        <span className="muted" style={{ fontSize: 13 }}>{step.topicLabel ?? step.partLabel}</span>
      </div>
      {step.feedback && <p className="review-note">{step.feedback}</p>}
      {step.kind !== 'writing' && (
        <>
          {step.correct === 0 && written && <p className="ex-quote mono" lang="en"><Diff from={written} to={correction} side="written" /></p>}
          {correction && <p className="ex-fix mono" lang="en">{step.correct === 0 ? <Diff from={written} to={correction} side="correction" /> : correction}</p>}
          {step.correct === 0 && changed > 0 && <p className="muted hint">{changed === 1 ? 'Изменено одно слово.' : `Изменено ${wordsText(changed)}.`}</p>}
        </>
      )}
      {step.kind === 'writing' && w && (
        <>
          {w.errors.length > 0 && (
            <ol className="examples" style={{ marginTop: 10 }}>
              {w.errors.map((e, i) => (
                <li key={i}>
                  <p className="ex-quote mono" lang="en" style={{ marginTop: 0 }}><Diff from={e.original} to={e.corrected} side="written" /></p>
                  <p className="ex-fix mono" lang="en"><Diff from={e.original} to={e.corrected} side="correction" /></p>
                  <p className="ex-note">{e.note}</p>
                </li>
              ))}
            </ol>
          )}
          {w.errors.length === 0 && <p className="muted hint">Ошибок в тексте экзаменатор не нашёл.</p>}
          {w.rewrite && (
            <>
              <h3 className="result-h" style={{ marginTop: 14 }}>Переписанный вариант</h3>
              <p className="passage" lang="en"><Diff from={written} to={w.rewrite} side="correction" /></p>
            </>
          )}
          <ul className="axes-mini" style={{ marginTop: 12 }}>
            <li><span>Точность грамматики</span><b>{w.axes.grammar}</b></li>
            <li><span>Словарь</span><b>{w.axes.vocabulary}</b></li>
            <li><span>Связность</span><b>{w.axes.coherence}</b></li>
            <li><span>Ответ на вопрос задания</span><b>{w.axes.taskResponse}</b></li>
          </ul>
        </>
      )}
      {step.kind === 'writing' && !w && <p className="muted hint">Оценка письма не сохранилась.</p>}
    </div>
  );
}

/** Итог занятия: балл, три части, разбор всех шагов. */
function Summary({ view, onClose }: { view: View; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const p = view.parts;
  const writing = view.steps.find(s => s.part === 'writing');
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Занятие пройдено · {view.topicLabel}</h2>
        <span className="muted" style={{ fontSize: 14 }}>{longDate(view.date)}</span>
      </div>
      <div className="level-row" style={{ marginTop: 12 }}>
        <span className="level-badge">{view.score ?? '—'}</span>
        <p style={{ margin: 0, fontWeight: 600 }}>Балл занятия из 100 — среднее по всем шагам{view.day?.minutes ? `, план ${minutesText(view.day.minutes)}` : ''}</p>
      </div>
      <ul className="facts-list">
        <li>Разминка по теме «{view.topicLabel}»: верно {p.warmup.correct} из {p.warmup.total}.</li>
        <li>Письмо{view.writingLabel ? ` (${view.writingLabel})` : ''}: {p.writing.done ? `${p.writing.score ?? '—'} из 100${writing?.writing ? `, уровень текста ${writing.writing.level}` : ''}` : 'не сдано'}.</li>
        <li>Карточки журнала: {p.review.total ? `верно ${p.review.correct} из ${p.review.total}` : 'к повтору сегодня не было'}.</li>
      </ul>
      {writing?.writing?.summary && <p style={{ marginTop: 0 }}>{writing.writing.summary}</p>}
      <button className="link" type="button" onClick={() => setOpen(v => !v)}>{open ? 'Скрыть разбор шагов' : `Показать разбор шагов (${view.steps.length})`}</button>
      {open && (
        <div className="stack" style={{ marginTop: 12 }}>
          {view.steps.map(s => (
            <div key={s.stepId}>
              <p className="muted hint" style={{ margin: '0 0 4px' }}>Шаг {s.position} · {s.partLabel}</p>
              {s.kind !== 'card' && <p className="prompt" style={{ marginTop: 0 }}>{s.prompt}</p>}
              <Review step={s} />
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="button" onClick={onClose}>На главную</button>
      </div>
      <p className="muted hint">Пройденный день отмечен в программе{p.review.total ? `; ${cardsText(p.review.total)} ${p.review.total === 1 ? 'получила' : 'получили'} новый срок повтора` : ''}.</p>
    </section>
  );
}
