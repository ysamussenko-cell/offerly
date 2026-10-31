/**
 * Приложение для Windows (5.2): страница открыта в окне Tauri (desktop/src-tauri). Web Push в WebView2 не работает,
 * поэтому напоминание дня приложение показывает само — нативным уведомлением через plugin:notification, пока окно
 * свёрнуто в трей. Чистые функции (часы в поясе, решение «пора ли») вынесены для тестов; с window и таймерами
 * работают только isDesktop, desktopNotify и startDesktopReminder.
 */

/** Ключ localStorage: дата (в поясе пользователя), за которую напоминание уже показано. */
export const DESKTOP_REMINDED_KEY = 'offerly_desktop_reminded_on';
/** Как часто сверять часы. */
export const CHECK_EVERY_MS = 60_000;
/** Как часто перечитывать время напоминания с сервера (его меняют карточкой или в настройках). */
export const CONFIG_TTL_MS = 60 * 60_000;

/** Окно Tauri: глобальный объект появляется при withGlobalTauri, внутренности — всегда. */
export interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } };
}

/** Страница открыта в приложении для Windows. */
export function isDesktop(w: unknown = typeof window !== 'undefined' ? window : undefined): boolean {
  if (!w || typeof w !== 'object') return false;
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
}

/** Что отдаёт GET /api/push/reminder. */
export interface ReminderInfo {
  at: string; tz: string; localTime: string; today: string; windowMinutes: number; todayDone: boolean;
  reminder: { title: string; body: string };
}

export interface Clock { date: string; minutes: number }

export const minutesOf = (hhmm: string): number => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Дата и минуты от полуночи в поясе пользователя — той же формулой, что у сервера (localClock). Неизвестный пояс — UTC. */
export function clockIn(tz: string, now: Date): Clock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const get = (t: Intl.DateTimeFormatPart['type']) => parts.find(p => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
}

export type ReminderState = 'shown' | 'early' | 'due' | 'late';

/** Пора ли: сегодня ещё не показывали, время наступило и окно (по умолчанию 3 часа) не вышло. Как digestState на сервере. */
export function reminderState(clock: Clock, at: string, remindedOn: string | null, windowMinutes: number): ReminderState {
  if (remindedOn === clock.date) return 'shown';
  const start = minutesOf(at);
  if (clock.minutes < start) return 'early';
  if (clock.minutes >= start + windowMinutes) return 'late';
  return 'due';
}

/** Нативное уведомление через IPC Tauri (plugin:notification). Вне приложения — ошибка. */
export async function desktopNotify(title: string, body: string, w: TauriWindow = window as TauriWindow): Promise<void> {
  const invoke = w.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Уведомления доступны только в приложении для Windows.');
  await invoke('plugin:notification|notify', { options: { title, body } });
}

export interface ReminderDeps {
  /** GET /api/push/reminder. */
  fetchInfo: () => Promise<ReminderInfo>;
  notify: (title: string, body: string) => Promise<void>;
  storage: { get: () => string | null; set: (date: string) => void };
  now?: () => Date;
}

/** Решение по свежему ответу сервера: показать, отметить день как пройденный или подождать. Возвращает, что сделано. */
export async function applyReminder(info: ReminderInfo, deps: ReminderDeps): Promise<ReminderState | 'done' | 'notified'> {
  const st = reminderState({ date: info.today, minutes: minutesOf(info.localTime) }, info.at, deps.storage.get(), info.windowMinutes);
  if (st !== 'due') return st;
  if (info.todayDone) { deps.storage.set(info.today); return 'done'; }
  await deps.notify(info.reminder.title, info.reminder.body);
  deps.storage.set(info.today);
  return 'notified';
}

/** Один шаг планировщика: конфигурация устарела — перечитать и применить; иначе решать по местным часам и ходить на сервер только когда пора. */
export function makeTicker(deps: ReminderDeps) {
  let cfg: { at: string; tz: string; windowMinutes: number; fetchedAt: number } | null = null;
  return async function tick(): Promise<ReminderState | 'done' | 'notified' | 'error' | 'skip'> {
    const now = (deps.now ?? (() => new Date()))();
    try {
      if (!cfg || now.getTime() - cfg.fetchedAt >= CONFIG_TTL_MS) {
        const info = await deps.fetchInfo();
        cfg = { at: info.at, tz: info.tz, windowMinutes: info.windowMinutes, fetchedAt: now.getTime() };
        return await applyReminder(info, deps);
      }
      const st = reminderState(clockIn(cfg.tz, now), cfg.at, deps.storage.get(), cfg.windowMinutes);
      if (st !== 'due') return st === 'shown' ? 'skip' : st;
      return await applyReminder(await deps.fetchInfo(), deps);
    } catch {
      return 'error';
    }
  };
}

const storage = {
  get: (): string | null => { try { return localStorage.getItem(DESKTOP_REMINDED_KEY); } catch { return null; } },
  set: (date: string): void => { try { localStorage.setItem(DESKTOP_REMINDED_KEY, date); } catch { /* приватный режим */ } },
};

/** Запустить напоминания в приложении: сразу и дальше раз в минуту. Возвращает остановку (при выходе из учётной записи). */
export function startDesktopReminder(fetchInfo: () => Promise<ReminderInfo>): () => void {
  const tick = makeTicker({ fetchInfo, notify: desktopNotify, storage });
  void tick();
  const timer = setInterval(() => { void tick(); }, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}

/** Текст карточки «Напоминание» в приложении для Windows. */
export const DESKTOP_PUSH_TEXT = 'В приложении для Windows напоминание показывает само приложение — уведомлением Windows в назначенное время, пока значок Offerly в трее (крестик окна не закрывает приложение). Подписка браузера здесь не нужна.';
