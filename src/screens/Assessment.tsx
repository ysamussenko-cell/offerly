import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Assessment as View, type TestItem } from '../api';
import { longDate, plural } from '../text';

const LETTERS = ['A', 'B', 'C', 'D'];
const wordsText = (n: number) => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

type CardProps = { onOpen: () => void; refreshKey?: number };

/** Карточка на главном экране: начать, продолжить или посмотреть предварительный уровень. */
export function TestCard({ onOpen, refreshKey }: CardProps) {
  const [state, setState] = useState<{ loaded: boolean; a: View | null }>({ loaded: false, a: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.assessment().then(r => setState({ loaded: true, a: r.assessment })).catch(() => setState({ loaded: true, a: null })); }, [refreshKey]);

  async function restart() {
    setBusy(true); setError(null);
    try { await api.abandonAssessment(); onOpen(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
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
          <button className="btn" type="button" onClick={onOpen}>Начать тест</button>
        </>
      )}
      {state.loaded && a?.status === 'active' && (
        <>
          <p style={{ marginTop: 0 }}>Тест начат: отвечено {a.answered} из {a.total}.</p>
          <div className="row">
            <button className="btn" type="button" onClick={onOpen} disabled={busy}>Продолжить</button>
            <button className="link" type="button" onClick={restart} disabled={busy}>Начать заново</button>
          </div>
        </>
      )}
      {state.loaded && a?.status === 'finished' && a.level && (
        <>
          <div className="level-row">
            <span className="level-badge">{a.level}</span>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{a.levelLabel && a.levelLabel[0].toUpperCase() + a.levelLabel.slice(1)} — предварительно</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>{a.finishedAt ? longDate(a.finishedAt.slice(0, 10)) : ''}{a.summary ? ` · грамматика и лексика: ${a.summary.adaptiveCorrect} из ${a.summary.adaptiveTotal}` : ''}</p>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 14 }}>Разбор по пяти осям, лестница уровней и примеры ваших ошибок появятся в следующем обновлении.</p>
          <button className="btn secondary" type="button" onClick={onOpen}>Пройти заново</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

type Props = { onClose: () => void };

/** Экран теста: одно задание на экране, прогресс сверху, ответ — кнопками или текстом. */
export default function Assessment({ onClose }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<'start' | 'answer' | null>('start');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [pair, setPair] = useState<(string | null)[]>([null, null]);
  const [text, setText] = useState('');
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    api.startAssessment().then(r => setView(r.assessment)).catch(e => setError(errorText(e))).finally(() => setBusy(null));
  }, []);

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

  // Горячие клавиши на всём экране: 1–4 — вариант, Enter (для выбора) и Ctrl+Enter (везде) — отправить.
  const latest = useRef({ cur, busy, canSend, send });
  latest.current = { cur, busy, canSend, send };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const { cur, busy, canSend, send } = latest.current;
      if (!cur || busy) return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
      if (cur.kind === 'mcq' && !typing && /^[1-4]$/.test(e.key)) { setChoice(LETTERS[Number(e.key) - 1]); e.preventDefault(); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (cur.kind === 'mcq' && !typing))) { e.preventDefault(); if (canSend) send(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (view?.status === 'finished') return <Finished view={view} onClose={onClose} />;

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
          <p className="muted hint">Клавиши 1–4 выбирают вариант, Enter отправляет.</p>
        </>
      )}

      {cur && cur.kind === 'correction' && (
        <>
          <p className="task">{cur.prompt}</p>
          <label className="field">
            <span>В предложении одна ошибка. Исправьте её и ничего больше не меняйте.</span>
            <textarea className="mono" value={text} onChange={e => setText(e.target.value)} rows={3} style={{ minHeight: 80 }} disabled={busy != null} autoFocus />
          </label>
          <p className="muted hint">Ctrl+Enter отправляет.</p>
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
        <button className="btn" type="button" onClick={send} disabled={!canSend}>{busy === 'answer' ? (cur?.position === view?.total ? 'Завершаю…' : 'Принимаю…') : 'Ответить'}</button>
        <button className="link" type="button" onClick={onClose} disabled={busy === 'answer'}>Прервать — продолжу позже</button>
      </div>
      {busy === 'answer' && <p className="muted hint">Следующее задание подбирается из банка; если там пусто, модель напишет его — до минуты.</p>}
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
      <p className="muted hint">Ctrl+Enter отправляет.</p>
    </>
  );
}

function Finished({ view, onClose }: { view: View; onClose: () => void }) {
  const s = view.summary;
  return (
    <section className="card">
      <h2>Тест пройден</h2>
      <div className="level-row">
        <span className="level-badge">{view.level}</span>
        <div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 18 }}>{view.levelLabel && view.levelLabel[0].toUpperCase() + view.levelLabel.slice(1)} — предварительный уровень</p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>По адаптивной части: самый высокий уровень, на котором верна хотя бы половина ответов.</p>
        </div>
      </div>
      {s && (
        <ul className="facts-list">
          <li>Грамматика и лексика: верно {s.adaptiveCorrect} из {s.adaptiveTotal}.</li>
          <li>Чтение: {s.readingScore == null ? 'не оценено' : s.readingScore === 100 ? 'оба вопроса верно' : s.readingScore === 50 ? 'один вопрос из двух' : 'оба вопроса неверно'}.</li>
          <li>Письмо: {s.writingWords == null ? 'не сдано' : `${wordsText(s.writingWords)}, сохранено`}. Оценка по пяти осям — в следующем обновлении.</li>
        </ul>
      )}
      <button className="btn" type="button" onClick={onClose}>На главную</button>
    </section>
  );
}
