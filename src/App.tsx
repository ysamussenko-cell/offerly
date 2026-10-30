import { useEffect, useState } from 'react';
import { api, type Health, type User } from './api';
import Login from './screens/Login';

type Auth = { state: 'loading' } | { state: 'anonymous' } | { state: 'in'; user: User; isNew: boolean };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [installEvt, setInstallEvt] = useState<any>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false, version: '-', db: 'error', ai: 'error' }));
    api.me().then(r => setAuth({ state: 'in', user: r.user, isNew: false })).catch(() => setAuth({ state: 'anonymous' }));
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  async function signOut() {
    try { await api.logout(); } finally { setAuth({ state: 'anonymous' }); }
  }

  return (
    <main className="wrap">
      <header className="row topbar">
        <div className="row">
          <img src="/icon.svg" width={40} height={40} alt="" />
          <h1 style={{ fontSize: 28, margin: 0 }}>Offerly</h1>
        </div>
        {auth.state === 'in' && (
          <div className="row">
            <span className="muted mono">{auth.user.email}</span>
            <button className="link" onClick={signOut}>Выйти</button>
          </div>
        )}
      </header>

      {auth.state === 'loading' && <section className="card"><p className="muted">Проверяю сессию…</p></section>}

      {auth.state === 'anonymous' && (
        <>
          <section className="card" style={{ marginBottom: 16 }}>
            <h2>Личный тренер английского для собеседования</h2>
            <p className="muted">Загрузите резюме, пройдите короткий тест уровня по своей специальности и занимайтесь по индивидуальной программе 20 минут в день.</p>
          </section>
          <Login onLogin={(user, isNew) => setAuth({ state: 'in', user, isNew })} />
        </>
      )}

      {auth.state === 'in' && (
        <section className="card">
          <h2>{auth.isNew ? 'Учётная запись создана' : 'С возвращением'}</h2>
          <p className="muted">
            {auth.isNew
              ? 'Следующий шаг — резюме: по нему тренер поймёт вашу специальность и подберёт задания. Загрузка появится в ближайшем обновлении.'
              : 'Профиль и программа появятся здесь по мере готовности следующих этапов.'}
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => installEvt?.prompt()} disabled={!installEvt}>Установить приложение</button>
            <a className="btn secondary" href="/api/health">Состояние сервиса</a>
          </div>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Состояние</h3>
        {health ? (
          <ul className="mono" style={{ margin: 0 }}>
            <li>Версия: {health.version}</li>
            <li>База данных: <span className={health.db === 'ok' ? 'ok' : 'bad'}>{health.db}</span></li>
            <li>Workers AI: <span className={health.ai === 'ok' ? 'ok' : 'bad'}>{health.ai}</span></li>
            <li>Почта: <span className={health.mail === 'ok' ? 'ok' : 'bad'}>{health.mail ?? 'missing'}</span></li>
          </ul>
        ) : <p className="muted">Проверяю…</p>}
      </section>
    </main>
  );
}
