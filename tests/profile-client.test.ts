import { describe, it, expect } from 'vitest';
import { ApiError, ERRORS, failedAnalysis, networkFailure, type Profile } from '../src/api';

const profile: Profile = {
  specialty: null, industry: null, years: null, targetRole: null, keywords: [], summary: null,
  resumeName: 'resume.docx', resumeAt: '2026-11-01T10:00:00.000Z', resumeChars: 1200, analyzed: false,
  interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, onboarded: false,
  targetLevel: null, weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('неудачный разбор резюме на клиенте', () => {
  it('profile_failed с профилем: карточка получает профиль и причину вместе с ответом сервера', () => {
    const r = failedAnalysis(new ApiError(502, 'profile_failed', { ok: false, error: 'profile_failed', detail: 'AI недоступен', profile }));
    expect(r?.profile).toEqual(profile);
    expect(r?.notice).toBe(`${ERRORS.profile_failed} Ответ сервера: AI недоступен`);
  });

  it('profile_failed без деталей — только строка причины', () => {
    expect(failedAnalysis(new ApiError(502, 'profile_failed', { profile }))?.notice).toBe(ERRORS.profile_failed);
  });

  it('без сохранённого профиля, другие ошибки и сбой сети — ошибка остаётся на экране загрузки', () => {
    expect(failedAnalysis(new ApiError(502, 'profile_failed', { profile: null }))).toBeNull();
    expect(failedAnalysis(new ApiError(400, 'resume_too_short', {}))).toBeNull();
    expect(failedAnalysis(networkFailure(true))).toBeNull();
    expect(failedAnalysis(new Error('x'))).toBeNull();
  });
});
