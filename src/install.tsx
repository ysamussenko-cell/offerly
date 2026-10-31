import { useEffect, useState } from 'react';
import { isStandalone } from './mobile';

type InstallState = 'unknown' | 'installed' | 'prompt' | 'manual';

/** Для какого браузера показывать ручную инструкцию: событие beforeinstallprompt есть только в Chrome/Edge/Samsung. */
export function manualHint(ua = navigator.userAgent): string {
  const ios = /iPhone|iPad|iPod/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|FxiOS/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  if (ios) return 'На iPhone и iPad: кнопка «Поделиться» внизу Safari → «На экран „Домой“».';
  if (safari) return 'В Safari на Mac: меню «Файл» → «Добавить в Dock».';
  if (firefox) return 'Firefox не ставит веб-приложения сам: откройте этот адрес в Chrome или Edge и нажмите «Установить» в адресной строке.';
  return 'Откройте меню браузера (три точки) → «Установить Offerly» или значок установки справа в адресной строке.';
}

export function useInstall() {
  const [state, setState] = useState<InstallState>('unknown');
  const [evt, setEvt] = useState<any>(null);

  useEffect(() => {
    if (isStandalone()) { setState('installed'); return; }
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e); setState('prompt'); };
    const onInstalled = () => { setEvt(null); setState('installed'); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // Chrome шлёт событие через секунду-две после загрузки; если не пришло — показываем ручной путь.
    const t = setTimeout(() => setState(s => (s === 'unknown' ? 'manual' : s)), 2500);
    return () => { clearTimeout(t); window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);

  async function install() {
    if (!evt) return;
    evt.prompt();
    const choice = await evt.userChoice?.catch(() => null);
    if (choice?.outcome === 'accepted') setState('installed');
    setEvt(null);
    if (choice?.outcome !== 'accepted') setState('manual');
  }

  return { state, install };
}

export function InstallButton() {
  const { state, install } = useInstall();
  const [showHint, setShowHint] = useState(false);
  if (state === 'installed') return <span className="muted">Приложение установлено.</span>;
  if (state === 'prompt') return <button className="btn secondary" onClick={install}>Установить приложение</button>;
  return (
    <span className="stack" style={{ gap: 6, marginTop: 0 }}>
      <button className="btn secondary" onClick={() => setShowHint(v => !v)} aria-expanded={showHint}>Установить приложение</button>
      {showHint && <span className="muted" style={{ fontSize: 14 }}>{manualHint()}</span>}
    </span>
  );
}
