import { describe, it, expect, vi, afterEach } from 'vitest';
import { longDateRu } from '../functions/_lib/dates';
import {
  parseNotifyAt, localClock, digestState, nextDigest, renderDigest, headlineOf, taskLines, progressLines, collectDigest, buildDigest, runDigest, sendDigestNow,
  d1DigestStore, weekdayRu, SEND_WINDOW_MINUTES, DEFAULT_NOTIFY_AT, CRON, type DigestData, type DigestEnv,
} from '../functions/_lib/digest';
import { d1ProfileStore, type Profile } from '../functions/_lib/profile';
import { d1Store, type User } from '../functions/_lib/auth';
import type { Assessment } from '../functions/_lib/assessment';
import type { Lesson } from '../functions/_lib/lesson';
import type { ProgramDay } from '../functions/_lib/program';
import type { ErrorCard } from '../functions/_lib/cards';
import { seedStatements, FIRST_USER } from '../functions/_lib/seed';
import { createApp, type Env } from '../functions/_lib/app';
import worker, { makeStore, status, VERSION } from '../workers/digest/index';
import { freshDb, d1Of, sqlStore } from './helpers/sqliteD1';
import { readFileSync } from 'node:fs';

const TZ = 'Asia/Almaty'; // UTC+5
const TODAY = '2026-11-12'; // четверг
const at = (hhmm: string, date = TODAY) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 10, Number(date.slice(8)), h - 5, m)); }; // местное время Алматы → UTC
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
const env: DigestEnv = { APP_NAME: 'Offerly', RESEND_API_KEY: 'k', MAIL_FROM: 'Offerly <onboarding@resend.dev>', APP_URL: 'https://offerly-c8b.pages.dev' };
const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

describe('время письма', () => {
  it('parseNotifyAt: пусто — выключить, 7:41 → 07:41, мусор и 24:00 — ошибка', () => {
    expect(parseNotifyAt(null)).toEqual({ ok: true, value: null });
    expect(parseNotifyAt('')).toEqual({ ok: true, value: null });
    expect(parseNotifyAt('7:41')).toEqual({ ok: true, value: '07:41' });
    expect(parseNotifyAt(' 23:59 ')).toEqual({ ok: true, value: '23:59' });
    expect(parseNotifyAt('24:00')).toEqual({ ok: false, reason: 'format' });
    expect(parseNotifyAt('07:60')).toEqual({ ok: false, reason: 'format' });
    expect(parseNotifyAt('утром')).toEqual({ ok: false, reason: 'format' });
    expect(parseNotifyAt(741)).toEqual({ ok: false, reason: 'format' });
  });
  it('localClock: дата и минуты в поясе пользователя, полночь — 00:00, неизвестный пояс — UTC', () => {
    expect(localClock(TZ, new Date('2026-11-12T02:41:00Z'))).toEqual({ date: '2026-11-12', minutes: 7 * 60 + 41, time: '07:41' });
    expect(localClock(TZ, new Date('2026-11-11T19:00:00Z'))).toEqual({ date: '2026-11-12', minutes: 0, time: '00:00' });
    expect(localClock('Nowhere/Town', new Date('2026-11-12T02:41:00Z'))).toEqual({ date: '2026-11-12', minutes: 2 * 60 + 41, time: '02:41' });
  });
  it('digestState: off, early, due в окне, late за окном, sent после отметки', () => {
    const p = { notifyAt: '07:41', digestSentOn: null };
    expect(digestState({ notifyAt: null, digestSentOn: null }, TZ, at('07:41')).state).toBe('off');
    expect(digestState(p, TZ, at('07:40')).state).toBe('early');
    expect(digestState(p, TZ, at('07:41')).state).toBe('due');
    expect(digestState(p, TZ, at('10:40')).state).toBe('due');
    expect(digestState(p, TZ, at('10:41')).state).toBe('late');
    expect(SEND_WINDOW_MINUTES).toBe(180);
    expect(digestState({ ...p, digestSentOn: TODAY }, TZ, at('07:50')).state).toBe('sent');
    expect(digestState({ ...p, digestSentOn: '2026-11-11' }, TZ, at('07:50')).state).toBe('due');
  });
  it('nextDigest: сегодня, пока рано; завтра после отправки или пропуска; null — выключено', () => {
    const p = { notifyAt: '07:41', digestSentOn: null };
    expect(nextDigest(p, TZ, at('06:00'))).toEqual({ date: TODAY, time: '07:41' });
    expect(nextDigest({ ...p, digestSentOn: TODAY }, TZ, at('08:00'))).toEqual({ date: '2026-11-13', time: '07:41' });
    expect(nextDigest(p, TZ, at('12:00'))).toEqual({ date: '2026-11-13', time: '07:41' });
    expect(nextDigest({ notifyAt: null, digestSentOn: null }, TZ, at('06:00'))).toBeNull();
    expect(CRON).toBe('*/15 * * * *');
    expect(DEFAULT_NOTIFY_AT).toBe('07:30');
  });
  it('даты по-русски', () => {
    expect(longDateRu('2026-11-12')).toBe('12 ноября 2026');
    expect(longDateRu('2026-03-01', false)).toBe('1 марта');
    expect(weekdayRu('2026-11-12')).toBe('четверг');
    expect(weekdayRu('2026-11-15')).toBe('воскресенье');
  });
});

/** Пользователь u1 с профилем, срезом, программой, занятием и карточками — в SQLite со всеми миграциями. */
async function seeded(over: { days?: ProgramDay[]; lessons?: Lesson[]; cards?: ErrorCard[]; profile?: Partial<Profile>; assessment?: Assessment | null } = {}) {
  const mem = sqlStore();
  await mem.store.insertUser(user());
  mem.putProfile(profile(over.profile));
  if (over.assessment !== null) await mem.putAssessment(over.assessment ?? assessment());
  await mem.store.replacePlannedDays('u1', '2026-11-01', over.days ?? [day('2026-11-11'), day(TODAY, { topic: 'conjunctions', writing: 'explain', reason: 'слабая ось связности' }), day('2026-11-13')]);
  for (const l of over.lessons ?? [lesson('2026-11-11', 80)]) await mem.store.createLesson(l);
  await mem.store.insertCards(over.cards ?? [card('2026-11-10'), card(TODAY), card('2026-11-20'), card(null, 1)]);
  return mem;
}
/** Отметка письма в профиле: день, момент отправки и итог (digest_sent_on, digest_sent_at, digest_note). */
const marks = (mem: ReturnType<typeof sqlStore>, userId = 'u1') =>
  mem.rows<{ sentOn: string | null; sentAt: string | null; note: string | null }>('SELECT digest_sent_on AS sent_on, digest_sent_at AS sent_at, digest_note AS note FROM profiles WHERE user_id = ?', userId)[0];

describe('текст письма', () => {
  it('собирается из программы, карточек и главного экрана: занятие дня, карточки к повтору, готовность, серия, неделя, собеседование', async () => {
    const mem = await seeded();
    const now = () => at('07:45').toISOString();
    const data = await collectDigest(mem.store, user(), profile(), { now });
    expect(data.today).toBe(TODAY);
    expect(data.day?.topicLabel).toBe('Союзы и инверсия');
    expect(data.programExists).toBe(true);
    expect(data.todayDone).toBe(false);
    expect(data.dueCards).toBe(2); // просроченная и сегодняшняя; будущая и погашенная — нет
    expect(headlineOf(data)).toBe('занятие · Союзы и инверсия');
    const task = taskLines(data);
    expect(task[0]).toBe('занятие, тема «Союзы и инверсия», письмо — объяснение неспециалисту, 25 минут.');
    expect(task[1]).toBe('Почему: слабая ось связности');
    expect(task[2]).toBe('К повтору в журнале ошибок: 2 карточки.');
    const progress = progressLines(data);
    expect(progress[0]).toMatch(/^Готовность: 5[0-9] из 100, уровень B1 \(цель C1 — от 85\)\.$/);
    expect(progress[1]).toBe('Серия: 1 день; заморозка этой недели есть.');
    expect(progress[2]).toMatch(/^Неделя: \d+ из 125 минут/);
    expect(progress[3]).toBe('Собеседование: через 20 дней (2 декабря 2026).');
    expect(progress[4]).toBe('Программа: пройдено 0 из 3 дней, до 13 ноября 2026.');
    const mail = renderDigest(data, user(), profile(), env);
    expect(mail.subject).toBe('Offerly, 12 ноября: занятие · Союзы и инверсия');
    expect(mail.text).toContain('Здравствуйте, Юрий.');
    expect(mail.text).toContain('Задание дня — четверг, 12 ноября');
    expect(mail.text).toContain('Открыть Offerly: https://offerly-c8b.pages.dev');
    expect(mail.text).toContain('раз в день в 07:41 (Asia/Almaty)');
    expect(mail.html).toContain('href="https://offerly-c8b.pages.dev"');
    expect(mail.html).toContain('Занятие · Союзы и инверсия');
    expect(mail.html).toContain('#F2A541');
    expect(mail.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
  it('без программы, без теста, без карточек и без имени — честные формулировки', async () => {
    const mem = await seeded({ days: [], lessons: [], cards: [], assessment: null, profile: { interviewDate: null } });
    const { mail, data } = await buildDigest(env, mem.store, user({ name: null }), profile({ interviewDate: null }), { now: () => at('07:45').toISOString() });
    expect(headlineOf(data)).toBe('программы ещё нет');
    expect(taskLines(data)[0]).toMatch(/^Программа ещё не составлена/);
    expect(taskLines(data)[1]).toBe('Карточек к повтору сегодня нет.');
    expect(progressLines(data)[0]).toBe('Готовность: появится после теста уровня.');
    expect(progressLines(data).some(l => l.startsWith('Собеседование'))).toBe(false);
    expect(mail.text).toContain('Здравствуйте.\n');
    expect(mail.subject).toBe('Offerly, 12 ноября: программы ещё нет');
  });
  it('день без занятия, репетиция и уже пройденный день', async () => {
    const mem = await seeded({ days: [day('2026-11-11'), day('2026-11-13')] });
    const d1 = await collectDigest(mem.store, user(), profile(), { now: () => at('07:45').toISOString() });
    expect(headlineOf(d1)).toBe('день без занятия по программе');
    const mem2 = await seeded({ days: [day(TODAY, { format: 'rehearsal', topic: 'mixed', writing: null, reason: null, status: 'done', score: 71 })], lessons: [] });
    const d2 = await collectDigest(mem2.store, user(), profile(), { now: () => at('07:45').toISOString() });
    expect(headlineOf(d2)).toBe('репетиция интервью');
    expect(d2.todayDone).toBe(true);
    expect(taskLines(d2)).toContain('Сегодняшний день уже пройден — 71 из 100.');
    expect(taskLines(d2)[0]).toBe('репетиция интервью, 25 минут.');
  });
  it('профиля нет — письмо собирается с пустым профилем и временем по умолчанию в подвале', async () => {
    const mem = await seeded({ days: [], lessons: [], cards: [], assessment: null });
    const { mail } = await buildDigest(env, mem.store, user(), null, { now: () => at('07:45').toISOString() });
    expect(mail.text).toContain(`раз в день в ${DEFAULT_NOTIFY_AT}`);
  });
});

describe('проход расписания', () => {
  it('пора — письмо уходит и день отмечен; рано — не трогаем; второй проход в тот же день не дублирует', async () => {
    const mem = await seeded();
    await mem.store.insertUser(user({ id: 'u2', email: 'late@example.com', tz: 'Europe/Moscow' }));
    mem.putProfile(profile({ userId: 'u2', notifyAt: '09:00' })); // в Москве сейчас 04:45 — рано
    await mem.store.insertUser(user({ id: 'u3', email: 'off@example.com' }));
    mem.putProfile(profile({ userId: 'u3', notifyAt: null }));
    const fetchFn = okFetch();
    const now = () => at('07:45').toISOString();
    const r = await runDigest(env, mem.store, { now, fetchFn });
    expect(r).toMatchObject({ checked: 2, sent: 1, skipped: 0, failed: 0 });
    expect(r.users).toEqual([{ userId: 'u1', state: 'due', note: 'sent' }, { userId: 'u2', state: 'early', note: null }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
    expect(body.to).toEqual(['y@example.com']);
    expect(body.subject).toBe('Offerly, 12 ноября: занятие · Союзы и инверсия');
    expect(body.from).toBe('Offerly <onboarding@resend.dev>');
    expect(marks(mem)).toEqual({ sentOn: TODAY, sentAt: now(), note: 'sent' });
    expect(marks(mem, 'u2')).toEqual({ sentOn: null, sentAt: null, note: null });
    const r2 = await runDigest(env, mem.store, { now: () => at('08:30').toISOString(), fetchFn });
    expect(r2).toMatchObject({ checked: 2, sent: 0, skipped: 0, failed: 0 });
    expect(r2.users[0]).toEqual({ userId: 'u1', state: 'sent', note: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // следующий день — снова пора
    const r3 = await runDigest(env, mem.store, { now: () => at('07:50', '2026-11-13').toISOString(), fetchFn });
    expect(r3.sent).toBe(1);
    expect(marks(mem).sentOn).toBe('2026-11-13');
  });
  it('окно прошло — день помечается пропущенным без письма', async () => {
    const mem = await seeded();
    const fetchFn = okFetch();
    const r = await runDigest(env, mem.store, { now: () => at('12:00').toISOString(), fetchFn });
    expect(r).toMatchObject({ checked: 1, sent: 0, skipped: 1, failed: 0 });
    expect(r.users[0]).toEqual({ userId: 'u1', state: 'late', note: 'skipped:late' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(marks(mem)).toEqual({ sentOn: TODAY, sentAt: null, note: 'skipped:late' });
  });
  it('почта не настроена — skipped, Resend отказал — failed с отметкой дня (без повторов каждые 15 минут)', async () => {
    const mem = await seeded();
    const r = await runDigest({ ...env, RESEND_API_KEY: undefined }, mem.store, { now: () => at('07:45').toISOString(), fetchFn: okFetch() });
    expect(r).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(marks(mem).note).toBe('skipped:mail_not_configured');
    const mem2 = await seeded();
    const bad = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const r2 = await runDigest(env, mem2.store, { now: () => at('07:45').toISOString(), fetchFn: bad });
    expect(r2).toMatchObject({ sent: 0, skipped: 0, failed: 1 });
    expect(r2.users[0].note).toMatch(/^error:Resend 429/);
    expect(marks(mem2).sentOn).toBe(TODAY);
  });
  it('sendDigestNow: письмо уходит сразу и день отмечен как sent:manual', async () => {
    const mem = await seeded();
    const fetchFn = okFetch();
    const r = await sendDigestNow(env, mem.store, user(), profile(), { now: () => at('06:00').toISOString(), fetchFn });
    expect(r.result).toEqual({ sent: true, id: 'm1' });
    expect(r.subject).toContain('Союзы и инверсия');
    expect(r.sentOn).toBe(TODAY);
    expect(marks(mem).note).toBe('sent:manual');
  });
});

describe('API', () => {
  const appEnv = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
  async function login(mem: ReturnType<typeof sqlStore>, app: ReturnType<typeof createApp>) {
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, { ...appEnv, DB: mem.DB });
    const r1 = await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com' }) });
    const { code } = await r1.json() as any;
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com', code }) });
    return { call, cookie: r2.headers.get('set-cookie')!.split(';')[0], uid: (await mem.store.findUserByEmail('y@example.com'))!.id };
  }
  it('GET/PUT /api/digest: без cookie — 401; состояние с предпросмотром; время включается, переставляется, выключается; мусор — 400', async () => {
    const mem = sqlStore();
    const app = createApp('test');
    const env = { ...appEnv, DB: mem.DB } as Env;
    expect((await app.request('https://offerly.test/api/digest', {}, env)).status).toBe(401);
    expect((await app.request('https://offerly.test/api/digest', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"notifyAt":"07:00"}' }, env)).status).toBe(401);
    expect((await app.request('https://offerly.test/api/digest/send', { method: 'POST' }, env)).status).toBe(401);
    const { call, cookie } = await login(mem, app);
    const g = await call('/digest', { headers: { cookie } });
    expect(g.status).toBe(200);
    const j: any = await g.json();
    expect(j).toMatchObject({ ok: true, enabled: false, notifyAt: null, state: 'off', next: null, defaultAt: '07:30', stepMinutes: 15, mail: 'missing' });
    expect(j.preview.subject).toMatch(/^Offerly, \d+ \S+: программы ещё нет$/);
    expect(j.preview.text).toContain('Карточек к повтору сегодня нет.');
    const bad = await call('/digest', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ notifyAt: '25:00' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'notify_invalid', reason: 'format' });
    // время на минуту вперёд от текущего в поясе пользователя — первое письмо сегодня; на минуту назад — уже прошло, первое письмо завтра
    const tz = (await mem.store.findUserByEmail('y@example.com'))!.tz;
    const clock = localClock(tz, new Date());
    const hhmm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
    const ahead = hhmm(clock.minutes + 5), behind = hhmm(clock.minutes - 5);
    if (clock.minutes + 5 < 1440) {
      const on = await call('/digest', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ notifyAt: ahead }) });
      const k: any = await on.json();
      expect(k).toMatchObject({ ok: true, enabled: true, notifyAt: ahead, state: 'early' });
      expect(k.next).toEqual({ date: clock.date, time: ahead });
      expect(k.preview).toBeUndefined();
    }
    if (clock.minutes - 5 >= 0) {
      const re = await call('/digest', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ notifyAt: behind }) });
      const k2: any = await re.json();
      expect(k2).toMatchObject({ ok: true, enabled: true, notifyAt: behind, state: 'sent', sentOn: clock.date });
      expect(k2.next.time).toBe(behind);
      expect(k2.next.date > clock.date).toBe(true);
    }
    const off = await call('/digest', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ notifyAt: null }) });
    expect(await off.json()).toMatchObject({ ok: true, enabled: false, notifyAt: null, state: 'off' });
    const noPreview = await call('/digest?preview=0', { headers: { cookie } });
    expect(((await noPreview.json()) as any).preview).toBeUndefined();
  });
  it('POST /api/digest/send: без ключа — 503, с ключом — письмо через Resend и день отмечен, отказ Resend — 502', async () => {
    const mem = sqlStore();
    const app = createApp('test');
    const { call, cookie, uid } = await login(mem, app);
    const r503 = await call('/digest/send', { method: 'POST', headers: { cookie } });
    expect(r503.status).toBe(503);
    expect(await r503.json()).toEqual({ ok: false, error: 'mail_not_configured' });
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const appMail = createApp('test');
    const envMail = { ...appEnv, DB: mem.DB, RESEND_API_KEY: 'k', APP_URL: 'https://offerly-c8b.pages.dev' } as unknown as Env;
    const ok = await appMail.request('https://offerly.test/api/digest/send', { method: 'POST', headers: { cookie } }, envMail);
    expect(ok.status).toBe(200);
    const j: any = await ok.json();
    expect(j.ok).toBe(true);
    expect(j.subject).toMatch(/^Offerly, /);
    expect(j.id).toBe('m1');
    expect(marks(mem, uid).sentOn).toBe(j.sentOn);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.to).toEqual(['y@example.com']);
    expect(body.html).toContain('https://offerly-c8b.pages.dev');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const r502 = await appMail.request('https://offerly.test/api/digest/send', { method: 'POST', headers: { cookie } }, envMail);
    expect(r502.status).toBe(502);
    expect(await r502.json()).toMatchObject({ ok: false, error: 'mail_failed' });
  });
});

describe('D1 и Worker', () => {
  it('миграция 0017 — только добавление колонок; d1DigestStore: список включённых, сохранение времени, отметка дня', async () => {
    const sql = readFileSync('migrations/0017_digest.sql', 'utf-8');
    expect(sql).toMatch(/digest_sent_on/);
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE/);
    const db = freshDb();
    db.exec(`INSERT INTO users (id, email, name, tz) VALUES ('u1', 'y@example.com', 'Юрий', 'Asia/Almaty'), ('u2', 'z@example.com', NULL, 'Europe/Moscow')`);
    const d1 = d1Of(db);
    const store = d1DigestStore(d1), profiles = d1ProfileStore(d1);
    expect(await store.listDigestUsers()).toEqual([]);
    await store.saveNotifyAt('u1', '07:41', null, '2026-11-12T00:00:00.000Z');
    await store.saveNotifyAt('u2', '09:00', '2026-11-12', '2026-11-12T00:00:00.000Z');
    const list = await store.listDigestUsers();
    expect(list.map(x => [x.user.id, x.user.tz, x.profile.notifyAt, x.profile.digestSentOn])).toEqual([['u1', 'Asia/Almaty', '07:41', null], ['u2', 'Europe/Moscow', '09:00', '2026-11-12']]);
    expect(list[0].user.name).toBe('Юрий');
    expect((await profiles.getProfile('u1'))?.notifyAt).toBe('07:41');
    await store.markDigest('u1', '2026-11-12', '2026-11-12T02:45:00.000Z', 'sent', '2026-11-12T02:45:00.000Z');
    expect(db.prepare('SELECT digest_sent_on, digest_sent_at, digest_note FROM profiles WHERE user_id = ?').get('u1')).toEqual({ digest_sent_on: '2026-11-12', digest_sent_at: '2026-11-12T02:45:00.000Z', digest_note: 'sent' });
    await store.markDigest('u1', '2026-11-13', null, 'skipped:late', '2026-11-13T10:00:00.000Z');
    expect(db.prepare('SELECT digest_sent_on, digest_sent_at, digest_note FROM profiles WHERE user_id = ?').get('u1')).toEqual({ digest_sent_on: '2026-11-13', digest_sent_at: '2026-11-12T02:45:00.000Z', digest_note: 'skipped:late' });
    // переставить время, не трогая отметку дня; выключить
    await store.saveNotifyAt('u1', '08:00', null, '2026-11-13T11:00:00.000Z');
    expect((await profiles.getProfile('u1'))).toMatchObject({ notifyAt: '08:00', digestSentOn: '2026-11-13' });
    await store.saveNotifyAt('u1', null, null, '2026-11-13T11:00:00.000Z');
    expect((await store.listDigestUsers()).map(x => x.user.id)).toEqual(['u2']);
  });
  it('Worker на seed первого пользователя: в 07:50 Алматы письмо Юрию уходит через Resend по настоящему SQL, статус без адресов', async () => {
    const db = freshDb();
    for (const s of seedStatements()) db.exec(s);
    const wenv = { DB: d1Of(db), APP_NAME: 'Offerly', RESEND_API_KEY: 'k', MAIL_FROM: 'Offerly <onboarding@resend.dev>', APP_URL: 'https://offerly-c8b.pages.dev' };
    const early = new Date('2026-11-02T02:30:00.000Z'); // 07:30 Алматы
    const s0 = await status(wenv, early);
    expect(s0).toMatchObject({ ok: true, version: VERSION, db: 'ok', mail: 'ok', cron: '*/15 * * * *', users: 1, states: { early: 1 } });
    const fetchFn = okFetch();
    const r = await runDigest(wenv, makeStore(wenv), { now: () => '2026-11-02T02:50:00.000Z', fetchFn });
    expect(r).toMatchObject({ checked: 1, sent: 1, skipped: 0, failed: 0 });
    const body = JSON.parse((fetchFn.mock.calls[0] as any)[1].body);
    expect(body.to).toEqual([FIRST_USER.email]);
    expect(body.subject).toBe('Offerly, 2 ноября: программы ещё нет');
    expect(body.text).toContain('Здравствуйте, Юрий.');
    expect(body.text).toContain('Готовность: 53 из 100, уровень B1 (цель C1 — от 85).');
    expect(body.text).toContain('К повтору в журнале ошибок: 14 карточек.');
    expect(body.text).toContain('раз в день в 07:41 (Asia/Almaty)');
    expect(db.prepare('SELECT digest_sent_on, digest_note FROM profiles').get()).toEqual({ digest_sent_on: '2026-11-02', digest_note: 'sent' });
    const s1 = await status(wenv, new Date('2026-11-02T03:00:00.000Z'));
    expect(s1.states).toEqual({ sent: 1 });
    expect(JSON.stringify(s1)).not.toContain('ysamussenko');
    // fetch-обработчик: GET / — статус, POST /run без ключа — 404, с ключом — прогон
    const res = await worker.fetch(new Request('https://digest.test/'), wenv as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: VERSION });
    expect((await worker.fetch(new Request('https://digest.test/run', { method: 'POST' }), wenv as any)).status).toBe(404);
    expect((await worker.fetch(new Request('https://digest.test/run', { method: 'POST', headers: { 'x-digest-key': 'x' } }), { ...wenv, DIGEST_KEY: 'secret' } as any)).status).toBe(404);
    vi.stubGlobal('fetch', okFetch());
    const run = await worker.fetch(new Request('https://digest.test/run', { method: 'POST', headers: { 'x-digest-key': 'secret' } }), { ...wenv, DIGEST_KEY: 'secret' } as any);
    expect(run.status).toBe(200);
    expect(((await run.json()) as any).report.digest).toMatchObject({ checked: 1 }); // с 4.5 /run отдаёт оба отчёта: письмо и напоминание
    expect((await worker.fetch(new Request('https://digest.test/nope'), wenv as any)).status).toBe(404);
  });
  it('wrangler.toml Worker: тот же cron, та же база, адрес приложения', () => {
    const toml = readFileSync('workers/digest/wrangler.toml', 'utf-8');
    expect(toml).toContain(`crons = ["${CRON}"]`);
    expect(toml).toContain('database_name = "offerly"');
    expect(toml).toContain('database_id = "__D1_ID__"');
    expect(toml).toContain('name = "offerly-digest"');
    expect(toml).toContain('APP_URL = "https://offerly-c8b.pages.dev"');
    // версия Worker — та же, что у приложения: обе читают package.json через functions/_lib/version.ts
    expect(VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf-8')).version);
    expect(readFileSync('functions/api/[[route]].ts', 'utf-8')).toContain(`import { VERSION } from '../_lib/version'`);
  });
});
