import { useEffect, useState } from 'react';
import { api, type Release } from '../api';
import { useInstall } from '../install';
import { ThemeSwitch } from '../ThemeSwitch';
import {
  browserOf, canPromptInstall, installSteps, platformOf, releaseLine, windowsUnavailableText,
  INSTALL_BENEFITS, RELEASE_OFFLINE_TEXT, SMARTSCREEN_NOTE, PLATFORM_LABEL, type Platform,
} from '../installPage';

type ReleaseState = { loaded: false } | { loaded: true; release: Release | null };

/** Страница установки /install (5.1): приложение из браузера на этом устройстве, установщик для Windows, телефон. Открыта без входа. */
export default function Install() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const platform = platformOf(ua, typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0);
  const browser = browserOf(ua);
  return (
    <main className="wrap">
      <header className="row topbar">
        <div className="row">
          <img src="/icon.svg" width={40} height={40} alt="" />
          <h1 className="brand">Offerly</h1>
        </div>
        <a className="link" href="/">Открыть приложение</a>
      </header>
      <div className="stack" style={{ marginTop: 0 }}>
        <section className="card">
          <h2 style={{ margin: 0 }}>Установить Offerly</h2>
          <p className="muted" style={{ margin: '8px 0 0' }}>{INSTALL_BENEFITS} Данные хранятся на сервере — установка на второе устройство ничего не теряет.</p>
        </section>
        <BrowserCard platform={platform} browser={browser} />
        {platform !== 'ios' && platform !== 'android' && <WindowsCard current={platform === 'windows'} />}
        <PhoneCard platform={platform} />
        {(platform === 'ios' || platform === 'android') && <WindowsCard current={false} />}
      </div>
      <div className="row footer">
        <ThemeSwitch />
        <a className="link" href="/api/health">Состояние сервиса</a>
      </div>
    </main>
  );
}

/** Установка как приложения из текущего браузера: кнопка (если браузер умеет) и шаги для этой платформы. */
export function BrowserCard({ platform, browser }: { platform: Platform; browser: ReturnType<typeof browserOf> }) {
  const { state, install } = useInstall();
  const prompt = canPromptInstall(platform, browser);
  const steps = installSteps(platform, browser, state === 'prompt');
  return (
    <section className="card">
      <h3 style={{ margin: 0 }}>Как приложение — на {platform === 'other' ? 'этом устройстве' : PLATFORM_LABEL[platform]}</h3>
      <p className="muted" style={{ fontSize: 14, margin: '6px 0 12px' }}>Устанавливается из браузера за несколько секунд, ничего скачивать не нужно.</p>
      {state === 'installed' && <p className="hint ok" style={{ margin: 0 }}>Приложение уже установлено на этом устройстве — откройте его со значка.</p>}
      {state === 'prompt' && <button className="btn" onClick={install}>Установить приложение</button>}
      {state === 'manual' && prompt && <p className="muted" style={{ fontSize: 14, margin: '0 0 10px' }}>Браузер не предложил установку сам — поставьте вручную:</p>}
      {state !== 'installed' && (
        <ol className="steps">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </section>
  );
}

/** Установщик для Windows из последнего релиза GitHub — ссылка на файл, версия и дата; пока релиза нет — честное «готовится». */
export function WindowsCard({ current }: { current: boolean }) {
  const [st, setSt] = useState<ReleaseState>({ loaded: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setSt({ loaded: false });
    api.release().then(r => { if (alive) setSt({ loaded: true, release: r }); }).catch(() => { if (alive) setSt({ loaded: true, release: null }); });
    return () => { alive = false; };
  }, [tick]);
  return (
    <section className="card">
      <h3 style={{ margin: 0 }}>Для Windows — установщик</h3>
      <p className="muted" style={{ fontSize: 14, margin: '6px 0 12px' }}>
        {current ? 'Отдельная программа с значком в трее, уведомлениями Windows и автообновлением.' : 'Для компьютера с Windows: отдельная программа с значком в трее, уведомлениями и автообновлением.'}
      </p>
      {!st.loaded && <p className="muted" style={{ margin: 0 }}>Смотрю последний релиз…</p>}
      {st.loaded && st.release === null && (
        <div className="stack" style={{ gap: 8, marginTop: 0 }}>
          <p className="muted" style={{ margin: 0 }}>{RELEASE_OFFLINE_TEXT}</p>
          <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setTick(n => n + 1)}>проверить снова</button>
        </div>
      )}
      {st.loaded && st.release && st.release.available && (
        <div className="stack" style={{ gap: 10, marginTop: 0 }}>
          <div className="row">
            <a className="btn" href={st.release.windows.url} download={st.release.windows.name}>Скачать для Windows</a>
            <span className="muted" style={{ fontSize: 14 }}>{releaseLine(st.release)}</span>
          </div>
          <p className="muted mono" style={{ fontSize: 13, margin: 0, wordBreak: 'break-all' }}>{st.release.windows.name}</p>
          {st.release.notes && <p className="muted" style={{ fontSize: 14, margin: 0, whiteSpace: 'pre-wrap' }}>{st.release.notes}</p>}
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>{SMARTSCREEN_NOTE} <a className="link" href={st.release.releasesUrl} target="_blank" rel="noreferrer">Все версии</a></p>
        </div>
      )}
      {st.loaded && st.release && !st.release.available && (
        <div className="stack" style={{ gap: 8, marginTop: 0 }}>
          <p className="muted" style={{ margin: 0 }}>{windowsUnavailableText(st.release)}</p>
          <div className="row">
            <a className="link" href={st.release.releasesUrl} target="_blank" rel="noreferrer">Релизы на GitHub</a>
            {st.release.reason === 'error' && <button className="link" onClick={() => setTick(n => n + 1)}>проверить снова</button>}
          </div>
        </div>
      )}
    </section>
  );
}

/** Телефон: шаги для Android и iPhone — те же, что покажет страница, открытая с телефона. */
export function PhoneCard({ platform }: { platform: Platform }) {
  if (platform === 'ios' || platform === 'android') {
    const other: Platform = platform === 'ios' ? 'android' : 'ios';
    return (
      <section className="card">
        <h3 style={{ margin: '0 0 10px' }}>На {PLATFORM_LABEL[other]}</h3>
        <ol className="steps">{installSteps(other, other === 'ios' ? 'safari' : 'chrome').map((s, i) => <li key={i}>{s}</li>)}</ol>
      </section>
    );
  }
  return (
    <section className="card">
      <h3 style={{ margin: 0 }}>На телефоне</h3>
      <p className="muted" style={{ fontSize: 14, margin: '6px 0 12px' }}>Откройте offerly-c8b.pages.dev на телефоне — та же учётная запись, те же занятия и карточки.</p>
      <div className="phones">
        <div>
          <strong>Android</strong>
          <ol className="steps">{installSteps('android', 'chrome').map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
        <div>
          <strong>iPhone и iPad</strong>
          <ol className="steps">{installSteps('ios', 'safari').map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      </div>
    </section>
  );
}
