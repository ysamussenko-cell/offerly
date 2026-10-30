import { describe, it, expect } from 'vitest';
import {
  requestCode, verifyCode, sessionFromToken, logout, normalizeEmail, normalizeCode, randomCode,
  readCookie, sessionCookie, clearSessionCookie, hashCode, CODE_MAX_ATTEMPTS, CODES_PER_WINDOW, CODE_TTL_SEC,
} from '../functions/_lib/auth';
import { memoryStore } from './helpers/memoryStore';

describe('нормализация ввода', () => {
  it('приводит почту к нижнему регистру и отбрасывает мусор', () => {
    expect(normalizeEmail('  Yuriy@Example.COM ')).toBe('yuriy@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
  it('принимает код только из шести цифр', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode(123456)).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('abcdef')).toBeNull();
  });
  it('генерирует шестизначный код с ведущими нулями', () => {
    for (let i = 0; i < 50; i++) expect(randomCode()).toMatch(/^\d{6}$/);
  });
});

describe('запрос кода', () => {
  it('создаёт запись с хэшем, а не с кодом', async () => {
    const { store, codes } = memoryStore();
    const r = await requestCode(store, 'User@mail.ru');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(codes).toHaveLength(1);
    expect(codes[0].email).toBe('user@mail.ru');
    expect(codes[0].codeHash).not.toContain(r.code);
    expect(codes[0].codeHash).toBe(await hashCode(codes[0].id, 'user@mail.ru', r.code));
  });
  it('отказывает на плохой адрес', async () => {
    const { store } = memoryStore();
    expect(await requestCode(store, 'bad')).toEqual({ ok: false, reason: 'bad_email' });
  });
  it('ограничивает число кодов за окно', async () => {
    const { store } = memoryStore();
    for (let i = 0; i < CODES_PER_WINDOW; i++) expect((await requestCode(store, 'a@b.cc')).ok).toBe(true);
    expect(await requestCode(store, 'a@b.cc')).toEqual({ ok: false, reason: 'too_many' });
    // другой адрес не затронут
    expect((await requestCode(store, 'c@d.ee')).ok).toBe(true);
  });
});

describe('проверка кода и сессия', () => {
  it('верный код создаёт пользователя и сессию, повторно код не работает', async () => {
    const { store, users, sessions } = memoryStore();
    const r = await requestCode(store, 'a@b.cc');
    if (!r.ok) throw new Error();
    const v = await verifyCode(store, 'A@B.CC', r.code);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.isNew).toBe(true);
    expect(users).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(v.token); // в базе только хэш
    expect(await verifyCode(store, 'a@b.cc', r.code)).toEqual({ ok: false, reason: 'no_code' });
  });
  it('второй вход того же адреса не создаёт второго пользователя', async () => {
    const { store, users } = memoryStore();
    for (let i = 0; i < 2; i++) {
      const r = await requestCode(store, 'a@b.cc');
      if (!r.ok) throw new Error();
      const v = await verifyCode(store, 'a@b.cc', r.code);
      expect(v.ok && v.isNew).toBe(i === 0);
    }
    expect(users).toHaveLength(1);
  });
  it('неверный код считает попытки и блокирует после лимита', async () => {
    const { store } = memoryStore();
    const r = await requestCode(store, 'a@b.cc');
    if (!r.ok) throw new Error();
    const wrong = r.code === '000000' ? '000001' : '000000';
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) {
      expect(await verifyCode(store, 'a@b.cc', wrong)).toEqual({ ok: false, reason: 'wrong_code' });
    }
    expect(await verifyCode(store, 'a@b.cc', wrong)).toEqual({ ok: false, reason: 'locked' });
    expect(await verifyCode(store, 'a@b.cc', r.code)).toEqual({ ok: false, reason: 'locked' });
  });
  it('просроченный код не принимается', async () => {
    const { store } = memoryStore();
    const t0 = Date.now();
    const r = await requestCode(store, 'a@b.cc', t0);
    if (!r.ok) throw new Error();
    expect(await verifyCode(store, 'a@b.cc', r.code, t0 + (CODE_TTL_SEC + 1) * 1000)).toEqual({ ok: false, reason: 'no_code' });
  });
  it('сессия находится по токену, истекает и удаляется при выходе', async () => {
    const { store } = memoryStore();
    const t0 = Date.now();
    const r = await requestCode(store, 'a@b.cc', t0);
    if (!r.ok) throw new Error();
    const v = await verifyCode(store, 'a@b.cc', r.code, t0);
    if (!v.ok) throw new Error();
    expect((await sessionFromToken(store, v.token, t0))?.user.email).toBe('a@b.cc');
    expect(await sessionFromToken(store, 'не токен', t0)).toBeNull();
    expect(await sessionFromToken(store, v.token, t0 + 31 * 24 * 3600 * 1000)).toBeNull();
    await logout(store, v.token);
    expect(await sessionFromToken(store, v.token, t0)).toBeNull();
  });
});

describe('cookie', () => {
  it('ставит HttpOnly-cookie и умеет её читать и сбрасывать', () => {
    const c = sessionCookie('abc', new Date(Date.now() + 1000).toISOString());
    expect(c).toContain('offerly_session=abc');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(readCookie('x=1; offerly_session=abc; y=2', 'offerly_session')).toBe('abc');
    expect(readCookie(undefined, 'offerly_session')).toBeUndefined();
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
