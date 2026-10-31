import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  b64url, concat, generateVapidKeys, validVapidKeys, vapidAuthorization, vapidKeys, vapidSubject, encryptPayload, parseSubscriptionKeys, sendWebPush,
  buildReminder, pushToUser, sendPushNow, runPush, parseSubscribeBody, deviceLabel, publicSubscription, sentOnIfPassed, d1PushStore, PushError,
  PUSH_TTL_SECONDS, VAPID_TTL_SECONDS, RECORD_SIZE, PUSH_TOPIC, VAPID_SETTING_KEY, type PushEnv, type PushSubscription,
} from '../functions/_lib/push';
import { collectDigest, type DigestData } from '../functions/_lib/digest';
import type { Profile } from '../functions/_lib/profile';
import type { User } from '../functions/_lib/auth';
import type { Assessment } from '../functions/_lib/assessment';
import type { Lesson } from '../functions/_lib/lesson';
import type { ProgramDay } from '../functions/_lib/program';
import type { ErrorCard } from '../functions/_lib/cards';
import { seedStatements, FIRST_USER } from '../functions/_lib/seed';
import { createApp, type Env } from '../functions/_lib/app';
import worker, { makeStore, status, runAll, VERSION } from '../workers/digest/index';
import { memoryStore } from './helpers/memoryStore';
import { freshDb, d1Of } from './helpers/sqliteD1';
import { readFileSync } from 'node:fs';

const TZ = 'Asia/Almaty'; // UTC+5
const TODAY = '2026-11-12'; // четверг
const at = (hhmm: string, date = TODAY) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 10, Number(date.slice(8)), h - 5, m)); };
let seq = 0;

const user = (over: Partial<User> = {}): User => ({ id: 'u1', email: 'y@example.com', name: 'Юрий Самусенко', locale: 'ru', tz: TZ, ...over });
const profile = (over: Partial<Profile> = {}): Profile => ({
  userId: 'u1', specialty: 'инженер', industry: 'энергетика', years: 15, targetRole: 'OpenTrain AI', keywords: [], summary: null, resumeText: null, resumeName: null, resumeAt: null,
  interviewDate: '2026-12-02', interviewFormat: 'ai', minutesPerDay: 25, nativeLanguage: 'русский', onboardedAt: '2026-10-30T00:00:00.000Z', targetLevel: 'C1', weeklyGoalMinutes: null,
  notifyAt: '07:41', digestSentOn: null, updatedAt: '2026-10-30T00:00:00.000Z', ...over,
});
const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  id: 'a1', userId: 'u1', kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z', level: 'B1', currentLevel: 'B1',
  updatedAt: '2026-10-29T03:00:00.000Z', axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: null, scoringNote: null, adaptiveCount: 12, programDayId: null, ...over,
});
const day = (dayDate: string, over: Partial<ProgramDay> = {}): ProgramDay => ({
  id: `d${++seq}`, userId: 'u1', dayDate, position: seq, week: 1, format: 'lesson', topic: 'articles', writing: 'review', reason: 'две карточки в журнале', status: 'planned', minutes: 25, score: null, completedAt: null, generatedAt: '2026-11-01T00:00:00.000Z', updatedAt: null, ...over,
});
const lesson = (dayDate: string, score: number): Lesson => ({
  id: `l${++seq}`, userId: 'u1', programDayId: null, dayDate, topic: 'articles', writing: 'review', level: 'B1', status: 'finished', warmupCount: 5, reviewCount: 0, score,
  startedAt: `${dayDate}T02:00:00.000Z`, finishedAt: `${dayDate}T02:20:00.000Z`, updatedAt: null, bonus: null,
});
const card = (due: string | null, retired = 0): ErrorCard => ({
  id: `c${++seq}`, userId: 'u1', topic: 'articles', rule: 'r', example: 'a', correction: 'b', source: 'seed', origin: null, stability: 1, difficulty: 5, due, reps: 0, lapses: 0, retired, streak: 0, reviewedAt: null, createdAt: '2026-10-30T00:00:00.000Z',
} as unknown as ErrorCard);
const env: PushEnv = { APP_NAME: 'Offerly', APP_URL: 'https://offerly-c8b.pages.dev' };
const utf8 = (s: string) => new TextEncoder().encode(s);
const pushOk = () => vi.fn(async () => new Response(null, { status: 201 }));

/** Подписка браузера: своя пара ECDH и секрет auth — как сделал бы PushManager. */
async function fakeBrowser() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = (over: Partial<PushSubscription> = {}): PushSubscription => ({
    id: `s${++seq}`, userId: 'u1', endpoint: `https://fcm.googleapis.com/fcm/send/${seq}`, p256dh: b64url.encode(pub), auth: b64url.encode(auth), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
    createdAt: '2026-11-01T00:00:00.000Z', lastSentAt: null, lastError: null, ...over,
  });
  /** Расшифровка по RFC 8291/8188 — независимая от encryptPayload запись той же схемы. */
  async function decrypt(body: Uint8Array): Promise<string> {
    const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
    expect(rs).toBe(RECORD_SIZE); expect(idlen).toBe(65);
    const asPub = body.slice(21, 21 + idlen), record = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as any, kp.privateKey, 256));
    const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
    const ikm = await hk(auth, ecdh, concat(utf8('WebPush: info\0'), pub, asPub), 32);
    const cek = await hk(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hk(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), record));
    expect(plain[plain.length - 1]).toBe(2); // разделитель последней записи
    return new TextDecoder().decode(plain.slice(0, -1));
  }
  return { sub, decrypt, pub, auth };
}

afterEach(() => vi.unstubAllGlobals());

describe('VAPID', () => {
  it('base64url: туда и обратно без паддинга', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = b64url.encode(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64url.decode(s)]).toEqual([...bytes]);
    expect(b64url.decode('AQID')).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('generateVapidKeys: открытый 65 байт с 0x04, закрытый 32 байта; validVapidKeys отсеивает мусор', async () => {
    const k = await generateVapidKeys();
    expect(b64url.decode(k.publicKey).length).toBe(65);
    expect(b64url.decode(k.publicKey)[0]).toBe(4);
    expect(b64url.decode(k.privateKey).length).toBe(32);
    expect(validVapidKeys(k)).toBe(true);
    expect(validVapidKeys({ publicKey: k.publicKey, privateKey: 'short' })).toBe(false);
    expect(validVapidKeys({ publicKey: k.privateKey, privateKey: k.privateKey })).toBe(false);
    expect(validVapidKeys(null)).toBe(false);
  });
  it('vapidAuthorization: JWT ES256 с aud = источник push-службы, exp ≤ 24 ч, sub; подпись проверяется открытым ключом', async () => {
    const k = await generateVapidKeys();
    const h = await vapidAuthorization(k, 'https://fcm.googleapis.com/fcm/send/abc', 'https://offerly-c8b.pages.dev', 1_800_000_000);
    const m = /^vapid t=([^,]+), k=(\S+)$/.exec(h)!;
    expect(m[2]).toBe(k.publicKey);
    const [hdr, payload, sig] = m[1].split('.');
    expect(JSON.parse(new TextDecoder().decode(b64url.decode(hdr)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64url.decode(payload)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + VAPID_TTL_SECONDS, sub: 'https://offerly-c8b.pages.dev' });
    expect(VAPID_TTL_SECONDS).toBeLessThanOrEqual(24 * 3600);
    const pub = await crypto.subtle.importKey('raw', b64url.decode(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64url.decode(sig), utf8(`${hdr}.${payload}`))).toBe(true);
    const other = await generateVapidKeys();
    const pub2 = await crypto.subtle.importKey('raw', b64url.decode(other.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub2, b64url.decode(sig), utf8(`${hdr}.${payload}`))).toBe(false);
    await expect(vapidAuthorization({ publicKey: 'x', privateKey: 'y' }, 'https://a.b/c', 'mailto:a@b')).rejects.toBeInstanceOf(PushError);
  });
  it('vapidKeys: из секретов, если заданы (неверные — vapid_invalid); иначе создаются один раз и хранятся в app_settings', async () => {
    const mem = memoryStore();
    const k = await generateVapidKeys();
    expect(await vapidKeys({ ...env, VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey }, mem.store)).toEqual({ keys: k, source: 'env' });
    await expect(vapidKeys({ ...env, VAPID_PUBLIC_KEY: 'bad', VAPID_PRIVATE_KEY: k.privateKey }, mem.store)).rejects.toMatchObject({ code: 'vapid_invalid' });
    expect(mem.settings.size).toBe(0);
    const a = await vapidKeys(env, mem.store, '2026-11-12T00:00:00.000Z');
    expect(a.source).toBe('db');
    expect(validVapidKeys(a.keys)).toBe(true);
    expect(JSON.parse(mem.settings.get(VAPID_SETTING_KEY)!)).toEqual(a.keys);
    const b = await vapidKeys(env, mem.store);
    expect(b.keys).toEqual(a.keys); // второй вызов — те же ключи, не новые
    expect(vapidSubject({ VAPID_SUBJECT: 'mailto:y@example.com' })).toBe('mailto:y@example.com');
    expect(vapidSubject({ APP_URL: 'https://offerly-c8b.pages.dev' })).toBe('https://offerly-c8b.pages.dev');
    expect(vapidSubject({})).toBe('https://offerly-c8b.pages.dev');
  });
});

describe('шифрование aes128gcm', () => {
  it('браузер расшифровывает тело своим ключом; заголовок — соль 16, rs 4096, ключ сервера 65 байт; каждое сообщение — новая соль и пара', async () => {
    const br = await fakeBrowser();
    const s = br.sub();
    const body = await encryptPayload(s, utf8('{"title":"Offerly"}'));
    expect(body.length).toBe(16 + 4 + 1 + 65 + '{"title":"Offerly"}'.length + 1 + 16);
    expect(await br.decrypt(body)).toBe('{"title":"Offerly"}');
    const body2 = await encryptPayload(s, utf8('{"title":"Offerly"}'));
    expect(b64url.encode(body2.slice(0, 16))).not.toBe(b64url.encode(body.slice(0, 16)));
    expect(b64url.encode(body2.slice(21, 86))).not.toBe(b64url.encode(body.slice(21, 86)));
    // кириллица и длинный текст — тоже
    const long = 'Занятие · артикли. '.repeat(40);
    expect(await br.decrypt(await encryptPayload(s, utf8(long)))).toBe(long);
  });
  it('чужой ключ не расшифрует; неверные ключи подписки — subscription_invalid; слишком длинное тело — payload_too_large', async () => {
    const br = await fakeBrowser(), other = await fakeBrowser();
    const body = await encryptPayload(other.sub(), utf8('secret'));
    await expect(br.decrypt(body)).rejects.toThrow();
    await expect(encryptPayload({ p256dh: 'AAAA', auth: br.sub().auth }, utf8('x'))).rejects.toMatchObject({ code: 'subscription_invalid' });
    await expect(encryptPayload({ p256dh: br.sub().p256dh, auth: 'AAAA' }, utf8('x'))).rejects.toMatchObject({ code: 'subscription_invalid' });
    await expect(encryptPayload(br.sub(), new Uint8Array(5000))).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(parseSubscriptionKeys(br.sub().p256dh, br.sub().auth)).not.toBeNull();
    expect(parseSubscriptionKeys('not base64!', br.sub().auth)).toBeNull();
    expect(parseSubscriptionKeys(undefined, undefined)).toBeNull();
  });
  it('sendWebPush: заголовки VAPID, aes128gcm, TTL и Topic; 201 — ok; 410 и 404 — gone; 429 — ошибка без gone; сбой сети — status 0', async () => {
    const br = await fakeBrowser();
    const k = await generateVapidKeys();
    const s = br.sub();
    const fetchFn = pushOk();
    const r = await sendWebPush(k, env, s, { title: 'Offerly', body: 'тест' }, { fetchFn, nowSec: 1_800_000_000 });
    expect(r).toEqual({ ok: true, status: 201 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(s.endpoint);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toMatch(new RegExp(`^vapid t=\\S+, k=${k.publicKey}$`));
    expect(h['content-encoding']).toBe('aes128gcm');
    expect(h['content-type']).toBe('application/octet-stream');
    expect(h.ttl).toBe(String(PUSH_TTL_SECONDS));
    expect(h.topic).toBe(PUSH_TOPIC);
    expect(h.urgency).toBe('normal');
    expect(JSON.parse(await br.decrypt(init.body as Uint8Array))).toEqual({ title: 'Offerly', body: 'тест' });
    expect(await sendWebPush(k, env, s, {}, { fetchFn: vi.fn(async () => new Response('gone', { status: 410 })) })).toEqual({ ok: false, status: 410, gone: true, detail: '410 gone' });
    expect((await sendWebPush(k, env, s, {}, { fetchFn: vi.fn(async () => new Response('', { status: 404 })) }))).toMatchObject({ ok: false, status: 404, gone: true });
    expect(await sendWebPush(k, env, s, {}, { fetchFn: vi.fn(async () => new Response('slow down', { status: 429 })) })).toEqual({ ok: false, status: 429, gone: false, detail: '429 slow down' });
    expect(await sendWebPush(k, env, s, {}, { fetchFn: vi.fn(async () => { throw new Error('ECONNRESET'); }) })).toEqual({ ok: false, status: 0, gone: false, detail: 'fetch: ECONNRESET' });
    expect(await sendWebPush(k, env, { ...s, auth: 'AAAA' }, {}, { fetchFn })).toMatchObject({ ok: false, status: 0, gone: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

/** Данные занятого дня: программа, занятие по теме, 14 карточек, срез 53. */
async function dataFor(opts: { done?: boolean; program?: boolean; cards?: number } = {}): Promise<{ mem: ReturnType<typeof memoryStore>; data: DigestData }> {
  const mem = memoryStore();
  mem.users.push(user());
  mem.profiles.set('u1', profile());
  mem.assessments.push(assessment());
  if (opts.program !== false) {
    mem.programDays.push(day('2026-11-11', { status: 'done', score: 70 }), day(TODAY, opts.done ? { status: 'done', score: 80 } : {}), day('2026-11-13', { topic: 'conditionals' }));
    mem.lessons.push(lesson('2026-11-11', 70));
    if (opts.done) mem.lessons.push(lesson(TODAY, 80));
  }
  for (let i = 0; i < (opts.cards ?? 14); i++) mem.cards.push(card('2026-11-10'));
  const data = await collectDigest(mem.store, user(), profile(), { now: () => at('07:50').toISOString() });
  return { mem, data };
}

describe('напоминание', () => {
  it('заголовок — задание дня, тело — письмо, карточки, серия, неделя, собеседование; ссылка на приложение', async () => {
    const { data } = await dataFor();
    const r = buildReminder(data, env);
    expect(r.title).toBe('Offerly: Занятие · Артикли');
    expect(r.body).toMatch(/^Письмо — /);
    expect(r.body).toContain('к повтору 14 карточек');
    expect(r.body).toMatch(/серия \d+ (день|дня|дней)/);
    expect(r.body).toMatch(/неделя: осталось \d+ мин/);
    expect(r.body).toContain('до собеседования 20 дней');
    expect(r).toMatchObject({ url: 'https://offerly-c8b.pages.dev/?screen=lesson', tag: PUSH_TOPIC }); // клик — сразу занятие (6.1)
    expect(r.body).not.toMatch(/undefined|null|NaN/);
  });
  it('без программы — зовёт составить; без карточек — так и пишет; длина укладывается в полезную нагрузку', async () => {
    const { data } = await dataFor({ program: false, cards: 0 });
    const r = buildReminder(data, { APP_NAME: 'Offerly' });
    expect(r.title).toBe('Offerly: Программы ещё нет');
    expect(r.body).toContain('Составьте программу на четыре недели');
    expect(r.body).toContain('карточек к повтору нет');
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThan(1000);
  });
});

describe('проход расписания', () => {
  it('пора — напоминание на все устройства, день отмечен; второй проход не дублирует; рано — не трогаем', async () => {
    const { mem } = await dataFor();
    const br1 = await fakeBrowser(), br2 = await fakeBrowser();
    mem.pushSubs.push(br1.sub({ id: 'sA' }), br2.sub({ id: 'sB', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }));
    await mem.store.savePushAt('u1', '07:41', null, '2026-11-01T00:00:00.000Z');
    const fetchFn = pushOk();
    const early = await runPush(env, mem.store, { now: () => at('07:30').toISOString(), fetchFn });
    expect(early).toMatchObject({ checked: 1, sent: 0, skipped: 0, failed: 0, users: [{ userId: 'u1', state: 'early', note: null }] });
    expect(fetchFn).not.toHaveBeenCalled();
    const due = await runPush(env, mem.store, { now: () => at('07:50').toISOString(), fetchFn });
    expect(due).toMatchObject({ checked: 1, sent: 1, skipped: 0, failed: 0, users: [{ userId: 'u1', state: 'due', note: 'sent:2/2' }] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(await br1.decrypt((fetchFn.mock.calls[0] as any)[1].body));
    expect(payload.title).toBe('Offerly: Занятие · Артикли');
    expect(payload.url).toBe('https://offerly-c8b.pages.dev/?screen=lesson'); // клик открывает занятие дня (6.1)
    expect(mem.pushSettings.get('u1')).toMatchObject({ sentOn: TODAY, note: 'sent:2/2' });
    expect(mem.pushSettings.get('u1')!.sentAt).toBe(at('07:50').toISOString());
    expect(mem.pushSubs.map(s => s.lastSentAt)).toEqual([at('07:50').toISOString(), at('07:50').toISOString()]);
    expect(mem.settings.has(VAPID_SETTING_KEY)).toBe(true); // ключи создались при первой отправке
    const again = await runPush(env, mem.store, { now: () => at('08:05').toISOString(), fetchFn });
    expect(again.users[0]).toEqual({ userId: 'u1', state: 'sent', note: null });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(mem.pushes).toHaveLength(1);
  });
  it('занятие уже пройдено — skipped:done без отправки; окно прошло — skipped:late; устройств нет — skipped:no_subscriptions', async () => {
    const { mem } = await dataFor({ done: true });
    const br = await fakeBrowser();
    mem.pushSubs.push(br.sub());
    await mem.store.savePushAt('u1', '07:41', null, '2026-11-01T00:00:00.000Z');
    const fetchFn = pushOk();
    const r = await runPush(env, mem.store, { now: () => at('07:50').toISOString(), fetchFn });
    expect(r).toMatchObject({ checked: 1, sent: 0, skipped: 1, users: [{ state: 'due', note: 'skipped:done' }] });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mem.pushSettings.get('u1')).toMatchObject({ sentOn: TODAY, note: 'skipped:done', sentAt: null });
    const late = await runPush(env, mem.store, { now: () => at('12:00', '2026-11-13').toISOString(), fetchFn });
    expect(late.users[0]).toEqual({ userId: 'u1', state: 'late', note: 'skipped:late' });
    mem.pushSubs.length = 0;
    const none = await runPush(env, mem.store, { now: () => at('07:50', '2026-11-14').toISOString(), fetchFn });
    expect(none.users[0]).toEqual({ userId: 'u1', state: 'due', note: 'skipped:no_subscriptions' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('исчезнувшая подписка (410) удаляется, отказ (429) записывается в last_error; ни одной доставки — failed с отметкой дня', async () => {
    const { mem } = await dataFor();
    const br1 = await fakeBrowser(), br2 = await fakeBrowser();
    mem.pushSubs.push(br1.sub({ id: 'gone', endpoint: 'https://push.example/gone' }), br2.sub({ id: 'busy', endpoint: 'https://push.example/busy' }));
    await mem.store.savePushAt('u1', '07:41', null, '2026-11-01T00:00:00.000Z');
    const fetchFn = vi.fn(async (url: string) => new Response(url.endsWith('gone') ? 'unsubscribed' : 'too many', { status: url.endsWith('gone') ? 410 : 429 }));
    const r = await runPush(env, mem.store, { now: () => at('07:50').toISOString(), fetchFn: fetchFn as unknown as typeof fetch });
    expect(r).toMatchObject({ checked: 1, sent: 0, skipped: 0, failed: 1 });
    expect(r.users[0].note).toMatch(/^error:/);
    expect(mem.pushSubs.map(s => s.id)).toEqual(['busy']);
    expect(mem.pushSubs[0].lastError).toBe('429 too many');
    expect(mem.pushSettings.get('u1')).toMatchObject({ sentOn: TODAY, sentAt: null });
    // следующий день: одно устройство принимает — sent (без дроби), ошибка снята
    const ok = pushOk();
    const r2 = await runPush(env, mem.store, { now: () => at('07:50', '2026-11-13').toISOString(), fetchFn: ok });
    expect(r2.users[0].note).toBe('sent');
    expect(mem.pushSubs[0].lastError).toBeNull();
  });
  it('sendPushNow: напоминание уходит сразу, день не отмечается; pushToUser отдаёт исход по устройствам', async () => {
    const { mem } = await dataFor();
    const br = await fakeBrowser();
    mem.pushSubs.push(br.sub({ id: 's1' }));
    const fetchFn = pushOk();
    const r = await sendPushNow(env, mem.store, user(), profile(), { now: () => at('12:00').toISOString(), fetchFn });
    expect(r.delivered).toBe(1);
    expect(r.devices).toEqual([{ id: 's1', ok: true, status: 201, gone: false, detail: null }]);
    expect(r.reminder.title).toBe('Offerly: Занятие · Артикли');
    expect(mem.pushSettings.get('u1')).toBeUndefined();
    expect(mem.pushes).toHaveLength(0);
    const k = await generateVapidKeys();
    const out = await pushToUser(k, env, mem.store, user(), r.reminder, { fetchFn: vi.fn(async () => new Response('x', { status: 400 })) });
    expect(out).toEqual([{ id: 's1', ok: false, status: 400, gone: false, detail: '400 x' }]);
  });
});

describe('подписка и устройства', () => {
  it('parseSubscribeBody: как отдаёт PushSubscription.toJSON(); http, мусорные ключи и пустое тело — отказ', async () => {
    const br = await fakeBrowser();
    const s = br.sub();
    const ok = parseSubscribeBody({ endpoint: ` ${s.endpoint} `, keys: { p256dh: s.p256dh, auth: s.auth }, userAgent: 'UA' });
    expect(ok).toEqual({ ok: true, value: { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, userAgent: 'UA' } });
    expect(parseSubscribeBody({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })).toMatchObject({ ok: true, value: { userAgent: null } });
    expect(parseSubscribeBody({ endpoint: 'http://push.example/x', keys: { p256dh: s.p256dh, auth: s.auth } })).toEqual({ ok: false, reason: 'endpoint' });
    expect(parseSubscribeBody({ endpoint: s.endpoint, keys: { p256dh: 'AAAA', auth: s.auth } })).toEqual({ ok: false, reason: 'keys' });
    expect(parseSubscribeBody({ endpoint: s.endpoint })).toEqual({ ok: false, reason: 'keys' });
    expect(parseSubscribeBody(null)).toEqual({ ok: false, reason: 'endpoint' });
  });
  it('deviceLabel и publicSubscription: браузер · система, без endpoint и ключей', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome · Windows');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Edge · Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Chrome · Android');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox · Linux');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15')).toBe('Safari · macOS');
    expect(deviceLabel(null)).toBe('Неизвестное устройство');
    const pub = publicSubscription({ id: 's1', userId: 'u1', endpoint: 'https://push.example/secret', p256dh: 'p', auth: 'a', userAgent: 'Chrome/130 Windows', createdAt: 'c', lastSentAt: null, lastError: '410' });
    expect(pub).toEqual({ id: 's1', device: 'Chrome · Windows', createdAt: 'c', lastSentAt: null, lastError: '410' });
    expect(JSON.stringify(pub)).not.toContain('secret');
  });
  it('sentOnIfPassed: назначенное время прошло — сегодняшняя дата (первое напоминание завтра), иначе null', () => {
    expect(sentOnIfPassed('07:41', TZ, at('07:40'))).toBeNull();
    expect(sentOnIfPassed('07:41', TZ, at('07:41'))).toBe(TODAY);
    expect(sentOnIfPassed(null, TZ, at('12:00'))).toBeNull();
  });
});

describe('API', () => {
  const appEnv = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1', APP_URL: 'https://offerly-c8b.pages.dev' } as unknown as Env;
  async function login(mem: ReturnType<typeof memoryStore>, app: ReturnType<typeof createApp>) {
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, appEnv);
    const r1 = await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com' }) });
    const { code } = await r1.json() as any;
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com', code }) });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const json = (path: string, method: string, body: unknown) => call(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { call, cookie, json, uid: mem.users[mem.users.length - 1].id };
  }
  it('без cookie — 401 на всех маршрутах; GET отдаёт открытый ключ VAPID (создан и сохранён), состояние off, устройств нет', async () => {
    const mem = memoryStore();
    const app = createApp('test', () => mem.store);
    for (const [path, method] of [['/push', 'GET'], ['/push', 'PUT'], ['/push/subscribe', 'POST'], ['/push/subscribe', 'DELETE'], ['/push/send', 'POST']] as const) {
      expect((await app.request(`https://offerly.test/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }, appEnv)).status).toBe(401);
    }
    const { call, cookie } = await login(mem, app);
    const g = await call('/push', { headers: { cookie } });
    expect(g.status).toBe(200);
    const j: any = await g.json();
    expect(j).toMatchObject({ ok: true, enabled: false, pushAt: null, state: 'off', next: null, subscriptions: [], keySource: 'db', defaultAt: '07:30', stepMinutes: 15 });
    expect(b64url.decode(j.publicKey).length).toBe(65);
    expect(JSON.stringify(j)).not.toContain('privateKey');
    expect(JSON.parse(mem.settings.get(VAPID_SETTING_KEY)!).publicKey).toBe(j.publicKey);
    // health показывает, откуда ключи
    const h: any = await (await app.request('https://offerly.test/api/health', {}, { ...appEnv, DB: { prepare: () => ({ first: async () => 1 }) } } as any)).json();
    expect(h.push).toBe('db');
    expect(((await (await app.request('https://offerly.test/api/health', {}, { ...appEnv, VAPID_PRIVATE_KEY: 'x' } as any)).json()) as any).push).toBe('env');
  });
  it('подписка включает напоминание на время письма (или по умолчанию), повторная подписка того же браузера не плодит строк, своё время — PUT, отписка последнего устройства выключает', async () => {
    const mem = memoryStore();
    const app = createApp('test', () => mem.store);
    const { call, cookie, json, uid } = await login(mem, app);
    await mem.store.saveNotifyAt(uid, '07:41', null, '2026-11-01T00:00:00.000Z');
    const br = await fakeBrowser();
    const s = br.sub();
    const bad = await json('/push/subscribe', 'POST', { endpoint: 'http://x', keys: { p256dh: s.p256dh, auth: s.auth } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'push_invalid', reason: 'endpoint' });
    const badTime = await json('/push/subscribe', 'POST', { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }, pushAt: '25:00' });
    expect(badTime.status).toBe(400);
    expect(await badTime.json()).toEqual({ ok: false, error: 'notify_invalid', reason: 'format' });
    const ok = await json('/push/subscribe', 'POST', { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36' });
    expect(ok.status).toBe(200);
    const j: any = await ok.json();
    expect(j).toMatchObject({ ok: true, enabled: true, pushAt: '07:41' });
    expect(j.subscriptions).toHaveLength(1);
    expect(j.subscriptions[0]).toMatchObject({ device: 'Chrome · Windows', lastSentAt: null, lastError: null });
    expect(JSON.stringify(j)).not.toContain(s.endpoint);
    const again = await json('/push/subscribe', 'POST', { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
    expect(((await again.json()) as any).subscriptions).toHaveLength(1);
    expect(mem.pushSubs).toHaveLength(1);
    expect(mem.pushSubs[0].id).toBe(j.subscriptions[0].id);
    // второе устройство с явным временем — время меняется
    const s2 = (await fakeBrowser()).sub();
    const two: any = await (await json('/push/subscribe', 'POST', { endpoint: s2.endpoint, keys: { p256dh: s2.p256dh, auth: s2.auth }, pushAt: '8:15' })).json();
    expect(two).toMatchObject({ pushAt: '08:15' });
    expect(two.subscriptions).toHaveLength(2);
    // PUT: переставить и выключить (подписки остаются), мусор — 400
    expect(((await (await json('/push', 'PUT', { pushAt: '6:05' })).json()) as any).pushAt).toBe('06:05');
    expect((await json('/push', 'PUT', { pushAt: 'утром' })).status).toBe(400);
    const off: any = await (await json('/push', 'PUT', { pushAt: null })).json();
    expect(off).toMatchObject({ enabled: false, pushAt: null, state: 'off' });
    expect(off.subscriptions).toHaveLength(2);
    // отписка: чужой endpoint — removed false; свои — по одному; последняя выключает напоминание
    expect(((await (await json('/push', 'PUT', { pushAt: '07:00' })).json()) as any).enabled).toBe(true);
    expect((await json('/push/subscribe', 'DELETE', {})).status).toBe(400);
    const foreign: any = await (await json('/push/subscribe', 'DELETE', { endpoint: 'https://push.example/other' })).json();
    expect(foreign).toMatchObject({ ok: true, removed: false, enabled: true });
    const d1: any = await (await json('/push/subscribe', 'DELETE', { endpoint: s.endpoint })).json();
    expect(d1).toMatchObject({ removed: true, enabled: true });
    expect(d1.subscriptions).toHaveLength(1);
    const d2: any = await (await json('/push/subscribe', 'DELETE', { endpoint: s2.endpoint })).json();
    expect(d2).toMatchObject({ removed: true, enabled: false, pushAt: null, subscriptions: [] });
    // без времени письма подписка включает время по умолчанию
    const mem2 = memoryStore();
    const app2 = createApp('test', () => mem2.store);
    const l2 = await login(mem2, app2);
    const def: any = await (await l2.json('/push/subscribe', 'POST', { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })).json();
    expect(def.pushAt).toBe('07:30');
    expect(call).toBeDefined();
  });
  it('POST /push/send: устройств нет — 404; доставка — ok с исходом по устройствам; все отказали — 502', async () => {
    const mem = memoryStore();
    const app = createApp('test', () => mem.store);
    const { call, cookie, json } = await login(mem, app);
    const none = await call('/push/send', { method: 'POST', headers: { cookie } });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ ok: false, error: 'push_no_subscriptions' });
    const br = await fakeBrowser();
    const s = br.sub();
    await json('/push/subscribe', 'POST', { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
    const fetchMock = pushOk();
    vi.stubGlobal('fetch', fetchMock);
    const ok = await call('/push/send', { method: 'POST', headers: { cookie } });
    expect(ok.status).toBe(200);
    const j: any = await ok.json();
    expect(j).toMatchObject({ ok: true, delivered: 1 });
    expect(j.reminder.title).toMatch(/^Offerly: /);
    expect(j.devices[0]).toMatchObject({ ok: true, status: 201 });
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(s.endpoint);
    expect(JSON.parse(await br.decrypt((fetchMock.mock.calls[0] as any)[1].body)).title).toBe(j.reminder.title);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const bad = await call('/push/send', { method: 'POST', headers: { cookie } });
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ ok: false, error: 'push_failed' });
    expect(mem.pushSubs[0].lastError).toBe('403 nope');
  });
});

describe('D1 и Worker', () => {
  it('миграция 0018 — только новые таблицы; d1PushStore: подписки, настройка, отметки, app_settings по настоящему SQL', async () => {
    const sql = readFileSync('migrations/0018_push.sql', 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS push_subscriptions/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS push_settings/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_settings/);
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE|ALTER/);
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email, name, tz) VALUES ('u1', 'y@example.com', 'Юрий', 'Asia/Almaty'), ('u2', 'z@example.com', NULL, 'Europe/Moscow')`);
    const store = d1PushStore(d1Of(db));
    const br = await fakeBrowser();
    const s = br.sub({ id: 's1', endpoint: 'https://push.example/1' });
    await store.upsertPushSubscription(s);
    await store.upsertPushSubscription({ ...s, id: 's1b', p256dh: br.sub().p256dh, userAgent: null }); // тот же endpoint — обновление, не вторая строка
    await store.upsertPushSubscription(br.sub({ id: 's2', endpoint: 'https://push.example/2', userId: 'u2' }));
    const list = await store.listPushSubscriptions('u1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', endpoint: 'https://push.example/1', userAgent: s.userAgent, lastSentAt: null, lastError: null });
    await store.markPushSubscription('s1', { lastError: '429 busy' });
    expect((await store.listPushSubscriptions('u1'))[0].lastError).toBe('429 busy');
    await store.markPushSubscription('s1', { lastSentAt: '2026-11-12T02:50:00.000Z', lastError: null });
    expect((await store.listPushSubscriptions('u1'))[0]).toMatchObject({ lastSentAt: '2026-11-12T02:50:00.000Z', lastError: null });
    expect(await store.deletePushSubscription('https://push.example/2', 'u1')).toBe(false); // чужая
    expect(await store.deletePushSubscription('https://push.example/2')).toBe(true);
    expect(await store.listPushSubscriptions('u2')).toEqual([]);
    // настройка
    expect(await store.getPushSetting('u1')).toBeNull();
    expect(await store.listPushUsers()).toEqual([]);
    await store.savePushAt('u1', '07:41', null, '2026-11-12T00:00:00.000Z');
    await store.savePushAt('u2', '09:00', '2026-11-12', '2026-11-12T00:00:00.000Z');
    const users = await store.listPushUsers();
    expect(users.map(x => [x.user.id, x.user.tz, x.user.name, x.setting.pushAt, x.setting.sentOn])).toEqual([['u1', 'Asia/Almaty', 'Юрий', '07:41', null], ['u2', 'Europe/Moscow', null, '09:00', '2026-11-12']]);
    await store.markPush('u1', '2026-11-12', '2026-11-12T02:45:00.000Z', 'sent', '2026-11-12T02:45:00.000Z');
    expect(await store.getPushSetting('u1')).toMatchObject({ pushAt: '07:41', sentOn: '2026-11-12', sentAt: '2026-11-12T02:45:00.000Z', note: 'sent' });
    await store.markPush('u1', '2026-11-13', null, 'skipped:late', '2026-11-13T10:00:00.000Z');
    expect(await store.getPushSetting('u1')).toMatchObject({ sentOn: '2026-11-13', sentAt: '2026-11-12T02:45:00.000Z', note: 'skipped:late' });
    await store.savePushAt('u1', '08:00', null, '2026-11-13T11:00:00.000Z');
    expect(await store.getPushSetting('u1')).toMatchObject({ pushAt: '08:00', sentOn: '2026-11-13' });
    await store.savePushAt('u1', null, null, '2026-11-13T11:00:00.000Z');
    expect((await store.listPushUsers()).map(x => x.user.id)).toEqual(['u2']);
    // app_settings: первая запись побеждает
    expect(await store.getSetting('vapid')).toBeNull();
    expect(await store.initSetting('vapid', 'first', '2026-11-12T00:00:00.000Z')).toBe('first');
    expect(await store.initSetting('vapid', 'second', '2026-11-12T00:00:01.000Z')).toBe('first');
    expect(await store.getSetting('vapid')).toBe('first');
  });
  it('Worker на seed первого пользователя: напоминание Юрию в 07:50 Алматы по настоящему SQL, статус с push без адресов, /run даёт оба отчёта', async () => {
    const db = freshDb();
    for (const s of seedStatements()) db.exec(s);
    const wenv = { DB: d1Of(db), APP_NAME: 'Offerly', RESEND_API_KEY: 'k', MAIL_FROM: 'Offerly <onboarding@resend.dev>', APP_URL: 'https://offerly-c8b.pages.dev' };
    const store = makeStore(wenv);
    const br = await fakeBrowser();
    const uid = (db.prepare('SELECT id FROM users WHERE email = ?').get(FIRST_USER.email) as any).id as string;
    await store.upsertPushSubscription(br.sub({ id: 'sy', userId: uid, endpoint: 'https://push.example/yuriy' }));
    await store.savePushAt(uid, '07:41', null, '2026-11-01T00:00:00.000Z');
    const s0 = await status(wenv, new Date('2026-11-02T02:30:00.000Z'));
    expect(s0).toMatchObject({ ok: true, version: VERSION, push: { vapid: 'pending', users: 1, states: { early: 1 } } });
    const fetchFn = vi.fn(async (url: string) => new Response(null, { status: url.includes('push.example') ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const r: any = await runAll(wenv, store);
    expect(r.digest).toMatchObject({ checked: 1 });
    expect(r.push).toMatchObject({ checked: 1 });
    // время сейчас — настоящее, поэтому исход зависит от часов; проверяем прогон в заданный момент напрямую
    const fixed = vi.fn(async () => new Response(null, { status: 201 }));
    db.exec(`UPDATE push_settings SET sent_on = NULL, note = NULL`);
    const rp = await (await import('../functions/_lib/push')).runPush(wenv, store, { now: () => '2026-11-02T02:50:00.000Z', fetchFn: fixed });
    expect(rp).toMatchObject({ checked: 1, sent: 1, users: [{ userId: uid, state: 'due', note: 'sent' }] });
    const payload = JSON.parse(await br.decrypt((fixed.mock.calls[0] as any)[1].body));
    expect(payload.title).toBe('Offerly: Программы ещё нет');
    expect(payload.body).toContain('к повтору 14 карточек');
    expect(payload.url).toBe('https://offerly-c8b.pages.dev/'); // программы нет — главный экран
    expect(db.prepare('SELECT sent_on, note FROM push_settings').get()).toEqual({ sent_on: '2026-11-02', note: 'sent' });
    const s1 = await status(wenv, new Date('2026-11-02T03:00:00.000Z'));
    expect(s1.push).toEqual({ vapid: 'db', users: 1, states: { sent: 1 } });
    expect(JSON.stringify(s1)).not.toContain('ysamussenko');
    expect(JSON.stringify(s1)).not.toContain('push.example');
    const res = await worker.fetch(new Request('https://digest.test/'), wenv as any);
    expect(((await res.json()) as any).push.users).toBe(1);
    const run = await worker.fetch(new Request('https://digest.test/run', { method: 'POST', headers: { 'x-digest-key': 'secret' } }), { ...wenv, DIGEST_KEY: 'secret' } as any);
    const rr: any = await run.json();
    expect(rr.report.digest).toMatchObject({ checked: 1 });
    expect(rr.report.push).toMatchObject({ checked: 1 });
  });
  it('service worker: push показывает уведомление из полезной нагрузки, клик открывает приложение; vite подключает скрипт', async () => {
    const shown: any[] = [];
    const listeners: Record<string, (e: any) => void> = {};
    const opened: string[] = [];
    const client = { url: 'https://offerly-c8b.pages.dev/', focused: false, focus: async () => { client.focused = true; return client; }, navigate: async () => client };
    const self: any = {
      addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
      registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, ...opts }); }, pushManager: { subscribe: async () => null } },
      clients: { matchAll: async () => [client], openWindow: async (u: string) => { opened.push(u); return null; } },
      location: { origin: 'https://offerly-c8b.pages.dev' },
    };
    const src = readFileSync('public/push-sw.js', 'utf-8');
    new Function('self', src)(self);
    expect(Object.keys(listeners).sort()).toEqual(['notificationclick', 'push', 'pushsubscriptionchange']);
    const waits: Promise<unknown>[] = [];
    listeners.push({ data: { json: () => ({ title: 'Offerly: Занятие · Артикли', body: 'к повтору 14 карточек', url: 'https://offerly-c8b.pages.dev/', tag: 'offerly-daily' }) }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(shown).toEqual([{ title: 'Offerly: Занятие · Артикли', body: 'к повтору 14 карточек', tag: 'offerly-daily', icon: '/icon-192.png', badge: '/icon-192.png', lang: 'ru', renotify: false, data: { url: 'https://offerly-c8b.pages.dev/' } }]);
    // без полезной нагрузки — общий текст, без выдумок
    listeners.push({ data: null, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(shown[1]).toMatchObject({ title: 'Offerly', body: 'Пора заниматься: откройте приложение.' });
    // клик: открытое окно — фокус, иначе новое
    const closed: boolean[] = [];
    listeners.notificationclick({ notification: { data: { url: 'https://offerly-c8b.pages.dev/' }, close: () => closed.push(true) }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(closed).toEqual([true]);
    expect(client.focused).toBe(true);
    expect(opened).toEqual([]);
    self.clients.matchAll = async () => [];
    listeners.notificationclick({ notification: { data: { url: 'https://offerly-c8b.pages.dev/' }, close: () => {} }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(opened).toEqual(['https://offerly-c8b.pages.dev/']);
    expect(readFileSync('vite.config.ts', 'utf-8')).toContain("importScripts: ['push-sw.js']");
  });
});
