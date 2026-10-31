/** Web Push на клиенте (4.5): проверка поддержки, подписка через PushManager ключом VAPID с сервера, подписи состояния.
 *  Чистые функции вынесены отдельно, чтобы их проверяли тесты; с DOM и браузерными API работают только subscribe/unsubscribe. */
import type { Push } from './api';
import { longDate } from './text';
import { isDesktop, DESKTOP_PUSH_TEXT } from './desktop';

export type PushSupport = 'ok' | 'no_sw' | 'no_push' | 'no_notification' | 'ios_install' | 'insecure' | 'desktop';

/** Пояснения, почему напоминания здесь недоступны — одной строкой, с тем, что сделать. */
export const SUPPORT_TEXT: Record<Exclude<PushSupport, 'ok'>, string> = {
  insecure: 'Напоминания работают только по HTTPS.',
  no_sw: 'Этот браузер не поддерживает service worker — напоминания недоступны.',
  no_push: 'Этот браузер не поддерживает Web Push. На компьютере подойдут Chrome, Edge или Firefox.',
  no_notification: 'Этот браузер не показывает уведомления сайтов.',
  ios_install: 'На iPhone и iPad напоминания приходят только установленному приложению: «Поделиться» → «На экран „Домой“», затем откройте Offerly с экрана «Домой» и включите здесь.',
  desktop: DESKTOP_PUSH_TEXT,
};

export interface SupportEnv {
  ua: string; secure: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean; standalone: boolean;
  /** Страница открыта в приложении для Windows (Tauri) — напоминания показывает оно само. */
  desktop?: boolean;
}

export function supportEnv(): SupportEnv {
  const w = typeof window !== 'undefined' ? window : undefined;
  const n = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    ua: n?.userAgent ?? '',
    secure: Boolean(w?.isSecureContext),
    serviceWorker: Boolean(n && 'serviceWorker' in n),
    pushManager: Boolean(w && 'PushManager' in w),
    notification: Boolean(w && 'Notification' in w),
    standalone: Boolean(w?.matchMedia?.('(display-mode: standalone)').matches || (n as any)?.standalone === true),
    desktop: isDesktop(w),
  };
}

/** Можно ли подписаться здесь. iOS без установки на экран «Домой» — отдельный ответ с инструкцией. */
export function pushSupport(e: SupportEnv): PushSupport {
  if (e.desktop) return 'desktop';
  if (!e.secure) return 'insecure';
  if (!e.serviceWorker) return 'no_sw';
  const ios = /iPhone|iPad|iPod/.test(e.ua);
  if (!e.pushManager || !e.notification) return ios && !e.standalone ? 'ios_install' : !e.pushManager ? 'no_push' : 'no_notification';
  return 'ok';
}

/** Ключ VAPID (base64url) → байты для applicationServerKey. */
export function urlBase64ToUint8Array(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Открытый ключ подписки (ArrayBuffer) → base64url, чтобы сравнить с ключом сервера. */
export function keyToBase64Url(buf: ArrayBuffer | null): string | null {
  if (!buf) return null;
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Строка состояния напоминания: что было сегодня и когда следующее. */
export function pushStatusText(d: Push): string {
  if (!d.enabled) return d.subscriptions.length ? 'Выключено: устройства подписаны, но напоминание не приходит. Включите время — и оно вернётся.' : 'Выключено. Включите — и раз в день, к назначенному времени, придёт короткое напоминание с заданием дня.';
  const next = d.next ? `следующее ${d.next.date === d.today ? 'сегодня' : longDate(d.next.date)} в ${d.next.time}` : '';
  if (d.state === 'sent') {
    if (d.note === 'skipped:done') return `Сегодня напоминание не понадобилось — занятие уже было пройдено; ${next}.`;
    if (d.note === 'skipped:no_subscriptions') return `Сегодня слать было некуда — устройств не было; ${next}.`;
    if (d.note?.startsWith('error:')) return `Сегодня доставить не удалось (${d.note.slice(6)}); ${next}.`;
    if (d.note === 'skipped:late') return `Сегодня окно отправки прошло; ${next}.`;
    return `Сегодняшнее напоминание отправлено; ${next}.`;
  }
  if (d.state === 'early') return `Сегодня ещё не отправлялось; ${next} (в течение ${d.stepMinutes} минут после назначенного времени).`;
  if (d.state === 'due') return `Время наступило — напоминание уйдёт в ближайшие ${d.stepMinutes} минут.`;
  return `Сегодня окно отправки прошло (${d.windowMinutes / 60} часа после назначенного времени); ${next}.`;
}

/** Подпись разрешения на уведомления. */
export function permissionText(p: NotificationPermission | 'unsupported'): string | null {
  if (p === 'denied') return 'Уведомления для этого сайта запрещены в браузере. Разрешите их в настройках сайта (значок слева от адреса) и включите снова.';
  return null;
}

export class PushClientError extends Error {
  constructor(public code: 'denied' | 'unsupported' | 'subscribe_failed', message: string) { super(message); }
}

export const PUSH_CLIENT_ERRORS: Record<PushClientError['code'], string> = {
  denied: 'Разрешение на уведомления не дано. Без него браузер не покажет напоминание.',
  unsupported: 'Этот браузер не умеет Web Push.',
  subscribe_failed: 'Браузер не смог подписаться на уведомления. Проверьте подключение и попробуйте ещё раз.',
};

/** Текущая подписка этого браузера (если есть). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

/** Спросить разрешение и подписаться ключом сервера. Если подписка есть, но на другой ключ, — переподписаться. */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  if (typeof Notification === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) throw new PushClientError('unsupported', PUSH_CLIENT_ERRORS.unsupported);
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushClientError('denied', PUSH_CLIENT_ERRORS.denied);
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (keyToBase64Url(existing.options?.applicationServerKey ?? null) === publicKey) return existing;
    await existing.unsubscribe().catch(() => {});
  }
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
  } catch (e) {
    throw new PushClientError('subscribe_failed', `${PUSH_CLIENT_ERRORS.subscribe_failed} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Снять подписку в браузере; вернуть endpoint, чтобы удалить её и на сервере. */
export async function unsubscribe(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}
