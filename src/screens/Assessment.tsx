import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Assessment as View } from '../api';
import { KeyHints, useHotkeys } from '../KeyHints';
import { submitShortcut } from '../hotkeys';
import { longDate, plural } from '../text';
import ResultView from './Result';

const LETTERS = ['A', 'B', 'C', 'D'];
const wordsText = (n: number) => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

type CardProps = { onOpen: (mode: Mode) => void; refreshKey?: number };
export type Mode = 'test' | 'result';

/** Карточка на главном экране: начать, продолжить или открыть разбор завершённого теста. */
export function TestCard({ onOpen, refreshKey }: CardProps) {
  const [state, setState] = useState<{ loaded: boolean; a: View | null }>({ loaded: false, a: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.assessment().then(r => setState({ loaded: true, a: r.assessment })).catch(() => setState({ loaded: true, a: null })); }, [refreshKey]);

  async function restart() {
    setBusy(true); setError(null);
    try { await api.abandonAssessment(); onOpen('test'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const a = state.a;
  return (
    <section className="card">
      <h2>Тест уровня</h2>
      {!state.loaded && <p className="muted">Смотрю…</p>}
      {state.loaded && !a && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Двенадцать заданий на грамматику и лексику в вашей специальности, короткий текст с двумя вопросами на подтекст и письмо на 60–80 слов.
            Сложность подстраивается после каждого ответа. Это 12–15 минут; тест можно прервать и продолжить с того же места.
          </p>
          <button className="btn" type="button" onClick={() => onOpen('test')}>Начать тест</button>
        </>
      )}
      {state.loaded && a?.status === 'active' && (
        <>
          <p style={{ marginTop: 0 }}>Тест начат: отвечено {a.answered} из {a.total}.</p>
          <div className="row">
            <button className="btn" type="button" onClick={() => onOpen('test')} disabled={busy}>Продолжить</button>
            <button className="link" type="button" onClick={restart} disabled={busy}>Начать заново</button>
          </div>
        </>
      )}
      {state.loaded && a?.status === 'finished' && a.level && (
        <>
          <div className="level-row">
            <span className="level-badge">{a.level}</span>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{a.levelLabel && a.levelLabel[0].toUpperCase() + a.levelLabel.slice(1)}{a.result ? ` · ${a.result.overall} из 100` : ' — предварительно'}</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>{a.kind === 'baseline' ? 'Исходный срез · ' : ''}{a.finishedAt ? longDate(a.finishedAt.slice(0, 10)) : ''}{a.summary ? ` · грамматика и лексика: ${a.summary.adaptiveCorrect} из ${a.summary.adaptiveTotal}` : ''}</p>
            </div>
          </div>
          {a.kind === 'baseline' && <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>Срез получен вне приложения и служит точкой отсчёта. Тест уровня в приложении заменит его.</p>}
          {a.result && (
            <ul className="axes-mini">
              {a.result.axes.map(x => <li key={x.id} className={x.score == null ? 'off' : ''}><span>{x.label}</span><b>{x.score == null ? '—' : x.score}</b></li>)}
            </ul>
          )}
          {!a.result && <p className="muted" style={{ fontSize: 14 }}>Тест пройден до появления оценки по осям. Откройте разбор — оси и уровень посчитаются по сохранённым ответам.</p>}
          <div className="row">
            <button className="btn" type="button" onClick={() => onOpen('result')}>{a.result ? (a.kind === 'baseline' ? 'Открыть срез' : 'Открыть разбор') : 'Рассчитать оценку'}</button>
            <button className="btn secondary" type="button" onClick={() => onOpen('test')}>{a.kind === 'baseline' ? 'Пройти тест' : 'Пройти заново'}</button>
          </div>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

type Props = { onClose: () => void; mode?: Mode };

/** Экран теста: одно задание на экране, прогресс сверху, ответ — кнопками или текстом.
 *  В режиме result показывает разбор последнего завершённого теста (считая оценку, если её ещё нет). */
export default function Assessment({ onClose, mode = 'test' }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<'start' | 'answer' | 'score' | null>('start');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [pair, setPair] = useState<(string | null)[]>([null, null]);
  const [text, setText] = useState('');
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    if (mode === 'result') {
      // Разбор: если оси ещё не считались (тест пройден до 2.6), сервер считает их сейчас.
      api.assessment().then(async r => {
        if (r.assessment?.status === 'finished' && !r.assessment.result) { setBusy('score'); return (await api.scoreAssessment()).assessment; }
        return r.assessment;
      }).then(setView).catch(e => setError(errorText(e))).finally(() => setBusy(null));
      return;
    }
    api.startAssessment().then(r => setView(r.assessment)).catch(e => setError(errorText(e))).finally(() => setBusy(null));
  }, [mode]);

  async function rescore() {
    setBusy('score'); setError(null);
    try { setView((await api.scoreAssessment()).assessment); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  async function restart() {
    setBusy('start'); setError(null); setView(null);
    try { setView((await api.startAssessment()).assessment); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  const cur = view?.current ?? null;
  // Новое задание — чистые поля; для исправления в поле подставляется исходное предложение.
  useEffect(() => {
    if (!cur || startedFor.current === cur.attemptId) return;
    startedFor.current = cur.attemptId;
    setChoice(null); setPair([null, null]); setText(cur.kind === 'correction' ? cur.prompt : ''); setError(null);
  }, [cur]);

  const answerValue = (): string | string[] | null => {
    if (!cur) return null;
    if (cur.kind === 'mcq') return choice;
    if (cur.kind === 'reading') return pair.every(Boolean) ? (pair as string[]) : null;
    return text.trim() || null;
  };
  const canSend = answerValue() != null && busy == null;

  async function send() {
    const v = answerValue();
    if (!cur || v == null || busy) return;
    setBusy('answer'); setError(null);
    try {
      const r = await api.answerAssessment(cur.attemptId, v);
      setView(r.assessment);
    } catch (e) {
      setError(errorText(e));
      // Задание закрылось в другой вкладке — подтянуть текущее состояние.
      if ((e as any)?.code === 'assessment_stale') api.assessment().then(r => setView(r.assessment)).catch(() => {});
    } finally { setBusy(null); }
  }

  // Горячие клавиши на всём экране (src/hotkeys.ts): 1–4 — вариант (в чтении — первый неотвеченный вопрос),
  // Enter (для выбора) и Ctrl+Enter (везде) — отправить, Esc — прервать и вернуться на главную.
  const testing = view?.status === 'active' && cur != null;
  const textEntry = cur?.kind === 'correction' || cur?.kind === 'writing';
  const choices = cur?.kind === 'mcq' ? cur.options!.length : cur?.kind === 'reading' ? Math.max(...cur.questions!.map(q => q.options.length)) : 0;
  const keyCtx = {
    choices: testing ? choices : 0,
    submit: testing && canSend,
    cancel: view?.status !== 'finished' && busy !== 'answer' && busy !== 'score', // на экране результата Esc слушает Finished
    busy: busy != null,
  };
  useHotkeys(keyCtx, {
    onSubmit: send,
    onCancel: onClose,
    onChoose: i => {
      if (!cur) return;
      if (cur.kind === 'mcq') { if (i < cur.options!.length) setChoice(LETTERS[i]); return; }
      if (cur.kind === 'reading') {
        // Цифра отвечает на первый вопрос без ответа; когда оба отвечены — меняет ответ второго.
        const open = pair.findIndex(x => x == null);
        const qi = open === -1 ? pair.length - 1 : open;
        if (i < (cur.questions![qi]?.options.length ?? 0)) setPair(p => p.map((x, k) => k === qi ? LETTERS[i] : x));
      }
    },
  });

  if (view?.status === 'finished') return <Finished view={view} onClose={onClose} onRestart={restart} onRescore={rescore} busy={busy} error={error} />;
  if (mode === 'result' && !view) {
    return (
      <section className="card">
        <h2>Разбор теста</h2>
        {busy === 'score' && <p className="muted">Считаю оси и оцениваю письмо по рубрике — до минуты.</p>}
        {busy === 'start' && <p className="muted">Открываю результат…</p>}
        {!busy && !error && <p className="muted">Завершённого теста нет.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}><button className="btn secondary" type="button" onClick={onClose}>На главную</button></div>
      </section>
    );
  }

  const progress = view ? (view.answered / view.total) * 100 : 0;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Тест уровня</h2>
        {cur && <span className="muted" style={{ fontSize: 14 }}>Задание {cur.position} из {view!.total} · {cur.kindLabel}</span>}
      </div>
      <div className="progress" aria-label={view ? `Отвечено ${view.answered} из ${view.total}` : undefined}><span style={{ width: `${progress}%` }} /></div>

      {busy === 'start' && <p className="muted">Подбираю первое задание… Если банк для вашего уровня пуст, модель напишет его сейчас — это до минуты.</p>}
      {!cur && busy !== 'start' && !error && <p className="muted">Задание не выдано. Вернитесь на главную и начните снова.</p>}

      {cur && cur.kind === 'mcq' && (
        <>
          <p className="task">{cur.prompt}</p>
          <div className="choices" role="radiogroup">
            {cur.options!.map((o, i) => (
              <button key={i} type="button" role="radio" aria-checked={choice === LETTERS[i]} className={`choice ${choice === LETTERS[i] ? 'active' : ''}`}
                onClick={() => setChoice(LETTERS[i])} disabled={busy != null}><span className="mono key">{i + 1}</span>{o}</button>
            ))}
          </div>
        </>
      )}

      {cur && cur.kind === 'correction' && (
        <>
          <p className="task">{cur.prompt}</p>
          <label className="field">
            <span>В предложении одна ошибка. Исправьте её и ничего больше не меняйте.</span>
            <textarea className="mono" value={text} onChange={e => setText(e.target.value)} rows={3} style={{ minHeight: 80 }} disabled={busy != null} autoFocus />
          </label>
        </>
      )}

      {cur && cur.kind === 'reading' && (
        <>
          <p className="passage">{cur.prompt}</p>
          {cur.questions!.map((q, qi) => (
            <fieldset key={qi} className="field q" style={{ marginTop: 16 }}>
              <legend><b className="qn">{qi + 1}</b>{q.question}</legend>
              <div className="choices" role="radiogroup">
                {q.options.map((o, i) => (
                  <button key={i} type="button" role="radio" aria-checked={pair[qi] === LETTERS[i]} className={`choice ${pair[qi] === LETTERS[i] ? 'active' : ''}`}
                    onClick={() => setPair(p => p.map((x, k) => k === qi ? LETTERS[i] : x))} disabled={busy != null}><span className="mono key">{LETTERS[i]}</span>{o}</button>
                ))}
              </div>
            </fieldset>
          ))}
        </>
      )}

      {cur && cur.kind === 'writing' && <WritingInput prompt={cur.prompt} words={cur.words!} text={text} setText={setText} disabled={busy != null} />}

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" type="button" onClick={send} disabled={!canSend} aria-keyshortcuts={submitShortcut(textEntry)}>{busy === 'answer' ? (cur?.position === view?.total ? 'Оцениваю…' : 'Принимаю…') : 'Ответить'}</button>
        <button className="link" type="button" onClick={onClose} disabled={busy === 'answer'} aria-keyshortcuts="Escape">Прервать — продолжу позже</button>
      </div>
      {cur && <KeyHints ctx={{ ...keyCtx, submit: testing, busy: false }} textEntry={textEntry} />}
      {busy === 'answer' && cur?.position !== view?.total && <p className="muted hint">Следующее задание подбирается из банка; если там пусто, модель напишет его — до минуты.</p>}
      {busy === 'answer' && cur?.position === view?.total && <p className="muted hint">Письмо проверяется по рубрике и образцу, считаются пять осей — до минуты.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function WritingInput({ prompt, words, text, setText, disabled }: { prompt: string; words: { min: number; max: number }; text: string; setText: (s: string) => void; disabled: boolean }) {
  const n = countWords(text);
  const tone = n === 0 ? 'muted' : n < 30 ? 'bad' : n < words.min || n > words.max ? 'warn' : 'ok';
  return (
    <>
      <p className="task">{prompt}</p>
      <label className="field">
        <span>Текст на английском, {words.min}–{words.max} слов. Отвечайте на задание, а не вокруг него.</span>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={8} disabled={disabled} autoFocus lang="en" spellCheck={false} />
      </label>
      <p className={`hint ${tone}`}>{wordsText(n)} · цель {words.min}–{words.max}{n > 0 && n < 30 ? ' · меньше тридцати не принимается' : ''}</p>
    </>
  );
}

type FinishedProps = { view: View; onClose: () => void; onRestart: () => void; onRescore: () => void; busy: string | null; error: string | null };

function Finished({ view, onClose, onRestart, onRescore, busy, error }: FinishedProps) {
  const s = view.summary;
  const r = view.result;
  const baseline = view.kind === 'baseline';
  const keyCtx = { cancel: busy == null };
  useHotkeys(keyCtx, { onCancel: onClose });
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{baseline ? 'Исходный срез' : 'Результат теста'}</h2>
        {view.finishedAt && <span className="muted" style={{ fontSize: 14 }}>{longDate(view.finishedAt.slice(0, 10))}</span>}
      </div>
      {r ? (
        <ResultView result={r} levelLabel={view.levelLabel} finishedAt={view.finishedAt} onRescore={baseline ? undefined : onRescore} rescoring={busy === 'score'} baseline={baseline} />
      ) : (
        <>
          <div className="level-row" style={{ marginTop: 12 }}>
            <span className="level-badge">{view.level}</span>
            <p style={{ margin: 0, fontWeight: 600 }}>{view.levelLabel && view.levelLabel[0].toUpperCase() + view.levelLabel.slice(1)} — предварительно, по адаптивной части</p>
          </div>
          <p className="muted">Оси и уровень ещё не посчитаны.</p>
          <button className="btn secondary" type="button" onClick={onRescore} disabled={busy != null}>{busy === 'score' ? 'Считаю…' : 'Рассчитать оценку'}</button>
        </>
      )}
      {s && (
        <ul className="facts-list" style={{ marginTop: 16 }}>
          <li>Грамматика и лексика: верно {s.adaptiveCorrect} из {s.adaptiveTotal}.</li>
          <li>Чтение: {s.readingScore == null ? 'не оценено' : s.readingScore === 100 ? 'оба вопроса верно' : s.readingScore === 50 ? 'один вопрос из двух' : 'оба вопроса неверно'}.</li>
          <li>Письмо: {s.writingWords == null ? 'не сдано' : wordsText(s.writingWords)}.</li>
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" type="button" onClick={onClose} disabled={busy != null} aria-keyshortcuts="Escape">На главную</button>
        <button className="link" type="button" onClick={onRestart} disabled={busy != null}>{baseline ? 'Пройти тест уровня' : 'Пройти тест заново'}</button>
      </div>
      <KeyHints ctx={keyCtx} />
    </section>
  );
}
