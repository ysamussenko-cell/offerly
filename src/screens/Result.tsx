import { useState } from 'react';
import type { AssessmentResult, ErrorExample, Level } from '../api';
import { plural } from '../text';

const pointsText = (n: number) => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;

/** Лестница CEFR: шкала 0–100, четыре ступени с порогами, отметка сводного балла и полоса до следующей ступени. */
export function Ladder({ result }: { result: AssessmentResult }) {
  const { steps, next } = result.ladder;
  const ends = steps.map((s, i) => (i + 1 < steps.length ? steps[i + 1].from : 100));
  return (
    <div className="ladder" role="img" aria-label={`Сводный балл ${result.overall} из 100, уровень ${result.level}`}>
      <div className="ladder-track">
        <span className="ladder-fill" style={{ width: `${result.overall}%` }} />
        {steps.slice(1).map(s => <span key={s.level} className="ladder-tick" style={{ left: `${s.from}%` }} />)}
        <span className="ladder-mark" style={{ left: `${result.overall}%` }}><b>{result.overall}</b></span>
      </div>
      <div className="ladder-steps">
        {steps.map((s, i) => (
          <div key={s.level} className={`ladder-step ${s.level === result.level ? 'current' : ''} ${ends[i] <= result.overall ? 'passed' : ''}`} style={{ left: `${s.from}%`, width: `${ends[i] - s.from}%` }}>
            <b>{s.level}</b><small>{s.label}</small>
          </div>
        ))}
      </div>
      <p className="muted hint" style={{ marginTop: 6 }}>
        {next ? `До ${next.level} — ${pointsText(next.points)}. Порог ступени: ${steps.find(s => s.level === next.level)!.from} из 100.` : 'Верхняя ступень шкалы теста. Дальше — удержание и точность в речи.'}
      </p>
    </div>
  );
}

/** Короткие подписи осей для радара — длинные не помещаются на телефоне. */
const RADAR_LABELS: Record<string, string> = { grammar: 'Грамматика', vocabulary: 'Словарь', coherence: 'Связность', taskResponse: 'Ответ на вопрос', fluency: 'Беглость речи' };

/** Радар пяти осей: одна серия — ученик; кольца — ступени A2–C1; неоценённая ось показана пунктиром без точки. */
export function Radar({ result }: { result: AssessmentResult }) {
  const axes = result.axes;
  const W = 380, H = 300, cx = W / 2, cy = H / 2 + 4, R = 96;
  const n = axes.length;
  const ang = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i: number, r: number) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))] as const;
  const ring = (f: number) => Array.from({ length: n }, (_, i) => pt(i, R * f).join(',')).join(' ');
  const scored = axes.map((a, i) => ({ a, i })).filter(x => x.a.score != null);
  const poly = scored.map(({ a, i }) => pt(i, (R * a.score!) / 100).join(',')).join(' ');
  const label = (i: number) => {
    const [x, y] = pt(i, R + 18);
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
    return { x, y: y + 4, anchor };
  };
  return (
    <figure className="radar" aria-label="Пять осей оценки">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="auto" role="img">
        <title>{axes.map(a => `${a.label}: ${a.score == null ? 'не оценивалась' : a.score}`).join('; ')}</title>
        {[0.25, 0.5, 0.75, 1].map(f => <polygon key={f} points={ring(f)} className="radar-ring" />)}
        {axes.map((a, i) => { const [x, y] = pt(i, R); return <line key={a.id} x1={cx} y1={cy} x2={x} y2={y} className={`radar-axis ${a.score == null ? 'off' : ''}`} />; })}
        {(['A2', 'B1', 'B2', 'C1'] as Level[]).map((l, k) => <text key={l} x={cx + 7} y={cy - R * ((k + 1) / 4) + 12} className="radar-level">{l}</text>)}
        {scored.length >= 3 && <polygon points={poly} className="radar-area" />}
        {scored.length === 2 && <polyline points={poly} className="radar-area" />}
        {scored.map(({ a, i }) => { const [x, y] = pt(i, (R * a.score!) / 100); return <circle key={a.id} cx={x} cy={y} r={4.5} className="radar-dot" />; })}
        {axes.map((a, i) => { const l = label(i); return (
          <text key={a.id} x={l.x} y={l.y} textAnchor={l.anchor as 'start'} className={`radar-label ${a.score == null ? 'off' : ''}`}>
            <tspan>{RADAR_LABELS[a.id] ?? a.label}</tspan>
            <tspan x={l.x} dy={15} className="radar-value">{a.score == null ? 'не оценивалась' : a.score}</tspan>
          </text>
        ); })}
      </svg>
    </figure>
  );
}

const SOURCE_LABELS: Record<ErrorExample['source'], string> = { writing: 'письмо', correction: 'исправление ошибки', mcq: 'выбор варианта', reading: 'чтение' };

/** Три примера собственных ошибок: как написано, как надо, правило одной строкой. */
export function Examples({ examples }: { examples: ErrorExample[] }) {
  if (!examples.length) return <p className="muted" style={{ margin: 0 }}>Ошибок, которые можно показать, в этом тесте нет: все ответы с эталоном совпали, а в письме модель не нашла, что исправить.</p>;
  return (
    <ol className="examples">
      {examples.map((e, i) => (
        <li key={i}>
          <div className="ex-src muted">{SOURCE_LABELS[e.source]}{e.topicLabel ? ` · ${e.topicLabel.toLowerCase()}` : ''}</div>
          <p className="ex-quote mono"><s>{e.quote}</s></p>
          <p className="ex-fix mono">{e.correction}</p>
          {e.note && <p className="ex-note">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

type Props = { result: AssessmentResult; levelLabel: string | null; finishedAt: string | null; onRescore?: () => void; rescoring?: boolean; /** Исходный срез вне приложения: вместо письма и примеров — как он получен. */ baseline?: boolean };

/** Экран результата: уровень, лестница, радар, письмо и три примера ошибок. */
export default function ResultView({ result, levelLabel, onRescore, rescoring, baseline }: Props) {
  const [showRewrite, setShowRewrite] = useState(false);
  const w = result.writing;
  return (
    <div className="result">
      <div className="level-row">
        <span className="level-badge">{result.level}</span>
        <div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 18 }}>{levelLabel ? levelLabel[0].toUpperCase() + levelLabel.slice(1) : ''}{baseline ? ' — ваш уровень на старте' : ' — ваш уровень по тесту'}</p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Сводный балл {result.overall} из 100 по {result.axes.filter(a => a.score != null).length} осям. Беглость речи появится с голосовой репликой.</p>
        </div>
      </div>

      <h3 className="result-h">Лестница уровней</h3>
      <Ladder result={result} />

      <h3 className="result-h">Пять осей</h3>
      <div className="result-grid">
        <Radar result={result} />
        <dl className="axes">
          {result.axes.map(a => (
            <div key={a.id} className={a.score == null ? 'off' : ''}>
              <dt>{a.label}</dt>
              <dd>{a.score == null ? <span className="muted">—</span> : <><span className="axis-bar"><span style={{ width: `${a.score}%` }} /></span><b>{a.score}</b></>}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="muted hint">Шкала общая для всех осей: 0–25 — A2, 25–50 — B1, 50–75 — B2, 75–100 — C1. Грамматика и словарь — по заданиям с эталоном и по письму; связность и ответ на вопрос — по письму и чтению.</p>

      {baseline ? (
        <>
          <h3 className="result-h">Как получен срез</h3>
          <p style={{ margin: 0 }}>{result.scoringNote ?? 'Срез проведён вне приложения.'}</p>
          <p className="muted hint">Стартовые карточки ошибок — в журнале на главном экране. Тест уровня в приложении даст оценку по собственным ответам и заменит срез.</p>
        </>
      ) : (<>
      <h3 className="result-h">Письмо</h3>
      {w ? (
        <>
          <p style={{ margin: '0 0 6px' }}><b>{w.level}</b> · {w.summary}</p>
          <p className="muted hint" style={{ margin: 0 }}>{w.errors === 0 ? 'Модель не нашла ошибок, которые стоит исправить.' : `${w.errors} ${plural(w.errors, 'правка', 'правки', 'правок')} в тексте — ниже, в примерах.`}</p>
          {w.rewrite && (
            <>
              <button className="link" type="button" style={{ marginTop: 8 }} onClick={() => setShowRewrite(v => !v)}>{showRewrite ? 'Скрыть переписанный вариант' : 'Показать переписанный вариант'}</button>
              {showRewrite && <p className="passage" style={{ marginTop: 8 }} lang="en">{w.rewrite}</p>}
            </>
          )}
        </>
      ) : (
        <>
          <p className="error" role="alert">{result.scoringNote ? `Письмо не оценено. ${result.scoringNote}` : 'Письмо не оценено.'}</p>
          {onRescore && <button className="btn secondary" type="button" style={{ marginTop: 10 }} onClick={onRescore} disabled={rescoring}>{rescoring ? 'Оцениваю…' : 'Оценить письмо снова'}</button>}
        </>
      )}

      <h3 className="result-h">Три примера ваших ошибок</h3>
      <Examples examples={result.examples} />
      </>)}
    </div>
  );
}
