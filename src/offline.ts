import { useEffect, useState } from 'react';

export const OFFLINE_NOTICE = 'Нет сети. Экраны открываются из кэша, но ответы и проверка не отправятся — подключитесь и повторите.';

/** Есть ли сеть, по navigator.onLine и событиям online/offline. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}
