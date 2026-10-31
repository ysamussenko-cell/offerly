import { describe, it, expect } from 'vitest';
import { plural, daysText, yearsText, minutesText, countdownText, longDate, timeZoneList, tzLabel, FORMAT_LABELS } from '../src/text';
import { initialAnswers } from '../src/screens/Questionnaire';
import { INTERVIEW_FORMATS } from '../functions/_lib/onboarding';
import type { Profile, User } from '../src/api';

const NOW = new Date('2026-10-30T06:00:00Z');

describe('склонения', () => {
  it('день/дня/дней, год/года/лет, минута/минуты/минут', () => {
    expect(plural(1, 'день', 'дня', 'дней')).toBe('день');
    expect(plural(11, 'день', 'дня', 'дней')).toBe('дней');
    expect(plural(21, 'день', 'дня', 'дней')).toBe('день');
    expect(daysText(24)).toBe('24 дня');
    expect(daysText(5)).toBe('5 дней');
    expect(yearsText(15)).toBe('15 лет');
    expect(yearsText(3)).toBe('3 года');
    expect(minutesText(20)).toBe('20 минут');
    expect(minutesText(1)).toBe('1 минута');
  });
});

describe('даты на экране', () => {
  it('обратный отсчёт до собеседования в поясе пользователя', () => {
    expect(countdownText('2026-11-23', 'Asia/Almaty', NOW)).toBe('через 24 дня');
    expect(countdownText('2026-10-31', 'Asia/Almaty', NOW)).toBe('завтра');
    expect(countdownText('2026-10-30', 'Asia/Almaty', NOW)).toBe('сегодня');
    expect(countdownText('2026-10-29', 'Asia/Almaty', NOW)).toBe('дата прошла');
    expect(countdownText('2026-10-29', 'America/Los_Angeles', NOW)).toBe('сегодня');
  });
  it('длинная дата по-русски', () => {
    expect(longDate('2026-11-23')).toMatch(/^23 ноября 2026/);
  });
});

describe('часовые пояса и подписи', () => {
  it('список содержит текущий пояс и Алматы, подпись со смещением', () => {
    const list = timeZoneList('Asia/Almaty');
    expect(list).toContain('Asia/Almaty');
    expect(list).toContain('Europe/Moscow');
    expect(timeZoneList('Custom/Zone')[0]).toBe('Custom/Zone');
    expect(tzLabel('Asia/Almaty', NOW)).toBe('Asia/Almaty (UTC+5)');
    expect(tzLabel('UTC', NOW)).toMatch(/^UTC/);
  });
  it('подписи форматов есть для каждого значения сервера', () => {
    for (const f of INTERVIEW_FORMATS) expect(FORMAT_LABELS[f]).toBeTruthy();
  });
});

describe('начальные ответы анкеты', () => {
  const user: User = { id: 'u1', email: 'a@b.cc', name: null, locale: 'ru', tz: 'Asia/Almaty' };
  const base: Profile = {
    specialty: 'инженер', industry: 'энергетика', years: 15, targetRole: 'главный энергетик', keywords: [], summary: null,
    resumeName: 'cv.pdf', resumeAt: null, resumeChars: 1000, analyzed: true,
    interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, onboarded: false,
    targetLevel: null, weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: '',
  };
  it('до анкеты — цель из резюме, пояс из браузера, 20 минут и неизвестный формат', () => {
    const a = initialAnswers(base, user);
    expect(a.targetRole).toBe('главный энергетик');
    expect(a.minutesPerDay).toBe(20);
    expect(a.interviewFormat).toBe('unknown');
    expect(a.nativeLanguage).toBe('русский');
    expect(a.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty');
  });
  it('после анкеты — прежние ответы и пояс пользователя', () => {
    const p: Profile = { ...base, targetRole: 'эксперт', interviewDate: '2026-11-23', interviewFormat: 'ai', minutesPerDay: 30, nativeLanguage: 'казахский', onboardedAt: 'x', onboarded: true };
    const a = initialAnswers(p, { ...user, tz: 'Europe/Moscow' });
    expect(a).toEqual({ targetRole: 'эксперт', interviewDate: '2026-11-23', interviewFormat: 'ai', minutesPerDay: 30, tz: 'Europe/Moscow', nativeLanguage: 'казахский' });
  });
  it('без профиля — пустая цель', () => {
    expect(initialAnswers(null, user).targetRole).toBe('');
  });
});
