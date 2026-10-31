import { useEffect, useMemo, useState } from 'react';
import { api, type Health, type Profile, type User } from './api';
import Login from './screens/Login';
import { InstallButton } from './install';
import { ThemeSwitch } from './ThemeSwitch';
import { OFFLINE_NOTICE, useOnline } from './offline';
import Resume, { ProfileCard } from './screens/Resume';
import Questionnaire, { AnswersCard } from './screens/Questionnaire';
import { BankCard } from './screens/Bank';
import Assessment, { TestCard, type Mode } from './screens/Assessment';
import { CheckpointCard } from './screens/Checkpoint';
import { JournalCard } from './screens/Journal';
import { ProgramCard } from './screens/Program';
import Lesson, { LessonCard } from './screens/Lesson';
import Rehearsal, { RehearsalCard } from './screens/Rehearsal';
import { HomeCard } from './screens/Home';
import { AchievementsCard } from './screens/Achievements';
import { DigestCard } from './screens/Digest';
import { PushCard } from './screens/Push';
import Settings from './screens/Settings';
import Install from './screens/Install';
import { INSTALL_PATH, screenFor } from './installPage';
import { isDesktop, startDesktopReminder } from './desktop';
import { createScreenHistory, parseScreen, type ScreenName } from './nav';

type Auth = { state: 'loading' } | { state: 'anonymous' } | { state: 'in'; user: User; isNew: boolean };
type ProfileState = { state: 'loading' } | { state: 'ready'; profile: Profile | null };
/** Открытый экран поверх главного: занятие, репетиция, тест уровня или срез (с режимом), настройки. */
type Screen = { name: 'lesson' } | { name: 'rehearsal' } | { name: 'settings' } | { name: 'test' | 'checkpoint'; mode: Mode };

/** Экран по имени из адреса или истории (6.1): тест и срез открываются в режиме прохождения. */
const screenNamed = (name: ScreenName): Screen => (name === 'test' || name === 'checkpoint' ? { name, mode: 'test' } : { name });

export default function App() {
  // Страница установки (5.1) — отдельный путь /install без входа; всё остальное — приложение. Полная перезагрузка по ссылке:
  // оболочка в предкэше service worker, поэтому и без сети страница открывается.
  if (screenFor(window.location.pathname) === 'install') return <Install />;
  return <Shell />;
}

function Shell() {
  const [health, setHealth] = useState<Health | null>(null);
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [profile, setProfile] = useState<ProfileState>({ state: 'loading' });
  const [replacing, setReplacing] = useState(false);
  /** Анкета: 'auto' — открыть сразу после разбора резюме, 'open' — по кнопке, 'closed' — отложена или сохранена. */
  const [survey, setSurvey] = useState<'auto' | 'open' | 'closed'>('auto');
  /** Открытый экран (занятие, репетиция, тест, срез, настройки); счётчик — чтобы карточки перечитали состояние после закрытия. */
  const [screen, setScreen] = useState<Screen | null>(null);
  const [testRuns, setTestRuns] = useState(0);
  const online = useOnline();

  // Телефон (6.1): у открытого экрана своя запись в истории — «назад» возвращает на главный, а не закрывает приложение.
  const nav = useMemo(() => createScreenHistory(window.history, () => { setScreen(null); setTestRuns(n => n + 1); }), []);
  const openScreen = (s: Screen) => { nav.open(s.name); setScreen(s); };
  const closeScreen = () => nav.close();
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const next = nav.onPop(e.state, screen?.name ?? null);
      // «вперёд» после «назад»: занятие, репетицию и настройки открываем снова; тест и срез — только с карточки.
      if (next && !screen && (next === 'lesson' || next === 'rehearsal' || next === 'settings')) setScreen(screenNamed(next));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [nav, screen]);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false, version: '-', db: 'error', ai: 'error' }));
    api.me().then(r => setAuth({ state: 'in', user: r.user, isNew: false })).catch(() => setAuth({ state: 'anonymous' }));
  }, []);

  useEffect(() => {
    if (auth.state !== 'in') { setProfile({ state: 'loading' }); setReplacing(false); setSurvey('auto'); setScreen(null); nav.leave(); return; }
    api.profile().then(r => setProfile({ state: 'ready', profile: r.profile })).catch(() => setProfile({ state: 'ready', profile: null }));
  }, [auth.state]);

  // Ссылка быстрого доступа или уведомление (/?screen=lesson): открыть экран, как только профиль готов; «назад» — на главный.
  const [linked, setLinked] = useState<ScreenName | null>(() => parseScreen(window.location.search));
  useEffect(() => {
    if (!linked || auth.state !== 'in' || profile.state !== 'ready') return;
    setLinked(null);
    if (!profile.profile?.analyzed) return;
    nav.open(linked, { fresh: true });
    setScreen(screenNamed(linked));
  }, [linked, auth.state, profile.state]);

  // Приложение для Windows (5.2): пока пользователь вошёл, страница сама показывает напоминание дня уведомлением Windows.
  useEffect(() => {
    if (auth.state !== 'in' || !isDesktop()) return;
    return startDesktopReminder(api.pushReminder);
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
            {profile.state === 'ready' && profile.profile && <button className="link" onClick={() => (screen?.name === 'settings' ? closeScreen() : openScreen({ name: 'settings' }))} aria-pressed={screen?.name === 'settings'}>Настройки</button>}
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
            <p className="muted" style={{ fontSize: 14, margin: '8px 0 0' }}>Работает в браузере, ставится как приложение на компьютер и телефон — <a className="link" href={INSTALL_PATH}>как установить</a>.</p>
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

      {auth.state === 'in' && ready && !showResume && !showSurvey && screen?.name === 'settings' && (
        <Settings onClose={closeScreen} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && screen && (screen.name === 'test' || screen.name === 'checkpoint') && (
        <Assessment kind={screen.name === 'test' ? 'placement' : 'checkpoint'} mode={screen.mode} onClose={closeScreen} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && screen?.name === 'lesson' && (
        <Lesson onClose={closeScreen} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && screen?.name === 'rehearsal' && (
        <Rehearsal onClose={closeScreen} />
      )}

      {auth.state === 'in' && ready && !showResume && !showSurvey && !screen && (
        <div className="stack" style={{ marginTop: 0 }}>
          {ready.analyzed && <HomeCard refreshKey={testRuns} onOpenDay={f => openScreen(f === 'rehearsal' ? { name: 'rehearsal' } : f === 'checkpoint' ? { name: 'checkpoint', mode: 'test' } : { name: 'lesson' })} />}
          {ready.analyzed && <LessonCard refreshKey={testRuns} onOpen={() => openScreen({ name: 'lesson' })} />}
          {ready.analyzed && <RehearsalCard refreshKey={testRuns} onOpen={() => openScreen({ name: 'rehearsal' })} />}
          {ready.analyzed && <CheckpointCard refreshKey={testRuns} onOpen={mode => openScreen({ name: 'checkpoint', mode })} />}
          {ready.analyzed && <ProgramCard refreshKey={testRuns} interviewDate={ready.interviewDate} />}
          {ready.analyzed && <TestCard onOpen={mode => openScreen({ name: 'test', mode })} refreshKey={testRuns} />}
          {ready.analyzed && <JournalCard refreshKey={testRuns} />}
          {ready.analyzed && <AchievementsCard refreshKey={testRuns} />}
          {ready.analyzed && <DigestCard refreshKey={testRuns} />}
          {ready.analyzed && <PushCard refreshKey={testRuns} />}
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
          <a className="link" href={INSTALL_PATH}>Установка на компьютер и телефон</a>
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
            <li>Push (ключи VAPID): <span className={health.push === 'env' || health.push === 'db' ? 'ok' : 'bad'}>{health.push ?? 'pending'}</span></li>
          </ul>
        ) : <p className="muted">Проверяю…</p>}
      </section>
    </main>
  );
}
