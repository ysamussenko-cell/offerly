/** Web Push (концепт §5 «Push»: VAPID для PWA — Android, iOS 16.4+ и десктоп) — одно напоминание в день (4.5).
 *
 *  Браузер подписывается через PushManager и присылает endpoint и ключи (p256dh, auth); они лежат в push_subscriptions —
 *  у пользователя может быть несколько устройств. Время напоминания — push_settings.push_at (HH:MM в поясе пользователя),
 *  отдельно от письма: каналы включаются независимо, а правила те же, что у письма (digest.ts): окно SEND_WINDOW_MINUTES
 *  после назначенного времени, один раз в день (push_settings.sent_on), пропущенный день не досылается. Если занятие дня
 *  уже пройдено к назначенному времени, напоминание не нужно — день помечается skipped:done.
 *
 *  Протокол целиком на WebCrypto, без npm web-push (он тянет node-крипто): подпись VAPID — ECDSA P-256 (RFC 8292),
 *  шифрование тела — ECDH + HKDF + AES-128-GCM по схеме aes128gcm (RFC 8291, RFC 8188). Пара ключей VAPID берётся из
 *  секретов VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, а если их нет — один раз создаётся и хранится в app_settings (ключ
 *  «vapid»), чтобы Pages-приложение и cron-Worker подписывали одними и теми же ключами. Смена ключей обнуляет подписки.
 *
 *  Текст напоминания — из тех же данных, что и письмо (collectDigest): задание дня, карточки к повтору, серия, минуты недели. */
import type { User } from './auth';
import type { Profile } from './profile';
import { collectDigest, digestState, headlineOf, daysText, localClock, SEND_WINDOW_MINUTES, DEFAULT_APP_URL, type ContentStore, type DigestData, type DigestState, type RunOpts } from './digest';

/** Сколько живёт напоминание в push-службе, если устройство офлайн: столько же, сколько окно отправки. */
export const PUSH_TTL_SECONDS = SEND_WINDOW_MINUTES * 60;
/** Срок подписи VAPID (не больше 24 часов по RFC 8292). */
export const VAPID_TTL_SECONDS = 12 * 3600;
/** Размер записи aes128gcm; тело напоминания много меньше. */
export const RECORD_SIZE = 4096;
/** Предел полезной нагрузки push-служб — 4 КБ; напоминание режется заранее. */
export const MAX_PAYLOAD_BYTES = 3600;
/** Тема уведомления: новое напоминание заменяет непрочитанное вчерашнее, а не копится рядом. */
export const PUSH_TOPIC = 'offerly-daily';
export const VAPID_SETTING_KEY = 'vapid';

export interface PushEnv { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string; APP_URL?: string; APP_NAME: string }

export interface PushSubscription {
  id: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null;
  createdAt: string; lastSentAt: string | null; lastError: string | null;
}
export interface PushSetting { userId: string; pushAt: string | null; sentOn: string | null; sentAt: string | null; note: string | null; updatedAt: string }

export interface PushStore {
  listPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  /** Подписка того же браузера (тот же endpoint) обновляет ключи и владельца, а не плодит строки. */
  upsertPushSubscription(sub: PushSubscription): Promise<void>;
  /** true — строка была и удалена. С userId — только своя подписка. */
  deletePushSubscription(endpoint: string, userId?: string): Promise<boolean>;
  markPushSubscription(id: string, patch: { lastSentAt?: string | null; lastError?: string | null }): Promise<void>;
  getPushSetting(userId: string): Promise<PushSetting | null>;
  /** Пользователи с включённым напоминанием. */
  listPushUsers(): Promise<{ user: User; setting: PushSetting }[]>;
  /** Время напоминания: HH:MM или null (выключить). sentOn — отметить сегодня, чтобы первое напоминание пришло завтра. */
  savePushAt(userId: string, pushAt: string | null, sentOn: string | null, nowIso: string): Promise<void>;
  markPush(userId: string, sentOn: string, sentAt: string | null, note: string, nowIso: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  /** Записать значение, если ключа ещё нет; вернуть то, что лежит в базе после этого (своё или чужое, записанное раньше). */
  initSetting(key: string, value: string, nowIso: string): Promise<string>;
}

export type Store = PushStore & ContentStore;

export class PushError extends Error {
  constructor(public code: 'subscription_invalid' | 'vapid_invalid' | 'payload_too_large', message?: string) { super(message ?? code); }
}

// ---------- байты ----------

export const b64url = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const std = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const utf8 = (s: string) => new TextEncoder().encode(s);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const safeDecode = (s: unknown): Uint8Array | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(s)) return null;
  try { return b64url.decode(s); } catch { return null; }
};

// ---------- VAPID ----------

/** Пара ключей VAPID в base64url: открытый — 65 байт без сжатия (0x04‖x‖y), как ждёт PushManager; закрытый — 32 байта d. */
export interface VapidKeys { publicKey: string; privateKey: string }

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { publicKey: b64url.encode(pub), privateKey: jwk.d as string };
}

/** Проверка формы ключей: открытый 65 байт с 0x04 в начале, закрытый 32 байта. */
export function validVapidKeys(k: Partial<VapidKeys> | null | undefined): k is VapidKeys {
  const pub = safeDecode(k?.publicKey), priv = safeDecode(k?.privateKey);
  return Boolean(pub && priv && pub.length === 65 && pub[0] === 4 && priv.length === 32);
}

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  if (!validVapidKeys(keys)) throw new PushError('vapid_invalid');
  const pub = b64url.decode(keys.publicKey);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)), d: keys.privateKey, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Заголовок Authorization по RFC 8292: JWT ES256 с aud = источник push-службы, exp ≤ 24 ч, sub — адрес владельца. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await signingKey(keys);
  const aud = new URL(endpoint).origin;
  const header = b64url.encode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url.encode(utf8(JSON.stringify({ aud, exp: nowSec + VAPID_TTL_SECONDS, sub: subject })));
  const data = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(data)));
  return `vapid t=${data}.${b64url.encode(sig)}, k=${keys.publicKey}`;
}

/** Откуда ключи: секреты окружения, иначе app_settings (создаются один раз при первом обращении). */
export async function vapidKeys(env: PushEnv, store: Pick<PushStore, 'getSetting' | 'initSetting'>, nowIso = new Date().toISOString()): Promise<{ keys: VapidKeys; source: 'env' | 'db' }> {
  if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) {
    const k = { publicKey: env.VAPID_PUBLIC_KEY ?? '', privateKey: env.VAPID_PRIVATE_KEY ?? '' };
    if (!validVapidKeys(k)) throw new PushError('vapid_invalid', 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY заданы неверно: открытый ключ — 65 байт base64url (0x04…), закрытый — 32 байта');
    return { keys: k, source: 'env' };
  }
  const parse = (raw: string | null): VapidKeys | null => { try { const k = raw ? JSON.parse(raw) : null; return validVapidKeys(k) ? { publicKey: k.publicKey, privateKey: k.privateKey } : null; } catch { return null; } };
  const existing = parse(await store.getSetting(VAPID_SETTING_KEY));
  if (existing) return { keys: existing, source: 'db' };
  const fresh = await generateVapidKeys();
  const stored = parse(await store.initSetting(VAPID_SETTING_KEY, JSON.stringify(fresh), nowIso));
  if (!stored) throw new PushError('vapid_invalid', 'в app_settings лежит повреждённая запись vapid');
  return { keys: stored, source: 'db' };
}

/** sub для VAPID: секрет VAPID_SUBJECT (mailto: или https:), иначе адрес приложения. */
export const vapidSubject = (env: Pick<PushEnv, 'VAPID_SUBJECT' | 'APP_URL'>) => env.VAPID_SUBJECT || env.APP_URL || DEFAULT_APP_URL;

// ---------- шифрование aes128gcm (RFC 8291 + RFC 8188) ----------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Ключи подписки из браузера: p256dh — 65 байт, auth — 16 байт; иначе подписка не годится. */
export function parseSubscriptionKeys(p256dh: unknown, auth: unknown): { uaPublic: Uint8Array; authSecret: Uint8Array } | null {
  const uaPublic = safeDecode(p256dh), authSecret = safeDecode(auth);
  if (!uaPublic || !authSecret || uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) return null;
  return { uaPublic, authSecret };
}

/** Тело запроса к push-службе: заголовок (salt ‖ rs ‖ idlen ‖ ключ сервера) и одна запись AES-128-GCM с разделителем 0x02.
 *  Ключи и соль задаются только в тестах — в бою для каждого сообщения новая эфемерная пара ECDH и случайная соль. */
export async function encryptPayload(sub: Pick<PushSubscription, 'p256dh' | 'auth'>, plaintext: Uint8Array, opts: { keyPair?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  const keys = parseSubscriptionKeys(sub.p256dh, sub.auth);
  if (!keys) throw new PushError('subscription_invalid');
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new PushError('payload_too_large');
  const uaKey = await crypto.subtle.importKey('raw', keys.uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = opts.keyPair ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  // workers-types называет параметр $public; в рантайме (и в Node) это обычное поле public
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(keys.authSecret, ecdh, concat(utf8('WebPush: info\0'), keys.uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, record);
}

// ---------- отправка ----------

export type Delivery = { ok: true; status: number } | { ok: false; status: number; gone: boolean; detail: string };

export interface SendOpts { fetchFn?: typeof fetch; nowSec?: number; ttl?: number; topic?: string }

/** Одно сообщение одной подписке. 404/410 — подписки больше нет (gone), её надо удалить. */
export async function sendWebPush(keys: VapidKeys, env: Pick<PushEnv, 'VAPID_SUBJECT' | 'APP_URL'>, sub: Pick<PushSubscription, 'endpoint' | 'p256dh' | 'auth'>, payload: unknown, opts: SendOpts = {}): Promise<Delivery> {
  const fetchFn = opts.fetchFn ?? fetch;
  let body: Uint8Array, authorization: string;
  try {
    body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
    authorization = await vapidAuthorization(keys, sub.endpoint, vapidSubject(env), opts.nowSec);
  } catch (e) {
    return { ok: false, status: 0, gone: e instanceof PushError && e.code === 'subscription_invalid', detail: String(e instanceof Error ? e.message : e) };
  }
  let r: Response;
  try {
    r = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { authorization, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(opts.ttl ?? PUSH_TTL_SECONDS), urgency: 'normal', topic: opts.topic ?? PUSH_TOPIC },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: `fetch: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` };
  }
  if (r.ok) return { ok: true, status: r.status };
  const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  return { ok: false, status: r.status, gone: r.status === 404 || r.status === 410, detail: `${r.status}${text ? ` ${text}` : ''}` };
}

// ---------- напоминание ----------

export interface Reminder { title: string; body: string; url: string; tag: string }

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const cardsShort = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'карточка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'карточки' : 'карточек'}`;

/** Короткий текст уведомления из данных письма: заголовок — задание дня, тело — карточки, серия, минуты недели. */
export function buildReminder(d: DigestData, env: Pick<PushEnv, 'APP_NAME' | 'APP_URL'>): Reminder {
  const appName = env.APP_NAME || 'Offerly';
  const url = env.APP_URL || DEFAULT_APP_URL;
  const v = d.view;
  const parts: string[] = [];
  if (!d.programExists) parts.push('Составьте программу на четыре недели — карточка «Программа»');
  else if (!d.day) parts.push('По программе сегодня свободно');
  else if (d.day.format === 'lesson' && d.day.writingLabel) parts.push(`письмо — ${d.day.writingLabel}`);
  parts.push(d.dueCards > 0 ? `к повтору ${cardsShort(d.dueCards)}` : 'карточек к повтору нет');
  parts.push(`серия ${daysText(v.streak.current)}`);
  if (v.goal.left > 0) parts.push(`неделя: осталось ${v.goal.left} мин`);
  else parts.push('цель недели выполнена');
  if (v.countdown.daysLeft != null && v.countdown.daysLeft >= 0) parts.push(v.countdown.daysLeft === 0 ? 'собеседование сегодня' : `до собеседования ${daysText(v.countdown.daysLeft)}`);
  return { title: `${appName}: ${cap(headlineOf(d))}`, body: cap(parts.join(' · ')), url, tag: PUSH_TOPIC };
}

export interface DeviceOutcome { id: string; ok: boolean; status: number; gone: boolean; detail: string | null }

/** Разослать напоминание на все устройства пользователя: удачные — отметить, исчезнувшие (404/410) — удалить, прочие — записать ошибку. */
export async function pushToUser(keys: VapidKeys, env: PushEnv, store: PushStore, user: User, reminder: Reminder, opts: SendOpts & { now?: () => string } = {}): Promise<DeviceOutcome[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const out: DeviceOutcome[] = [];
  for (const sub of await store.listPushSubscriptions(user.id)) {
    const r = await sendWebPush(keys, env, sub, reminder, opts);
    if (r.ok) { await store.markPushSubscription(sub.id, { lastSentAt: now(), lastError: null }); out.push({ id: sub.id, ok: true, status: r.status, gone: false, detail: null }); continue; }
    if (r.gone) await store.deletePushSubscription(sub.endpoint);
    else await store.markPushSubscription(sub.id, { lastError: r.detail });
    out.push({ id: sub.id, ok: false, status: r.status, gone: r.gone, detail: r.detail });
  }
  return out;
}

export interface PushNowOutcome { reminder: Reminder; devices: DeviceOutcome[]; delivered: number }

/** Прислать напоминание сейчас (кнопка «Проверить на этом устройстве»): день не отмечается — утреннее придёт как обычно. */
export async function sendPushNow(env: PushEnv, store: Store, user: User, profile: Profile | null, opts: RunOpts & SendOpts = {}): Promise<PushNowOutcome> {
  const now = opts.now ?? (() => new Date().toISOString());
  const { keys } = await vapidKeys(env, store, now());
  const reminder = buildReminder(await collectDigest(store, user, profile, { now }), env);
  const devices = await pushToUser(keys, env, store, user, reminder, { ...opts, now });
  return { reminder, devices, delivered: devices.filter(d => d.ok).length };
}

export interface RunReport {
  at: string; checked: number; sent: number; skipped: number; failed: number;
  users: { userId: string; state: DigestState; note: string | null }[];
}

/** Один проход расписания: кому пора — отправить и отметить день; кому поздно или занятие уже пройдено — отметить пропуск. */
export async function runPush(env: PushEnv, store: Store, opts: RunOpts & SendOpts = {}): Promise<RunReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const at = now();
  const report: RunReport = { at, checked: 0, sent: 0, skipped: 0, failed: 0, users: [] };
  let keys: VapidKeys | null = null;
  for (const { user, setting } of await store.listPushUsers()) {
    report.checked++;
    const s = digestState({ notifyAt: setting.pushAt, digestSentOn: setting.sentOn }, user.tz, new Date(at));
    let note: string | null = null;
    if (s.state === 'due') {
      try {
        const subs = await store.listPushSubscriptions(user.id);
        if (subs.length === 0) { note = 'skipped:no_subscriptions'; report.skipped++; }
        else {
          const data = await collectDigest(store, user, await store.getProfile(user.id), { now });
          if (data.todayDone) { note = 'skipped:done'; report.skipped++; }
          else {
            keys ??= (await vapidKeys(env, store, at)).keys;
            const devices = await pushToUser(keys, env, store, user, buildReminder(data, env), { ...opts, now });
            const delivered = devices.filter(d => d.ok).length;
            if (delivered > 0) { note = devices.length > 1 ? `sent:${delivered}/${devices.length}` : 'sent'; report.sent++; }
            else { note = `error:${(devices.map(d => d.detail).filter(Boolean)[0] ?? 'нет доставки').slice(0, 200)}`; report.failed++; }
          }
        }
        await store.markPush(user.id, s.date, note.startsWith('sent') ? now() : null, note, now());
      } catch (e) {
        note = `error:${String(e instanceof Error ? e.message : e).slice(0, 200)}`; report.failed++;
        await store.markPush(user.id, s.date, null, note, now()).catch(() => {});
      }
    } else if (s.state === 'late') {
      note = 'skipped:late'; report.skipped++;
      await store.markPush(user.id, s.date, null, note, now());
    }
    report.users.push({ userId: user.id, state: s.state, note });
  }
  return report;
}

// ---------- подписка из браузера ----------

export interface SubscribeBody { endpoint: string; p256dh: string; auth: string; userAgent: string | null }

/** Тело POST /api/push/subscribe — то, что отдаёт PushSubscription.toJSON(): {endpoint, keys:{p256dh, auth}}. */
export function parseSubscribeBody(raw: unknown): { ok: true; value: SubscribeBody } | { ok: false; reason: 'endpoint' | 'keys' } {
  const b = (raw ?? {}) as Record<string, any>;
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint.trim() : '';
  let u: URL | null = null;
  try { u = new URL(endpoint); } catch { u = null; }
  if (!u || u.protocol !== 'https:' || endpoint.length > 2000) return { ok: false, reason: 'endpoint' };
  const keys = b.keys ?? {};
  if (!parseSubscriptionKeys(keys.p256dh, keys.auth)) return { ok: false, reason: 'keys' };
  const ua = typeof b.userAgent === 'string' ? b.userAgent.trim().slice(0, 300) : '';
  return { ok: true, value: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: ua || null } };
}

/** «Chrome · Windows» из user agent — для списка устройств. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Неизвестное устройство';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  return os ? `${browser} · ${os}` : browser;
}

export const publicSubscription = (s: PushSubscription) => ({ id: s.id, device: deviceLabel(s.userAgent), createdAt: s.createdAt, lastSentAt: s.lastSentAt, lastError: s.lastError });

/** Дата «сегодня» в поясе пользователя, если назначенное время уже прошло (первое напоминание — завтра), иначе null. */
export function sentOnIfPassed(pushAt: string | null, tz: string, now: Date): string | null {
  if (!pushAt) return null;
  const clock = localClock(tz, now);
  const [h, m] = pushAt.split(':').map(Number);
  return clock.minutes >= h * 60 + m ? clock.date : null;
}

// ---------- хранилище D1 ----------

export function d1PushStore(db: D1Database): PushStore {
  const toSub = (r: any): PushSubscription => ({
    id: r.id, userId: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, userAgent: r.user_agent ?? null,
    createdAt: r.created_at, lastSentAt: r.last_sent_at ?? null, lastError: r.last_error ?? null,
  });
  const toSetting = (r: any): PushSetting => ({ userId: r.user_id, pushAt: r.push_at ?? null, sentOn: r.sent_on ?? null, sentAt: r.sent_at ?? null, note: r.note ?? null, updatedAt: r.updated_at });
  return {
    async listPushSubscriptions(userId) {
      const rows = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id').bind(userId).all();
      return (rows.results ?? []).map(toSub);
    },
    async upsertPushSubscription(s) {
      await db.prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_sent_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent), last_error = NULL`,
      ).bind(s.id, s.userId, s.endpoint, s.p256dh, s.auth, s.userAgent, s.createdAt, s.lastSentAt, s.lastError).run();
    },
    async deletePushSubscription(endpoint, userId) {
      const r = userId
        ? await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, userId).run()
        : await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async markPushSubscription(id, patch) {
      const sets: string[] = [], args: unknown[] = [];
      if (patch.lastSentAt !== undefined) { sets.push('last_sent_at = ?'); args.push(patch.lastSentAt); }
      if (patch.lastError !== undefined) { sets.push('last_error = ?'); args.push(patch.lastError); }
      if (!sets.length) return;
      await db.prepare(`UPDATE push_subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
    },
    async getPushSetting(userId) {
      const r = await db.prepare('SELECT * FROM push_settings WHERE user_id = ?').bind(userId).first();
      return r ? toSetting(r) : null;
    },
    async listPushUsers() {
      const rows = await db.prepare(
        `SELECT u.id AS u_id, u.email AS u_email, u.name AS u_name, u.locale AS u_locale, u.tz AS u_tz, s.*
         FROM push_settings s JOIN users u ON u.id = s.user_id WHERE s.push_at IS NOT NULL AND s.push_at <> '' ORDER BY u.id`,
      ).all();
      return (rows.results ?? []).map((r: any) => ({
        user: { id: r.u_id, email: r.u_email, name: r.u_name ?? null, locale: r.u_locale ?? 'ru', tz: r.u_tz ?? 'UTC' } as User,
        setting: toSetting(r),
      }));
    },
    async savePushAt(userId, pushAt, sentOn, nowIso) {
      await db.prepare(
        `INSERT INTO push_settings (user_id, push_at, sent_on, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET push_at = excluded.push_at,
         sent_on = CASE WHEN excluded.sent_on IS NULL THEN push_settings.sent_on ELSE excluded.sent_on END, updated_at = excluded.updated_at`,
      ).bind(userId, pushAt, sentOn, nowIso).run();
    },
    async markPush(userId, sentOn, sentAt, note, nowIso) {
      await db.prepare(
        `INSERT INTO push_settings (user_id, sent_on, sent_at, note, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET sent_on = excluded.sent_on, sent_at = COALESCE(excluded.sent_at, push_settings.sent_at),
         note = excluded.note, updated_at = excluded.updated_at`,
      ).bind(userId, sentOn, sentAt, note, nowIso).run();
    },
    async getSetting(key) {
      const r = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
      return r?.value ?? null;
    },
    async initSetting(key, value, nowIso) {
      await db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, value, nowIso).run();
      const r = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
      return r?.value ?? value;
    },
  };
}
