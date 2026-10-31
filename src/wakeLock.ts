/**
 * Экран не гаснет во время занятия, теста и репетиции (6.1, телефон): пока ученик читает задание или диктует ответ,
 * телефон не должен заблокироваться через полминуты. Screen Wake Lock API — Chrome на Android, Safari с iOS 16.4.
 * Блокировка снимается системой, когда вкладка уходит в фон, поэтому при возвращении запрашивается заново.
 * Без поддержки или при отказе (экономия заряда) — молча ничего: это удобство, не условие работы.
 * Логика без DOM — окружение передаётся снаружи, хук useWakeLock собирает его из navigator и document.
 */
import { useEffect } from 'react';

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockEnv {
  /** navigator.wakeLock.request('screen'); undefined — API нет. */
  request?: (type: 'screen') => Promise<WakeLockSentinelLike>;
  /** document.visibilityState === 'visible' — запрос в фоне отклоняется. */
  visible: () => boolean;
}

export interface WakeLock {
  /** Запросить блокировку; false — нет API, вкладка в фоне или браузер отказал. */
  acquire(): Promise<boolean>;
  /** Снять блокировку и больше не возобновлять. */
  release(): Promise<void>;
  /** Видимость сменилась: вернулись на экран — запросить снова, если блокировка нужна. */
  onVisibility(): Promise<void>;
  /** Блокировка сейчас удерживается. */
  held(): boolean;
}

export function createWakeLock(env: WakeLockEnv): WakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;

  async function request(): Promise<boolean> {
    if (!env.request || !env.visible()) return false;
    try {
      const s = await env.request('screen');
      if (!wanted) { await s.release().catch(() => {}); return false; }
      sentinel = s;
      return true;
    } catch {
      return false;
    }
  }

  return {
    async acquire() {
      wanted = true;
      if (sentinel && !sentinel.released) return true;
      sentinel = null;
      return request();
    },
    async release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) await s.release().catch(() => {});
    },
    async onVisibility() {
      if (!wanted || !env.visible()) return;
      if (sentinel && !sentinel.released) return;
      sentinel = null;
      await request();
    },
    held: () => wanted && sentinel != null && !sentinel.released,
  };
}

/** Окружение из браузера; без navigator.wakeLock запрос отсутствует. */
export function browserWakeLockEnv(nav: Partial<Navigator> = typeof navigator === 'undefined' ? {} : navigator, doc: Pick<Document, 'visibilityState'> | undefined = typeof document === 'undefined' ? undefined : document): WakeLockEnv {
  const wl = (nav as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
  return {
    request: wl && typeof wl.request === 'function' ? type => wl.request(type) : undefined,
    visible: () => (doc ? doc.visibilityState === 'visible' : true),
  };
}

/** Хук: пока `active`, экран не гаснет; при уходе с экрана или размонтировании блокировка снимается. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const lock = createWakeLock(browserWakeLockEnv());
    void lock.acquire();
    const onVis = () => { void lock.onVisibility(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); void lock.release(); };
  }, [active]);
}
