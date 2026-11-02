import { describe, it, expect } from 'vitest';
import { ApiError, errorText, networkFailure } from '../src/api';
import { isUnreachable, OFFLINE_NOTICE } from '../src/offline';

describe('офлайн и сбой сети', () => {
  it('без сети — offline, с сетью без ответа — network', () => {
    const off = networkFailure(false);
    expect(off).toBeInstanceOf(ApiError);
    expect(off.status).toBe(0);
    expect(off.code).toBe('offline');
    expect(networkFailure(true).code).toBe('network');
  });

  it('тексты ошибок по-русски: текст остаётся, нужно повторить', () => {
    expect(errorText(networkFailure(false))).toMatch(/Нет сети/);
    expect(errorText(networkFailure(false))).toMatch(/снова/);
    expect(errorText(networkFailure(true))).toMatch(/Сервер не ответил/);
    expect(OFFLINE_NOTICE).toMatch(/из кэша/);
  });
});

describe('isUnreachable', () => {
  it('статус 0 — запрос не дошёл; ответ сервера, в том числе 401, — дошёл', () => {
    expect(isUnreachable(networkFailure(false))).toBe(true);
    expect(isUnreachable(networkFailure(true))).toBe(true);
    expect(isUnreachable(new ApiError(401, 'unauthorized'))).toBe(false);
    expect(isUnreachable(new ApiError(500, 'request_failed'))).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
  });
});
