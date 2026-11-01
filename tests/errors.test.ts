import { describe, it, expect, vi } from 'vitest';
import { DomainError, isDomainError } from '../functions/_lib/errors';
import { AssessmentError } from '../functions/_lib/assessment';
import { LessonError } from '../functions/_lib/lesson';
import { ProgramError } from '../functions/_lib/program';
import { RehearsalError } from '../functions/_lib/rehearsal';
import { VoiceError } from '../functions/_lib/voice';
import { SettingsError } from '../functions/_lib/settings';
import { PushError } from '../functions/_lib/push';
import { ExtractError } from '../functions/_lib/extract';
import { createApp, INTERNAL_ERROR, type Env } from '../functions/_lib/app';
import { sqlStore } from './helpers/sqliteD1';

const ENV = { DB: null, AI: { run: async () => ({ response: '' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;

describe('DomainError — общая ошибка области', () => {
  it('код, статус, причина и тело ответа; detail только когда сообщение отличается от кода', () => {
    const e = new DomainError('thing_missing', 404);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('thing_missing');
    expect(e.name).toBe('DomainError');
    expect(e.toJSON()).toEqual({ ok: false, error: 'thing_missing' });
    expect(JSON.parse(JSON.stringify(e.toJSON()))).toEqual({ ok: false, error: 'thing_missing' });
    const d = new DomainError('thing_invalid', 400, 'поле пустое', 'empty');
    expect(d.toJSON()).toEqual({ ok: false, error: 'thing_invalid', reason: 'empty', detail: 'поле пустое' });
    expect(isDomainError(d)).toBe(true);
    expect(isDomainError(new Error('x'))).toBe(false);
  });

  it('ошибки областей наследуют DomainError с прежними сигнатурами и статусами', () => {
    const cases: Array<[DomainError, number, string]> = [
      [new AssessmentError('assessment_none'), 404, 'AssessmentError'],
      [new AssessmentError('assessment_busy', 'идёт тест', 'placement'), 409, 'AssessmentError'],
      [new AssessmentError('answer_invalid', undefined, 'empty'), 400, 'AssessmentError'],
      [new AssessmentError('bank_empty'), 502, 'AssessmentError'],
      [new LessonError('lesson_no_day'), 404, 'LessonError'],
      [new LessonError('lesson_unavailable', undefined, 'rest'), 409, 'LessonError'],
      [new LessonError('lesson_eval_failed', 'модель не ответила'), 502, 'LessonError'],
      [new LessonError('bonus_none', undefined, 'declined'), 409, 'LessonError'],
      [new ProgramError('program_none'), 404, 'ProgramError'],
      [new ProgramError('program_invalid', 'same'), 400, 'ProgramError'],
      [new RehearsalError('rehearsal_none'), 404, 'RehearsalError'],
      [new RehearsalError('rehearsal_stale'), 409, 'RehearsalError'],
      [new RehearsalError('rehearsal_eval_failed', 'AI 500'), 502, 'RehearsalError'],
      [new VoiceError('audio_missing'), 400, 'VoiceError'],
      [new VoiceError('audio_unsupported'), 415, 'VoiceError'],
      [new VoiceError('audio_too_large'), 413, 'VoiceError'],
      [new VoiceError('audio_empty'), 422, 'VoiceError'],
      [new VoiceError('stt_failed', 'Whisper: 503'), 502, 'VoiceError'],
      [new SettingsError('key_invalid', 'prefix'), 400, 'SettingsError'],
      [new SettingsError('key_unreadable'), 409, 'SettingsError'],
      [new SettingsError('key_none'), 404, 'SettingsError'],
      [new SettingsError('key_check_failed', undefined, 'Groq 401'), 502, 'SettingsError'],
      [new PushError('vapid_invalid', 'ключи заданы неверно'), 503, 'PushError'],
      [new PushError('subscription_invalid'), 400, 'PushError'],
      [new PushError('payload_too_large'), 413, 'PushError'],
      [new ExtractError('resume_unsupported'), 415, 'ExtractError'],
      [new ExtractError('resume_too_large'), 413, 'ExtractError'],
      [new ExtractError('resume_unreadable'), 422, 'ExtractError'],
      [new ExtractError('resume_too_short'), 400, 'ExtractError'],
    ];
    for (const [e, status, name] of cases) {
      expect(e, e.code).toBeInstanceOf(DomainError);
      expect(e.status, e.code).toBe(status);
      expect(e.name, e.code).toBe(name);
      expect(e.toJSON().error).toBe(e.code);
    }
    // прежние поля на месте: reason у теста и занятия, message по умолчанию равен коду
    expect(new AssessmentError('answer_invalid', undefined, 'empty').reason).toBe('empty');
    expect(new SettingsError('key_invalid', 'prefix').reason).toBe('prefix');
    expect(new ProgramError('program_invalid', 'same').toJSON()).toEqual({ ok: false, error: 'program_invalid', reason: 'same' });
    expect(new LessonError('lesson_eval_failed', 'модель не ответила').toJSON()).toEqual({ ok: false, error: 'lesson_eval_failed', detail: 'модель не ответила' });
  });
});

describe('app.onError', () => {
  async function login(patch: (store: any) => void) {
    const mem = sqlStore();
    patch(mem.store);
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, ENV);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const r1: any = await (await post('/auth/request', { email: 'y@x.kz' })).json();
    const r2 = await post('/auth/verify', { email: 'y@x.kz', code: r1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { call: (p: string, init: RequestInit = {}) => call(p, { ...init, headers: { cookie, ...(init.headers as any) } }), post: (p: string, b: unknown) => post(p, b, { cookie }) };
  }

  // getProfile зовут маршруты всех областей (profileOf / domainOf), поэтому через него удобно подбросить ошибку любой области.
  const throwing = (e: Error) => (store: any) => { store.getProfile = async () => { throw e; }; };

  it('DomainError из любой области → JSON с её кодом, причиной, подробностью и статусом', async () => {
    const lesson = await login(throwing(new LessonError('lesson_unavailable', 'сегодня отдых', 'rest')));
    const r = await lesson.post('/lesson/start', {});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: 'lesson_unavailable', reason: 'rest', detail: 'сегодня отдых' });
    const program = await login(throwing(new ProgramError('program_invalid', 'same')));
    const p = await program.post('/program/swap', { a: '1', b: '1' });
    expect(p.status).toBe(400);
    expect(await p.json()).toEqual({ ok: false, error: 'program_invalid', reason: 'same' });
    const voice = await login(throwing(new VoiceError('audio_unsupported')));
    const v = await voice.post('/voice/transcribe', {});
    expect(v.status).toBe(415);
    expect(await v.json()).toEqual({ ok: false, error: 'audio_unsupported' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const push = await login(throwing(new PushError('vapid_invalid', 'ключи заданы неверно')));
      const u = await push.call('/dashboard');
      expect(u.status).toBe(503);
      expect(await u.json()).toEqual({ ok: false, error: 'vapid_invalid', detail: 'ключи заданы неверно' });
    } finally { err.mockRestore(); }
  });

  it('ошибка сервера (5xx) попадает в журнал, остальные DomainError — нет', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bank = await login(throwing(new AssessmentError('bank_empty', 'в банке нет заданий B1')));
      const r = await bank.post('/assessment/start', {});
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ ok: false, error: 'bank_empty', detail: 'в банке нет заданий B1' });
      expect(err).toHaveBeenCalledWith('bank_empty: в банке нет заданий B1');
      err.mockClear();
      const key = await login(throwing(new SettingsError('key_none')));
      const s = await key.call('/profile');
      expect(s.status).toBe(404);
      expect(await s.json()).toEqual({ ok: false, error: 'key_none' });
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('любая другая ошибка → 500 {ok:false, error:"internal"} без подробностей наружу, подробности — в журнал', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { call } = await login(throwing(new Error('D1_ERROR: no such table: profiles')));
      const r = await call('/profile');
      expect(r.status).toBe(500);
      expect(r.headers.get('content-type')).toContain('application/json');
      expect(await r.json()).toEqual(INTERNAL_ERROR);
      expect(JSON.stringify(err.mock.calls)).toContain('no such table');
      expect(JSON.stringify(err.mock.calls)).toContain('/api/profile');
    } finally { err.mockRestore(); }
  });
});
