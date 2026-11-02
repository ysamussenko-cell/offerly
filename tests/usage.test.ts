import { describe, expect, it, vi } from 'vitest';
import { createApp, d1AllStores, type Env } from '../functions/_lib/app';
import { countingAi, DEEP_CHECK_TTL_MS, d1UsageStore, usagePath } from '../functions/_lib/usage';
import { d1Of, freshDb } from './helpers/sqliteD1';

const sqliteD1 = () => d1Of(freshDb());

const today = () => new Date().toISOString().slice(0, 10);

function stand(version = 'v1') {
  const DB = sqliteD1();
  const run = vi.fn(async () => ({ response: 'ok' }));
  const env = { DB, AI: { run }, APP_NAME: 'test' } as unknown as Env;
  const call = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.request(`/api${path}`, init, env);
  return { DB, env, run, call, app: createApp(version) };
}

describe('расход встроенной модели', () => {
  it('область запроса — первые два сегмента', () => {
    expect(usagePath('/api/lesson/abc/answer')).toBe('/api/lesson');
    expect(usagePath('/api/health')).toBe('/api/health');
  });

  it('счётчик различает успех и отказ, ошибка модели доходит до вызывающего', async () => {
    const store = d1UsageStore(sqliteD1());
    const run = vi.fn().mockResolvedValueOnce({ response: 'ok' }).mockRejectedValueOnce(new Error('4006'));
    const ai = countingAi({ run } as any, '/api/lesson', store);
    await expect((ai as any).run('m', {})).resolves.toEqual({ response: 'ok' });
    await expect((ai as any).run('m', {})).rejects.toThrow('4006');
    expect(await store.aiUsage(today())).toEqual([{ path: '/api/lesson', model: 'm', calls: 2, errors: 1 }]);
  });

  it('сбой учёта не мешает ответу модели', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = countingAi({ run: async () => 'ok' } as any, '/api/x', { countAiCall: async () => { throw new Error('db'); } });
    await expect((ai as any).run('m', {})).resolves.toBe('ok');
    error.mockRestore();
  });

  it('POST /ai/ping закрыт: модель без входа не вызвать', async () => {
    const { app, call, run } = stand();
    const r = await call(app, '/ai/ping', { method: 'POST', body: JSON.stringify({ prompt: 'hi' }) });
    expect(r.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it('health?deep=1 не вызывает модель', async () => {
    const { app, call, run } = stand();
    const j: any = await (await call(app, '/health?deep=1')).json();
    expect(j.extract).toBe('ok');
    expect(j.ai_chat).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('health?deep=2: повтор той же версии берёт итог из кэша, новая версия проверяется заново', async () => {
    const { app, call, run, env } = stand('v1');
    const first: any = await (await call(app, '/health?deep=2')).json();
    const spent = run.mock.calls.length;
    expect(spent).toBeGreaterThan(0);
    expect(first.deep_cached_at).toBeUndefined();
    expect(first.ai_usage[0]).toMatchObject({ path: '/api/health' });

    const second: any = await (await call(app, '/health?deep=2')).json();
    expect(run.mock.calls.length).toBe(spent);
    expect(second.ai_chat).toBe(first.ai_chat);
    expect(second.deep_cached_at).toEqual(expect.any(String));

    await createApp('v2').request('/api/health?deep=2', undefined, env);
    expect(run.mock.calls.length).toBeGreaterThan(spent);
  });

  it('залп запросов к health?deep=2 проверяет модель один раз', async () => {
    const { app, call, run } = stand();
    await call(app, '/health?deep=2');
    const once = run.mock.calls.length;
    await Promise.all(Array.from({ length: 5 }, () => call(app, '/health?deep=2')));
    expect(run.mock.calls.length).toBe(once);
  });

  it('устаревшая самопроверка занимается снова, свежая — нет', async () => {
    const store = d1UsageStore(sqliteD1());
    const t0 = new Date('2026-11-02T00:00:00Z').getTime();
    const claim = (ms: number) => store.claimDeepCheck('v', new Date(t0 + ms).toISOString(), new Date(t0 + ms - DEEP_CHECK_TTL_MS).toISOString());
    expect(await claim(0)).toBe(true);
    expect(await claim(DEEP_CHECK_TTL_MS - 1000)).toBe(false);
    expect(await claim(DEEP_CHECK_TTL_MS + 1000)).toBe(true);
  });

  it('d1AllStores включает учёт', () => {
    expect(typeof d1AllStores({ DB: sqliteD1() } as unknown as Env).aiUsage).toBe('function');
  });
});
