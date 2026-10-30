import { useEffect, useState } from 'react';
import { applyTheme, autoHint, currentEnv, readMode, resolveTheme, THEME_LABELS, THEME_MODES, writeMode, type ThemeMode } from './theme';

const storage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** Текущий режим и тема; тема пересчитывается при смене системной настройки и раз в минуту (вечер наступает сам). */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => readMode(storage()));
  const [env, setEnv] = useState(currentEnv);
  const theme = resolveTheme(mode, env);

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const refresh = () => setEnv(currentEnv());
    mq?.addEventListener?.('change', refresh);
    const t = setInterval(refresh, 60_000);
    return () => { mq?.removeEventListener?.('change', refresh); clearInterval(t); };
  }, []);

  function setMode(m: ThemeMode) { writeMode(storage(), m); setModeState(m); setEnv(currentEnv()); }
  return { mode, theme, env, setMode };
}

/** Переключатель «Тема: Авто / Светлая / Тёмная» с подписью, что выбрал режим «Авто». */
export function ThemeSwitch() {
  const { mode, theme, env, setMode } = useTheme();
  return (
    <div className="theme-switch">
      <div className="row" role="group" aria-label="Тема оформления">
        <span className="muted" style={{ fontSize: 14 }}>Тема</span>
        {THEME_MODES.map(m => (
          <button key={m} className={'tab' + (mode === m ? ' active' : '')} aria-pressed={mode === m} onClick={() => setMode(m)}>{THEME_LABELS[m]}</button>
        ))}
      </div>
      {mode === 'auto' && <span className="muted" style={{ fontSize: 13 }}>{autoHint(theme, env)}</span>}
    </div>
  );
}
