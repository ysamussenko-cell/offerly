import { describe, it, expect } from 'vitest';
import { keyStatusText, notificationsText, countsText, keyErrorText, validateKeyInput, KEY_REFUSALS, keyPlaceholder } from '../src/settings';
import { ApiError, ERRORS, type Settings } from '../src/api';

const provider = (key: Settings['provider']['key']): Settings['provider'] => ({
  key, keySource: 'db', builtin: 'Встроенная модель (Cloudflare Workers AI)',
  providers: [{ id: 'groq', name: 'Groq — бесплатный gpt-oss', short: 'Groq', keyUrl: 'https://console.groq.com/keys', defaultModel: 'openai/gpt-oss-120b', prefix: 'gsk_', free: true }],
});
const key = (over: Partial<NonNullable<Settings['provider']['key']>> = {}): NonNullable<Settings['provider']['key']> => ({
  provider: 'groq', providerName: 'Groq — бесплатный gpt-oss', short: 'Groq', model: 'openai/gpt-oss-120b', custom: false, hint: '…6789', readable: true,
  checkedAt: null, checkNote: null, createdAt: '2026-11-12T03:00:00.000Z', updatedAt: '2026-11-12T03:00:00.000Z', ...over,
});
const notifications = (over: Partial<Settings['notifications']> = {}): Settings['notifications'] => ({
  tz: 'Asia/Almaty', localTime: '09:15', defaultAt: '07:30', windowMinutes: 180,
  mail: { at: null, enabled: false, configured: true }, push: { at: null, enabled: false, devices: 0 }, ...over,
});

describe('тексты настроек', () => {
  it('ключ: встроенная, не проверялся, проверен, ошибка, не читается', () => {
    expect(keyStatusText(provider(null))).toBe('Работает встроенная модель — Встроенная модель (Cloudflare Workers AI). Ключи не нужны.');
    expect(keyStatusText(provider(key()))).toBe('Задания и проверку делает Groq — бесплатный gpt-oss, модель по умолчанию openai/gpt-oss-120b, ключ …6789 — ещё не проверялся.');
    expect(keyStatusText(provider(key({ custom: true, model: 'llama-3.3-70b', checkNote: 'ok', checkedAt: '2026-11-12T03:00:00.000Z' })))).toContain('модель llama-3.3-70b, ключ …6789 — проверен 12 ноября');
    expect(keyStatusText(provider(key({ checkNote: 'error:Groq 401: invalid key' })))).toContain('последняя проверка не прошла: Groq 401: invalid key');
    expect(keyStatusText(provider(key({ readable: false })))).toContain('не читается');
  });
  it('уведомления: выключены, одно время, разные времена', () => {
    expect(notificationsText(notifications())).toBe('Уведомления выключены. Включите письмо или напоминание — время по умолчанию 07:30.');
    expect(notificationsText(notifications({ mail: { at: '07:41', enabled: true, configured: true }, push: { at: '07:41', enabled: true, devices: 2 } })))
      .toBe('Письмо и напоминание в 07:41 (Asia/Almaty, сейчас там 09:15). Окно отправки — 3 часа после назначенного времени.');
    expect(notificationsText(notifications({ mail: { at: '07:41', enabled: true, configured: true }, push: { at: '08:00', enabled: true, devices: 1 } }))).toMatch(/^Письмо в 07:41, напоминание в 08:00/);
    expect(notificationsText(notifications({ push: { at: '08:00', enabled: true, devices: 1 } }))).toMatch(/^Напоминание в 08:00/);
  });
  it('счётчики: склонения, нули опускаются, пусто — профиль и анкета', () => {
    expect(countsText({ assessments: 1, cards: 14, programDays: 28, lessons: 2, rehearsals: 0, speeches: 5 })).toBe('1 тест, 2 занятия, 14 карточек, 28 дней программы, 5 записей речи');
    expect(countsText({ assessments: 0, cards: 0, programDays: 0, lessons: 0, rehearsals: 0, speeches: 0 })).toBe('пока только профиль и анкета');
    expect(countsText({ assessments: 21, cards: 0, programDays: 0, lessons: 0, rehearsals: 3, speeches: 0 })).toBe('21 тест, 3 репетиции');
  });
  it('ошибки ключа: по причине, с деталью провайдера, прочие — общий текст', () => {
    expect(keyErrorText(new ApiError(400, 'key_invalid', { reason: 'prefix' }))).toBe(KEY_REFUSALS.prefix);
    expect(keyErrorText(new ApiError(400, 'key_invalid', { reason: '???' }))).toBe(ERRORS.key_invalid);
    expect(keyErrorText(new ApiError(502, 'key_check_failed', { detail: 'Groq 401: bad' }))).toBe(`${ERRORS.key_check_failed} Ответ провайдера: Groq 401: bad`);
    expect(keyErrorText(new ApiError(409, 'key_unreadable'))).toBe(ERRORS.key_unreadable);
    expect(keyErrorText(new Error('x'))).toBe(ERRORS.request_failed);
  });
  it('проверка на клиенте повторяет серверные правила', () => {
    const groq = { id: 'groq', prefix: 'gsk_' };
    expect(validateKeyInput(undefined, 'gsk_0123456789', '')).toBe(KEY_REFUSALS.provider);
    expect(validateKeyInput(groq, 'short', '')).toBe(KEY_REFUSALS.key);
    expect(validateKeyInput(groq, 'sk-0123456789', '')).toBe(KEY_REFUSALS.prefix);
    expect(validateKeyInput(groq, 'gsk_0123456789', 'bad model')).toBe(KEY_REFUSALS.model);
    expect(validateKeyInput(groq, ' gsk_0123456789 ', 'llama-3.3-70b')).toBeNull();
    expect(validateKeyInput({ id: 'mistral', prefix: null }, 'anything-goes-here', '')).toBeNull();
    expect(keyPlaceholder('gsk_')).toBe('gsk_…'); expect(keyPlaceholder(null)).toBe('ключ провайдера');
  });
});
