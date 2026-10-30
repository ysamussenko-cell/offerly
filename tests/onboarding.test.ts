import { describe, it, expect } from 'vitest';
import { validateAnswers, parseDate, todayIn, daysBetween, isTimeZone, MAX_DAYS_AHEAD } from '../functions/_lib/onboarding';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { SAMPLE_RESUME } from './helpers/fixtures';

const NOW = new Date('2026-10-30T06:00:00Z'); // в Алматы уже 11:00 30.10, в Лос-Анджелесе ещё 23:00 29.10

const GOOD = {
  targetRole: 'эксперт по оценке ответов ИИ', interviewDate: '2026-11-23', interviewFormat: 'ai',
  minutesPerDay: 30, tz: 'Asia/Almaty', nativeLanguage: 'Русский',
};

describe('даты и часовые пояса', () => {
  it('parseDate принимает только существующие даты', () => {
    expect(parseDate('2026-11-23')).toBe('2026-11-23');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('23.11.2026')).toBeNull();
    expect(parseDate(20261123)).toBeNull();
  });
  it('todayIn считает день в часовом поясе пользователя', () => {
    expect(todayIn('Asia/Almaty', NOW)).toBe('2026-10-30');
    expect(todayIn('America/Los_Angeles', NOW)).toBe('2026-10-29');
    expect(todayIn('Nowhere/City', NOW)).toBe('2026-10-30'); // неизвестный пояс — UTC
  });
  it('daysBetween и isTimeZone', () => {
    expect(daysBetween('2026-10-30', '2026-11-23')).toBe(24);
    expect(daysBetween('2026-11-23', '2026-10-30')).toBe(-24);
    expect(isTimeZone('Europe/Moscow')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});

describe('проверка ответов анкеты', () => {
  it('принимает полный набор и нормализует текст', () => {
    const v = validateAnswers({ ...GOOD, targetRole: '  эксперт   по оценке ' }, NOW);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.answers.targetRole).toBe('эксперт по оценке');
    expect(v.answers.nativeLanguage).toBe('русский');
    expect(v.answers.minutesPerDay).toBe(30);
    expect(v.answers.interviewFormat).toBe('ai');
  });
  it('дата не обязательна, формат по умолчанию — не известен, пояс по умолчанию — Алматы', () => {
    const v = validateAnswers({ targetRole: 'инженер', minutesPerDay: '20', nativeLanguage: 'казахский', interviewDate: '' }, NOW);
    expect(v).toEqual({ ok: true, answers: { targetRole: 'инженер', interviewDate: null, interviewFormat: 'unknown', minutesPerDay: 20, tz: 'Asia/Almaty', nativeLanguage: 'казахский' } });
  });
  it('сегодня в поясе пользователя — можно; вчера — нельзя', () => {
    expect(validateAnswers({ ...GOOD, interviewDate: '2026-10-30' }, NOW).ok).toBe(true);
    expect(validateAnswers({ ...GOOD, interviewDate: '2026-10-29' }, NOW)).toEqual({ ok: false, field: 'interviewDate', reason: 'past' });
    // в Лос-Анджелесе 29.10 ещё сегодня
    expect(validateAnswers({ ...GOOD, tz: 'America/Los_Angeles', interviewDate: '2026-10-29' }, NOW).ok).toBe(true);
  });
  it('слишком далёкая дата и неверный формат даты', () => {
    expect(validateAnswers({ ...GOOD, interviewDate: '2030-01-01' }, NOW)).toEqual({ ok: false, field: 'interviewDate', reason: 'far' });
    expect(validateAnswers({ ...GOOD, interviewDate: '2026-13-01' }, NOW)).toEqual({ ok: false, field: 'interviewDate', reason: 'format' });
    expect(MAX_DAYS_AHEAD).toBe(730);
  });
  it('пустая цель, чужой формат, минуты вне диапазона, неизвестный пояс, пустой язык', () => {
    expect(validateAnswers({ ...GOOD, targetRole: ' ' }, NOW)).toMatchObject({ ok: false, field: 'targetRole' });
    expect(validateAnswers({ ...GOOD, interviewFormat: 'phone' }, NOW)).toMatchObject({ ok: false, field: 'interviewFormat' });
    expect(validateAnswers({ ...GOOD, minutesPerDay: 3 }, NOW)).toMatchObject({ ok: false, field: 'minutesPerDay' });
    expect(validateAnswers({ ...GOOD, minutesPerDay: 200 }, NOW)).toMatchObject({ ok: false, field: 'minutesPerDay' });
    expect(validateAnswers({ ...GOOD, minutesPerDay: 20.5 }, NOW)).toMatchObject({ ok: false, field: 'minutesPerDay' });
    expect(validateAnswers({ ...GOOD, tz: 'Mars/Olympus' }, NOW)).toMatchObject({ ok: false, field: 'tz' });
    expect(validateAnswers({ ...GOOD, nativeLanguage: '' }, NOW)).toMatchObject({ ok: false, field: 'nativeLanguage' });
    expect(validateAnswers(null, NOW)).toMatchObject({ ok: false, field: 'targetRole' });
  });
  it('режет длинные строки', () => {
    const v = validateAnswers({ ...GOOD, targetRole: 'x'.repeat(500), nativeLanguage: 'y'.repeat(100) }, NOW);
    expect(v.ok && v.answers.targetRole.length).toBe(120);
    expect(v.ok && v.answers.nativeLanguage.length).toBe(40);
  });
});

const PROFILE_JSON = JSON.stringify({
  specialty: 'инженер-теплоэнергетик', industry: 'энергетика', years: 15, target_role: 'главный энергетик',
  keywords: ['boiler efficiency'], summary: 'Вы инженер.',
});

function makeApp() {
  const mem = memoryStore();
  const env = { DB: null, AI: { run: async () => ({ response: PROFILE_JSON }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
  const app = createApp('test', () => mem.store);
  const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { mem, call, send };
}

async function signIn(send: ReturnType<typeof makeApp>['send'], email = 'yuriy@example.com') {
  const j1: any = await (await send('POST', '/auth/request', { email })).json();
  const r2 = await send('POST', '/auth/verify', { email, code: j1.code });
  return r2.headers.get('set-cookie')!.split(';')[0];
}

describe('API анкеты', () => {
  it('без сессии — 401', async () => {
    const { send } = makeApp();
    expect((await send('PUT', '/onboarding', GOOD)).status).toBe(401);
  });

  it('сохраняет ответы, пояс уходит в пользователя, профиль помечен как заполненный', async () => {
    const { send, call, mem } = makeApp();
    const cookie = await signIn(send);
    const r = await send('PUT', '/onboarding', { ...GOOD, interviewDate: '2099-01-01' }, { cookie });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'onboarding_invalid', field: 'interviewDate', reason: 'far' });

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const ok = await send('PUT', '/onboarding', { ...GOOD, interviewDate: future, tz: 'Europe/Moscow' }, { cookie });
    expect(ok.status).toBe(200);
    const j: any = await ok.json();
    expect(j.profile.onboarded).toBe(true);
    expect(j.profile.targetRole).toBe('эксперт по оценке ответов ИИ');
    expect(j.profile.interviewDate).toBe(future);
    expect(j.profile.interviewFormat).toBe('ai');
    expect(j.profile.minutesPerDay).toBe(30);
    expect(j.profile.nativeLanguage).toBe('русский');
    expect(j.user.tz).toBe('Europe/Moscow');
    expect(mem.users[0].tz).toBe('Europe/Moscow');

    const me: any = await (await call('/me', { headers: { cookie } })).json();
    expect(me.user.tz).toBe('Europe/Moscow');
    const prof: any = await (await call('/profile', { headers: { cookie } })).json();
    expect(prof.profile.onboardedAt).toBeTruthy();
    expect(prof.profile.analyzed).toBe(false); // резюме ещё нет — анкета от него не зависит
  });

  it('после анкеты разбор резюме не затирает целевую позицию, а до анкеты — подставляет свою', async () => {
    const { send, mem } = makeApp();
    const cookie = await signIn(send);
    const r1: any = await (await send('POST', '/resume', { text: SAMPLE_RESUME.join('\n') }, { cookie })).json();
    expect(r1.profile.targetRole).toBe('главный энергетик');

    await send('PUT', '/onboarding', { ...GOOD, interviewDate: null }, { cookie });
    const r2: any = await (await send('POST', '/resume/analyze', {}, { cookie })).json();
    expect(r2.profile.targetRole).toBe('эксперт по оценке ответов ИИ');
    expect(r2.profile.onboarded).toBe(true);
    expect([...mem.profiles.values()][0].minutesPerDay).toBe(30);

    // новое резюме тоже не сбрасывает анкету
    const r3: any = await (await send('POST', '/resume', { text: SAMPLE_RESUME.join('\n') }, { cookie })).json();
    expect(r3.profile.targetRole).toBe('эксперт по оценке ответов ИИ');
    expect(r3.profile.minutesPerDay).toBe(30);
  });
});
