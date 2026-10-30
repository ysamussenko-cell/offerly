import { useEffect, useState } from 'react';

type Health = { ok: boolean; version: string; db: 'ok' | 'missing' | 'error'; ai: 'ok' | 'missing' | 'error' };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [installEvt, setInstallEvt] = useState<any>(null);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => setHealth({ ok: false, version: '-', db: 'error', ai: 'error' }));
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  return (
    <main className="wrap">
      <header className="row" style={{ marginBottom: 32 }}>
        <img src="/icon.svg" width={40} height={40} alt="" />
        <h1 style={{ fontSize: 28, margin: 0 }}>Offerly</h1>
      </header>
      <section className="card">
        <h2>Личный тренер английского для собеседования</h2>
        <p className="muted">Загрузите резюме, пройдите короткий тест уровня по своей специальности и занимайтесь по индивидуальной программе 20 минут в день.</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => installEvt?.prompt()} disabled={!installEvt}>Установить приложение</button>
          <a className="btn secondary" href="/api/health">Состояние сервиса</a>
        </div>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h3>Состояние</h3>
        {health ? (
          <ul className="mono" style={{ margin: 0 }}>
            <li>Версия: {health.version}</li>
            <li>База данных: <span className={health.db === 'ok' ? 'ok' : 'bad'}>{health.db}</span></li>
            <li>Workers AI: <span className={health.ai === 'ok' ? 'ok' : 'bad'}>{health.ai}</span></li>
          </ul>
        ) : <p className="muted">Проверяю…</p>}
      </section>
    </main>
  );
}
