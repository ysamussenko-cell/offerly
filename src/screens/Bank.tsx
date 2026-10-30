import { useEffect, useMemo, useState } from 'react';
import { api, errorText, type BankStat, type BankTopics, type GenerateResult, type Item, type ItemKind, type Level, type ReadingQuestion } from '../api';
import { plural } from '../text';

const LETTERS = ['A', 'B', 'C', 'D'];
const STATUS_LABEL: Record<Item['status'], string> = { verified: 'принято', rejected: 'отклонено', draft: 'не проверено' };

const itemsText = (n: number) => `${n} ${plural(n, 'задание', 'задания', 'заданий')}`;

/** Банк заданий: сводка по уровням и видам, пополнение по теме с проверкой вторым прогоном, просмотр результата. */
export function BankCard() {
  const [meta, setMeta] = useState<BankTopics | null>(null);
  const [stats, setStats] = useState<BankStat[] | null>(null);
  const [level, setLevel] = useState<Level>('B1');
  const [kind, setKind] = useState<ItemKind>('mcq');
  const [topic, setTopic] = useState('articles');
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [showBank, setShowBank] = useState<Item[] | null>(null);

  const refreshStats = () => api.bankStats().then(r => setStats(r.stats)).catch(() => setStats([]));
  useEffect(() => {
    api.bankTopics().then(m => { setMeta(m); setCount(m.defaultCount); }).catch(() => setMeta(null));
    refreshStats();
  }, []);

  /** Принятые задания по уровню и виду; отклонённые — отдельной суммой. */
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    let rejected = 0, verified = 0;
    for (const s of stats ?? []) {
      if (s.status === 'verified') { m.set(`${s.level}|${s.kind}`, (m.get(`${s.level}|${s.kind}`) ?? 0) + s.count); verified += s.count; }
      else if (s.status === 'rejected') rejected += s.count;
    }
    return { m, rejected, verified };
  }, [stats]);

  async function generate() {
    setBusy(true); setError(null); setResult(null); setShowBank(null);
    try {
      const r = await api.generateItems({ kind, level, topic, count });
      setResult(r);
      await refreshStats();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function openBank() {
    setError(null); setResult(null);
    try { setShowBank((await api.bankItems({ level, kind, topic, limit: '20' })).items); } catch (e) { setError(errorText(e)); }
  }

  const levels = meta?.levels ?? ['A2', 'B1', 'B2', 'C1'];
  const kinds = meta?.kinds ?? [];
  const topicLabel = meta?.topics.find(t => t.id === topic)?.label ?? topic;

  return (
    <section className="card">
      <h2>Банк заданий</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Задания для теста уровня пишет модель по вашей специальности, затем второй прогон решает каждое вслепую и оценивает уровень.
        В банк попадают только те, где ключ совпал, уровень подтверждён и изъянов не найдено.
      </p>

      {stats === null ? <p className="muted">Считаю…</p> : (
        <table className="bank">
          <thead><tr><th></th>{kinds.map(k => <th key={k.id}>{k.label}</th>)}</tr></thead>
          <tbody>
            {levels.map(l => (
              <tr key={l}><th className="mono">{l}</th>{kinds.map(k => { const n = grid.m.get(`${l}|${k.id}`) ?? 0; return <td key={k.id} className={n ? 'ok' : 'muted'}>{n}</td>; })}</tr>
            ))}
          </tbody>
        </table>
      )}
      {stats !== null && <p className="muted" style={{ fontSize: 14 }}>Принято: {itemsText(grid.verified)}. Отклонено проверкой: {itemsText(grid.rejected)}.</p>}

      <div className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <label className="field"><span>Уровень</span>
          <select value={level} onChange={e => setLevel(e.target.value as Level)} disabled={busy}>{levels.map(l => <option key={l}>{l}</option>)}</select>
        </label>
        <label className="field"><span>Вид</span>
          <select value={kind} onChange={e => setKind(e.target.value as ItemKind)} disabled={busy}>{kinds.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
        </label>
        <label className="field"><span>Тема</span>
          <select value={topic} onChange={e => setTopic(e.target.value)} disabled={busy}>{(meta?.topics ?? []).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        </label>
        <label className="field"><span>Сколько</span>
          <select value={count} onChange={e => setCount(Number(e.target.value))} disabled={busy}>
            {Array.from({ length: meta?.maxCount ?? 6 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="button" onClick={generate} disabled={busy || !meta}>{busy ? 'Пишу и проверяю…' : 'Пополнить банк'}</button>
        <button className="link" type="button" onClick={openBank} disabled={busy}>Показать имеющиеся</button>
      </div>
      {busy && <p className="muted" style={{ fontSize: 14 }}>Генерация и проверка {itemsText(count)} занимают до минуты.</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>
            {level} · {topicLabel}: принято <span className="ok">{result.verified}</span>, отклонено <span className={result.rejected ? 'bad' : ''}>{result.rejected}</span>
            {result.dropped.length > 0 && <span className="muted"> · не дошло до проверки: {result.dropped.length} ({[...new Set(result.dropped)].join('; ')})</span>}
          </p>
          <ItemList items={result.items} />
        </div>
      )}
      {showBank && (
        <div style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>{level} · {topicLabel} · {kinds.find(k => k.id === kind)?.label}: {showBank.length ? `последние ${itemsText(showBank.length)}` : 'в банке пока пусто'}</p>
          <ItemList items={showBank} />
        </div>
      )}
    </section>
  );
}

function ItemList({ items }: { items: Item[] }) {
  return (
    <ol className="items">
      {items.map(i => (
        <li key={i.id} className={`item ${i.status}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className={`status ${i.status}`}>{STATUS_LABEL[i.status]}</span>
            <span className="muted mono" style={{ fontSize: 12 }}>{i.level}{i.checkedLevel && i.checkedLevel !== i.level ? ` → ${i.checkedLevel}` : ''}</span>
          </div>
          <ItemBody item={i} />
          {i.checkNote && <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>Проверка: {i.checkNote}</p>}
        </li>
      ))}
    </ol>
  );
}

function ItemBody({ item: i }: { item: Item }) {
  if (i.kind === 'mcq') {
    const opts = i.options as string[];
    return (
      <>
        <p className="prompt">{i.prompt}</p>
        <ul className="opts">{opts.map((o, k) => <li key={k} className={LETTERS[k] === i.answer ? 'ok' : ''}><span className="mono">{LETTERS[k]}</span> {o}</li>)}</ul>
        {i.explanation && <p className="expl">{i.explanation}</p>}
      </>
    );
  }
  if (i.kind === 'correction') {
    return (
      <>
        <p className="prompt">{i.prompt}</p>
        <p className="mono" style={{ margin: '4px 0', fontSize: 14 }}><span className="ok">→</span> {i.answer}</p>
        {i.explanation && <p className="expl">{i.explanation}</p>}
      </>
    );
  }
  if (i.kind === 'reading') {
    const qs = i.options as ReadingQuestion[];
    return (
      <>
        <p className="prompt" style={{ fontSize: 14 }}>{i.prompt}</p>
        {qs.map((q, qi) => (
          <div key={qi} style={{ marginTop: 8 }}>
            <p style={{ margin: 0, fontWeight: 500 }}>{q.question}</p>
            <ul className="opts">{q.options.map((o, k) => <li key={k} className={LETTERS[k] === q.answer ? 'ok' : ''}><span className="mono">{LETTERS[k]}</span> {o}</li>)}</ul>
          </div>
        ))}
        {i.explanation && <p className="expl">{i.explanation}</p>}
      </>
    );
  }
  return (
    <>
      <p className="prompt">{i.prompt}</p>
      {i.rubric && <ul className="opts">{i.rubric.map((r, k) => <li key={k}>{r}</li>)}</ul>}
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>Образец: {i.answer}</p>
      {i.explanation && <p className="expl">{i.explanation}</p>}
    </>
  );
}
