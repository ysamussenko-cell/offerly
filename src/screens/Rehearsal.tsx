import { useEffect, useRef, useState } from 'react';
import { api, errorText, rehearsalErrorText, type Achievement, type Rehearsal as View, type RehearsalToday, type Speech } from '../api';
import { longDate, minutesText, plural } from '../text';
import { KeyHints, useHotkeys } from '../KeyHints';
import { submitShortcut } from '../hotkeys';
import { Diff } from './Lesson';
import { MicButton, SpeakButton, useRecorder } from '../Recorder';
import { fluencyTone, mergeTranscript, speechLine } from '../voice';

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const wordsText = (n: number) => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;
const cardsText = (n: number) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

type CardProps = { onOpen: () => void; refreshKey?: number };

/** Карточка «Репетиция интервью» на главном экране: сегодня ли она по программе, начать или продолжить, итог пройденной. */
export function RehearsalCard({ onOpen, refreshKey }: CardProps) {
  const [state, setState] = useState<{ loaded: boolean; t: RehearsalToday | null; error: string | null }>({ loaded: false, t: null, error: null });
  useEffect(() => {
    api.rehearsal().then(t => setState({ loaded: true, t, error: null })).catch(e => setState({ loaded: true, t: null, error: errorText(e) }));
  }, [refreshKey]);

  const t = state.t;
  const r = t?.rehearsal ?? null;
  const d = t?.day ?? null;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Репетиция интервью</h2>
        {t && <span className="muted" style={{ fontSize: 14 }}>{t.scheduled ? 'сегодня по программе' : 'вне плана'}</span>}
      </div>
      {!state.loaded && <p className="muted" style={{ marginTop: 12 }}>Смотрю…</p>}
      {state.error && <p className="error" role="alert" style={{ marginTop: 12 }}>{state.error}</p>}
      {t && d && (
        <p style={{ marginTop: 12 }}>
          <b>{cap(d.formatLabel)}</b>{d.minutes ? <span className="muted"> · {minutesText(d.minutes)}</span> : null}
          {d.reason && <span className="muted" style={{ display: 'block', fontSize: 14 }}>{cap(d.reason)}</span>}
        </p>
      )}
      {t && !r && (
        <>
          <p className="muted" style={{ marginTop: d ? 0 : 12, fontSize: 14 }}>
            Интервьюер задаёт {t.questions} вопросов по целевой позиции: опыт, разбор ошибки из вашей области, объяснение понятия неспециалисту,
            поведенческий вопрос (STAR), мотивация. Отвечаете по-английски — голосом (кнопка-микрофон, расшифровку можно поправить) или текстом,
            {t.words.target[0]}–{t.words.target[1]} слов на вопрос; вопрос можно озвучить голосом интервьюера.
            Разбор — после последнего ответа: пять осей (беглость речи — по голосовым ответам), что сказано хорошо, {t.replacements} фразы заменить (они уйдут в журнал). Можно прервать и продолжить.
          </p>
          {!t.scheduled && <p className="muted" style={{ fontSize: 14 }}>Сегодня по программе не репетиция, но провести её можно и вне плана — в серию и готовность она засчитается как занятие.</p>}
          <button className={t.scheduled ? 'btn' : 'btn secondary'} type="button" onClick={onOpen}>Начать репетицию</button>
          {t.last && <p className="muted hint" style={{ marginTop: 12 }}>Прошлая репетиция {longDate(t.last.date)}: {t.last.result ? `${t.last.result.overall} из 100 · ${t.last.result.level}` : 'без разбора'}.</p>}
        </>
      )}
      {r?.status === 'active' && (
        <>
          <div className="progress" aria-label={`Отвечено ${r.answered} из ${r.total}`}><span style={{ width: `${(r.answered / r.total) * 100}%` }} /></div>
          <p className="muted" style={{ marginTop: -8, fontSize: 14 }}>Отвечено {r.answered} из {r.total}{r.targetRole ? ` · позиция: ${r.targetRole}` : ''}.</p>
          <button className="btn" type="button" onClick={onOpen}>Продолжить репетицию</button>
        </>
      )}
      {r?.status === 'finished' && (
        <>
          <div className="level-row" style={{ marginTop: 4 }}>
            <span className="level-badge">{r.result?.overall ?? '—'}</span>
            <p style={{ margin: 0, fontWeight: 600 }}>{r.result ? `Репетиция пройдена · уровень разговора ${r.result.level}${r.result.newCards ? `, ${cardsText(r.result.newCards)} в журнале` : ''}` : 'Репетиция пройдена, разбор не получился — откройте и запросите снова'}</p>
          </div>
          <button className="btn secondary" type="button" onClick={onOpen}>Открыть разбор</button>
        </>
      )}
    </section>
  );
}

type Props = { onClose: () => void };

/** Экран репетиции: один вопрос интервьюера на экране, ответ текстом; разбора между вопросами нет, как на настоящем
 *  интервью — после последнего ответа экзаменатор разбирает весь разговор. */
export default function Rehearsal({ onClose }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<'start' | 'answer' | 'review' | null>('start');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  /** Запись речи, из которой пришёл текст ответа; её id уходит с ответом — беглость войдёт в оси разбора. */
  const [speech, setSpeech] = useState<Speech | null>(null);
  const [unlocked, setUnlocked] = useState<Achievement[]>([]);
  const startedFor = useRef<string | null>(null);
  const rec = useRecorder(s => { setText(t => mergeTranscript(t, s.text)); setSpeech(s); });

  useEffect(() => {
    api.startRehearsal().then(r => setView(r.rehearsal)).catch(e => setError(errorText(e))).finally(() => setBusy(null));
  }, []);

  const cur = view?.current ?? null;
  useEffect(() => {
    if (!cur || startedFor.current === cur.turnId) return;
    startedFor.current = cur.turnId;
    setText(''); setSpeech(null); setError(null);
  }, [cur]);

  const words = countWords(text);
  const canSend = cur != null && text.trim().length > 0 && busy == null && rec.state === 'idle';
  const isLast = view != null && cur != null && cur.position === view.total;

  async function send() {
    if (!cur || !text.trim() || busy) return;
    setBusy('answer'); setError(null);
    try {
      const r = await api.answerRehearsal(cur.turnId, text.trim(), speech?.id ?? null);
      setView(r.rehearsal);
      if (r.unlocked?.length) setUnlocked(u => [...u, ...r.unlocked.filter(a => !u.some(x => x.code === a.code))]);
    } catch (e) {
      setError(rehearsalErrorText(e));
      if ((e as any)?.code === 'rehearsal_stale') api.rehearsal().then(r => setView(r.rehearsal)).catch(() => {});
    } finally { setBusy(null); }
  }

  /** Разбор заново — когда экзаменатор не ответил. */
  async function review() {
    if (busy) return;
    setBusy('review'); setError(null);
    try { const r = await api.reviewRehearsal(); setView(r.rehearsal); }
    catch (e) { setError(rehearsalErrorText(e)); }
    finally { setBusy(null); }
  }

  /** Другой сценарий: бросить начатую репетицию без ответов и начать заново. */
  async function restart() {
    if (busy) return;
    setBusy('start'); setError(null);
    try { await api.abandonRehearsal(); const r = await api.startRehearsal(); startedFor.current = null; setView(r.rehearsal); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  const finished = view?.status === 'finished';
  const recordable = cur != null && busy == null && rec.available && rec.state !== 'processing';
  const keyCtx = { submit: canSend, cancel: busy !== 'answer' && rec.state === 'idle', busy: busy != null, recordable };
  useHotkeys(keyCtx, { onSubmit: send, onCancel: onClose, onRecordStart: rec.start, onRecordStop: rec.stop });

  if (finished && view) return <Debrief view={view} onClose={onClose} onReview={review} busy={busy === 'review'} error={error} unlocked={unlocked} />;

  const progress = view ? (view.answered / view.total) * 100 : 0;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Репетиция интервью{view?.targetRole ? ` · ${view.targetRole}` : ''}</h2>
        {view && cur && <span className="muted" style={{ fontSize: 14 }}>Вопрос {cur.position} из {view.total} · {cur.kindLabel}</span>}
      </div>
      <div className="progress" aria-label={view ? `Отвечено ${view.answered} из ${view.total}` : undefined}><span style={{ width: `${progress}%` }} /></div>

      {busy === 'start' && <p className="muted">Интервьюер готовит сценарий по вашей позиции и резюме — до минуты.</p>}
      {!cur && busy !== 'start' && !error && <p className="muted">Вопрос не выдан. Вернитесь на главную и начните снова.</p>}

      {cur && (
        <>
          <p className="muted hint" style={{ margin: '0 0 6px' }}>Интервьюер{view?.level ? ` · ваш уровень ${view.level}` : ''}{view && !view.scripted ? ' · встроенный сценарий' : ''}</p>
          <div className="task-row">
            <p className="task" lang="en">{cur.question}</p>
            <SpeakButton text={cur.question} label="Озвучить вопрос" />
          </div>
          <label className="field">
            <span>{kindHint(cur.kind)} Ответ по-английски, {cur.words.min}–{cur.words.max} слов — голосом или текстом, как сказали бы вслух.</span>
            <textarea value={text} onChange={e => { setText(e.target.value); if (!e.target.value.trim()) setSpeech(null); }} rows={8} disabled={busy != null || rec.state !== 'idle'} autoFocus lang="en" spellCheck={false} />
          </label>
          <MicButton rec={rec} disabled={busy != null} what="ответ" />
          {speech && <p className={`speech-line ${fluencyTone(speech.fluency)}`}>С голоса: {speechLine(speech)}. Беглость этой записи войдёт в оси разбора; текст перед отправкой можно поправить.</p>}
          <WordCount n={words} min={cur.words.min} max={cur.words.max} />
        </>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn" type="button" onClick={send} disabled={!canSend} aria-keyshortcuts={submitShortcut(true)}>
          {busy === 'answer' ? (isLast ? 'Разбираю разговор…' : 'Записываю…') : isLast ? 'Ответить и завершить' : 'Ответить'}
        </button>
        <button className="link" type="button" onClick={onClose} disabled={busy === 'answer'} aria-keyshortcuts="Escape">Прервать — продолжу позже</button>
        {view && view.answered === 0 && cur && busy == null && <button className="link" type="button" onClick={restart}>Другой сценарий</button>}
      </div>
      {busy === 'answer' && isLast && <p className="muted hint">Экзаменатор читает все ответы: пять осей, что сказано хорошо, три фразы заменить — до минуты.</p>}
      {cur && <KeyHints ctx={{ ...keyCtx, submit: true, busy: false, recordable: rec.available }} textEntry />}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Подсказка к вопросу по его виду — одной строкой, что ждёт интервьюер. */
function kindHint(kind: View['turns'][number]['kind']): string {
  switch (kind) {
    case 'experience': return 'Конкретные проекты, масштаб, результат.';
    case 'mistake': return 'Что пошло не так, почему и как не допустить снова.';
    case 'explain': return 'Без жаргона, с примером, и почему это важно для дела.';
    case 'star': return 'Ситуация, задача, ваши действия, результат.';
    case 'role': return 'Связь опыта с позицией и план на первые месяцы.';
  }
}

function WordCount({ n, min, max }: { n: number; min: number; max: number }) {
  const tone = n === 0 ? 'muted' : n < 15 ? 'bad' : n < min || n > max ? 'warn' : 'ok';
  return <p className={`hint ${tone}`}>{wordsText(n)} · цель {min}–{max}{n > 0 && n < 15 ? ' · меньше пятнадцати не принимается' : ''}</p>;
}

type DebriefProps = { view: View; onClose: () => void; onReview: () => void; busy: boolean; error: string | null; unlocked: Achievement[] };

/** Разбор репетиции: сводный балл и уровень, пять осей, что сказано хорошо, три фразы заменить, балл и строка по каждому вопросу, разговор целиком. */
function Debrief({ view, onClose, onReview, busy, error, unlocked }: DebriefProps) {
  const [open, setOpen] = useState(false);
  const res = view.result;
  const keyCtx = { cancel: !busy };
  useHotkeys(keyCtx, { onCancel: onClose });
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Разбор репетиции{view.targetRole ? ` · ${view.targetRole}` : ''}</h2>
        <span className="muted" style={{ fontSize: 14 }}>{longDate(view.date)}</span>
      </div>
      {res ? (
        <>
          <div className="level-row" style={{ marginTop: 12 }}>
            <span className="level-badge">{res.overall}</span>
            <p style={{ margin: 0, fontWeight: 600 }}>Сводный балл из 100 — уровень разговора {res.level}{view.day?.minutes ? `, план ${minutesText(view.day.minutes)}` : ''}</p>
          </div>
          <p style={{ marginTop: 0 }}>{res.summary}</p>
          <ul className="axes-mini" style={{ marginTop: 12 }}>
            {res.axes.map(a => (
              <li key={a.id} className={a.score == null ? 'off' : ''}><span>{a.label}</span><b>{a.score ?? '—'}</b></li>
            ))}
          </ul>
          {res.axes.some(a => a.score == null) && <p className="muted hint" style={{ marginTop: -8 }}>Беглость речи считается по голосовым ответам — в этой репетиции все ответы набраны текстом.</p>}
          {view.spoken > 0 && <p className="muted hint" style={{ marginTop: -8 }}>Голосом отвечено на {view.spoken} из {view.total}: беглость — среднее по темпу, паузам и заполнителям этих ответов.</p>}
          {res.strengths.length > 0 && (
            <>
              <h3 className="result-h">Что сказано хорошо</h3>
              <ul className="facts-list" style={{ marginBottom: 0 }}>{res.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
          <h3 className="result-h">{res.replacements.length === 3 ? 'Три фразы заменить' : 'Фразы заменить'}</h3>
          {res.replacements.length === 0 && <p className="muted hint" style={{ marginTop: 0 }}>Экзаменатор не нашёл в ответах фраз, которые стоит заменить.</p>}
          {res.replacements.length > 0 && (
            <ol className="examples">
              {res.replacements.map((e, i) => (
                <li key={i}>
                  {e.topicLabel && <span className="ex-src muted">{e.topicLabel}</span>}
                  <p className="ex-quote mono" lang="en" style={{ marginTop: e.topicLabel ? 6 : 0 }}><Diff from={e.original} to={e.better} side="written" /></p>
                  <p className="ex-fix mono" lang="en"><Diff from={e.original} to={e.better} side="correction" /></p>
                  <p className="ex-note">{e.note}</p>
                </li>
              ))}
            </ol>
          )}
          {res.newCards > 0 && <p className="muted hint">В журнал записано {cardsText(res.newCards)} — повтор с завтрашнего дня в конце занятия.</p>}
          <h3 className="result-h">По вопросам</h3>
          <ul className="axes-mini">
            {view.turns.map(t => (
              <li key={t.turnId}><span>{t.position}. {t.kindLabel}</span><b>{t.score ?? '—'}</b></li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p style={{ marginTop: 12 }}>Все {view.total} ответов записаны, но экзаменатор не вернул разбор{view.reviewNote ? `: ${view.reviewNote}` : ''}.</p>
          <div className="row">
            <button className="btn" type="button" onClick={onReview} disabled={busy}>{busy ? 'Разбираю…' : 'Разобрать снова'}</button>
          </div>
          {busy && <p className="muted hint">Экзаменатор читает все ответы — до минуты.</p>}
        </>
      )}
      {error && <p className="error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
      {unlocked.length > 0 && (
        <div className="unlocked" style={{ marginTop: 16 }}>
          <h3 className="result-h" style={{ marginTop: 0 }}>{unlocked.length === 1 ? 'Новое достижение' : 'Новые достижения'}</h3>
          <ul className="ach-list">
            {unlocked.map(a => (
              <li key={a.code} className="ach on">
                <span className="ach-mark" aria-hidden="true" />
                <div><b>{a.title}</b><span className="muted">{a.description}</span></div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="link" type="button" onClick={() => setOpen(v => !v)} style={{ marginTop: 12 }}>{open ? 'Скрыть разговор' : `Показать разговор (${view.turns.length} ${plural(view.turns.length, 'вопрос', 'вопроса', 'вопросов')})`}</button>
      {open && (
        <div className="stack" style={{ marginTop: 12 }}>
          {view.turns.map(t => (
            <div key={t.turnId} className={`review ${t.score == null ? '' : 'graded'}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b className="verdict">{t.position}. {t.kindLabel}{t.score != null ? ` · ${t.score}` : ''}</b>
                {t.words != null && <span className="muted" style={{ fontSize: 13 }}>{wordsText(t.words)}</span>}
              </div>
              <p className="prompt" lang="en">{t.question}</p>
              {t.answer && <p className="passage" lang="en">{t.answer}</p>}
              {t.speech && <p className={`speech-line ${fluencyTone(t.speech.fluency)}`}>Голосом: {speechLine(t.speech)}.</p>}
              {t.feedback && <p className="review-note">{t.feedback}</p>}
              <p className="muted hint">Сильный ответ: {t.rubric.join('; ')}.</p>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="button" onClick={onClose} aria-keyshortcuts="Escape">На главную</button>
      </div>
      <KeyHints ctx={keyCtx} />
      {view.day && <p className="muted hint">День репетиции отмечен в программе пройденным{res ? `, вклад в готовность — как у занятия с баллом ${res.overall}` : ''}.</p>}
    </section>
  );
}
