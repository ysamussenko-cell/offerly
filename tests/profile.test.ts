import { describe, it, expect, vi } from 'vitest';
import { extractJsonObject, normalizeAnalysis, analyzeResume, MAX_KEYWORDS, MODEL_TEXT_CHARS } from '../functions/_lib/profile';

const GOOD = {
  specialty: 'инженер-теплоэнергетик', industry: 'энергетика', years: 15, target_role: 'эксперт по оценке ответов ИИ',
  keywords: ['boiler efficiency', 'steam turbine', 'energy audit', 'Boiler Efficiency', 'heat balance'],
  summary: 'Вы инженер-теплоэнергетик с пятнадцатилетним опытом.',
};

describe('разбор JSON из ответа модели', () => {
  it('достаёт объект из текста и ограждения ```json', () => {
    const raw = 'Here is the profile:\n```json\n' + JSON.stringify(GOOD) + '\n```\nHope this helps.';
    expect(extractJsonObject(raw)).toEqual(GOOD);
  });
  it('не путается в фигурных скобках внутри строк', () => {
    expect(extractJsonObject('{"a": "x } y", "b": {"c": 1}} trailing }')).toEqual({ a: 'x } y', b: { c: 1 } });
  });
  it('без объекта или с битым JSON — null', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"a": }')).toBeNull();
  });
});

describe('нормализация профиля', () => {
  it('приводит поля к типам, убирает дубли ключевых слов', () => {
    const a = normalizeAnalysis(GOOD)!;
    expect(a.specialty).toBe('инженер-теплоэнергетик');
    expect(a.years).toBe(15);
    expect(a.targetRole).toBe('эксперт по оценке ответов ИИ');
    expect(a.keywords).toEqual(['boiler efficiency', 'steam turbine', 'energy audit', 'heat balance']);
  });
  it('стаж из строки и вне диапазона', () => {
    expect(normalizeAnalysis({ ...GOOD, years: '12 years' })!.years).toBe(12);
    expect(normalizeAnalysis({ ...GOOD, years: 0 })!.years).toBeNull();
    expect(normalizeAnalysis({ ...GOOD, years: 120 })!.years).toBeNull();
  });
  it('режет длинные списки и пустой ответ отбрасывает', () => {
    const many = Array.from({ length: 40 }, (_, i) => `term ${i}`);
    expect(normalizeAnalysis({ ...GOOD, keywords: many })!.keywords).toHaveLength(MAX_KEYWORDS);
    expect(normalizeAnalysis({ years: 3 })).toBeNull();
    expect(normalizeAnalysis('string')).toBeNull();
  });
});

describe('analyzeResume', () => {
  const env = { DB: null, AI: null, APP_NAME: 'Offerly' } as any;
  it('обрезает текст для модели и возвращает профиль', async () => {
    const chatFn = vi.fn(async () => JSON.stringify(GOOD));
    const a = await analyzeResume(env, 'x'.repeat(MODEL_TEXT_CHARS + 500), { chatFn });
    expect(a.industry).toBe('энергетика');
    const [, messages] = chatFn.mock.calls[0] as any;
    expect(messages[1].content.length).toBeLessThanOrEqual(MODEL_TEXT_CHARS + 20);
  });
  it('повторяет запрос один раз, если пришёл не JSON', async () => {
    const chatFn = vi.fn().mockResolvedValueOnce('Sorry, I cannot do that.').mockResolvedValueOnce(JSON.stringify(GOOD));
    const a = await analyzeResume(env, 'resume', { chatFn });
    expect(a.specialty).toBe('инженер-теплоэнергетик');
    expect(chatFn).toHaveBeenCalledTimes(2);
    const [, messages] = chatFn.mock.calls[1] as any;
    expect(messages.at(-1).content).toMatch(/not valid JSON/);
  });
  it('после двух неудач — ошибка с началом ответа модели', async () => {
    const chatFn = vi.fn(async () => 'nope');
    await expect(analyzeResume(env, 'resume', { chatFn })).rejects.toThrow(/не вернула профиль/);
    expect(chatFn).toHaveBeenCalledTimes(2);
  });
});

describe('JSON-режим модели', () => {
  it('Workers AI получает json_schema, ответ-объект превращается в строку', async () => {
    const { chat } = await import('../functions/_lib/providers');
    const { ANALYSIS_SCHEMA } = await import('../functions/_lib/profile');
    const run = vi.fn(async (_m: string, input: any) => {
      expect(input.response_format).toEqual({ type: 'json_schema', json_schema: ANALYSIS_SCHEMA });
      return { response: { specialty: 'x' } };
    });
    const env: any = { AI: { run }, DB: null, APP_NAME: 'Offerly' };
    expect(await chat(env, [{ role: 'user', content: 'hi' }], { jsonSchema: ANALYSIS_SCHEMA })).toBe('{"specialty":"x"}');
  });
});
