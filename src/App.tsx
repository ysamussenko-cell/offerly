import { useEffect, useState } from 'react';
import { api, type Health, type Profile, type User } from './api';
import Login from './screens/Login';
import { InstallButton } from './install';
import { ThemeSwitch } from './ThemeSwitch';
import { OFFLINE_NOTICE, useOnline } from './offline';
import Resume, { ProfileCard } from './screens/Resume';
import Questionnaire, { AnswersCard } from './screens/Questionnaire';
import { BankCard } from './screens/Bank';
import Assessment, { TestCard, type Mode, type TestKind } from './screens/Assessment';
import { CheckpointCard } from './screens/Checkpoint';
import { JournalCard } from './screens/Journal';
import { ProgramCard } from './screens/Program';
import Lesson, { LessonCard } from './screens/Lesson';
import Rehearsal, { RehearsalCard } from './screens/Rehearsal';
import { HomeCard } from './screens/Home';
import { AchievementsCard } from './screens/Achievements';

type Auth = { state: 'loading' } | { state: 'anonymous' } | { state: 'in'; user: User; isNew: boolean };
type ProfileState = { state: 'loading' } | { state: 'ready'; profile: Profile | null };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [profile, setProfile] = useState<ProfileState>({ state: 'loading' });
  const [replacing, setReplacing] = useState(false);
  /** Анкета: 'auto' — открыть сразу после разбора резюме, 'open' — по кнопке, 'closed' — отложена или сохранена. */
  const [survey, setSurvey] = useState<'auto' | 'open' | 'closed'>('auto');
  /** Экран теста уровня или контрольного среза открыт; счётчик — чтобы карточки перечитали состояние после закрытия. */
  const [testing, setTesting] = useState<{ kind: TestKind; mode: Mode } | null>(null);
  const [testRuns, setTestRuns] = useState(0);
  /** Экран дневного занятия открыт. */
  const [lesson, setLesson] = useState(false);
  /** Экран репетиции интервью открыт. */
  const [rehearsal, setRehearsal] = useState(false);
  const online = useOnline();

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false, version: '-', db: 'error', ai: 'error' }));
    api.me().then(r => setAuth({ state: 'in', user: r.user, isNew: false })).catch(() => setAuth({ state: 'anonymous' }));
  }, []);

  useEffect(() => {
    if (auth.state !== 'in') { setProfile({ state: 'loading' }); setReplacing(false); setSurvey('auto'); setTesting(null); setLesson(false); setRehearsal(false); return; }
    api.profile().then(r => setProfile({ state: 'ready', profile: r.profile })).catch(() => setProfile({ state: 'ready', profile: null }));
  }, [auth.state]);

  async function signOut() {
    try { await api.logout(); } finally { setAuth({ state: 'anonymous' }); }
  }

  function gotProfile(p: Profile) { setProfile({ state: 'ready', profile: p }); setReplacing(false); }
  function gotAnswers(p: Profile, u: User) {
    setProfile({ state: 'ready', profile: p });
    setSurvey('closed');
    if (auth.state === 'in') setAuth({ ...auth, user: u });
  }

  const ready = auth.state === 'in' && profile.state === 'ready' ? profile.profile : undefined;
  const showResume = ready !== undefined && (ready === null || replacing);
  // Анкета открывается сама один раз — когда резюме разобрано, а ответов ещё нет; позже — по кнопке.
  const showSurvey = ready != null && !showResume && (survey === 'open' || (survey === 'auto' && ready.analyzed && !ready.onboarded));

  return (
    <main className="wrap">
      <header className="row topbar">
        <div className="row">
          <img src="/icon.svg" width={40} height={40} alt="" />
          <h1 className="brand">Offerly</h1>
        </div>
        {auth.state === 'in' && (
          <div className="row">
            <span className="muted mono who" title={auth.user.email}>{auth.user.email}</span>
            <button className="link" onClick={signOut}>Выйти</button>
          </div>
        )}
      </header>

      {!online && <p className="offline" role="status">{OFFLINE_NOTICE}</p>}

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

      {auth.state === 'in' && profile.state === 'loading' && <section className="card"><p className="muted">Загружаю профиль…</p></section>}

      {auth.state === 'in' && showResume && (
        <Resume profile={ready ?? null} onProfile={gotProfile} onCancel={replacing ? () => setReplacing(false) : undefined} />
      )}

      {auth.state === 'in' && showSurvey && ready && (
        <Questionnaire profile={ready} user={auth.user} onSaved={gotAnswers} onCancel={() => setSurvey('closed')} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && !lesson && !rehearsal && testing && (
        <Assessment kind={testing.kind} mode={testing.mode} onClose={() => { setTesting(null); setTestRuns(n => n + 1); }} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && lesson && (
        <Lesson onClose={() => { setLesson(false); setTestRuns(n => n + 1); }} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && !lesson && rehearsal && (
        <Rehearsal onClose={() => { setRehearsal(false); setTestRuns(n => n + 1); }} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && !testing && !lesson && !rehearsal && (
        <div className="stack" style={{ marginTop: 0 }}>
          {ready.analyzed && <HomeCard refreshKey={testRuns} onOpenDay={f => f === 'rehearsal' ? setRehearsal(true) : f === 'checkpoint' ? setTesting({ kind: 'checkpoint', mode: 'test' }) : setLesson(true)} />}
          {ready.analyzed && <LessonCard refreshKey={testRuns} onOpen={() => setLesson(true)} />}
          {ready.analyzed && <RehearsalCard refreshKey={testRuns} onOpen={() => setRehearsal(true)} />}
          {ready.analyzed && <CheckpointCard refreshKey={testRuns} onOpen={mode => setTesting({ kind: 'checkpoint', mode })} />}
          {ready.analyzed && <ProgramCard refreshKey={testRuns} interviewDate={ready.interviewDate} />}
          {ready.analyzed && <TestCard onOpen={mode => setTesting({ kind: 'placement', mode })} refreshKey={testRuns} />}
          {ready.analyzed && <JournalCard refreshKey={testRuns} />}
          {ready.analyzed && <AchievementsCard refreshKey={testRuns} />}
          {ready.onboarded && <AnswersCard profile={ready} user={auth.user} onEdit={() => setSurvey('open')} />}
          <ProfileCard profile={ready} onReplace={() => setReplacing(true)}
            onRetry={async () => { const r = await api.analyzeResume(); gotProfile(r.profile); }}
            onNext={ready.onboarded ? undefined : () => setSurvey('open')} />
          {ready.analyzed && <BankCard />}
        </div>
      )}

      {auth.state !== 'loading' && (
        <div className="row footer">
          <InstallButton />
          <ThemeSwitch />
          <a className="link" href="/api/health">Состояние сервиса</a>
        </div>
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
