import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseKeyBody, keyHint, masterKey, encryptSecret, decryptSecret, saveKey, userProvider, checkKey, publicKey, providerOptions, exportData, exportCounts, exportFileName,
  d1SettingsStore, SettingsError, KEYRING_SETTING_KEY, CHECK_PROMPT, type ProviderKey,
} from '../functions/_lib/settings';
import { chat, stripToJson, PROVIDERS, type Env as ProviderEnv } from '../functions/_lib/providers';
import { createApp, type Env } from '../functions/_lib/app';
import { freshDb, d1Of, sqlStore } from './helpers/sqliteD1';

const NOW = '2026-11-12T03:00:00.000Z';
/** Значение служебной записи app_settings или undefined. */
const setting = (mem: ReturnType<typeof sqlStore>, key: string) => mem.rows<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key)[0]?.value;
/** Хранилище с пользователями u1 и u2 — ключи провайдера ссылаются на users. */
const withUsers = () => { const mem = sqlStore(); mem.addUser('u1'); mem.addUser('u2'); return mem; };
const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const openaiReply = (content: string) => okJson({ choices: [{ message: { content } }] });
const anthropicReply = (text: string) => okJson({ content: [{ type: 'text', text }] });

afterEach(() => vi.unstubAllGlobals());

describe('ключ провайдера: проверка тела', () => {
  it('принимает провайдера из списка, ключ с префиксом и необязательную модель', () => {
    const v = parseKeyBody({ provider: 'groq', apiKey: ' gsk_abcdefgh ', model: 'llama-3.3-70b-versatile' });
    expect(v).toEqual({ ok: true, value: { provider: 'groq', apiKey: 'gsk_abcdefgh', model: 'llama-3.3-70b-versatile' } });
    // модель по умолчанию не хранится как своя
    const d = parseKeyBody({ provider: 'anthropic', apiKey: 'sk-ant-0123456789', model: 'claude-haiku-4-5-20251001' });
    expect(d.ok && d.value.model).toBeNull();
  });
  it('отклоняет встроенную модель, неизвестного провайдера, короткий ключ, пробелы, чужой префикс и странную модель', () => {
    expect(parseKeyBody({ provider: 'workers-ai', apiKey: 'x'.repeat(20) })).toEqual({ ok: false, reason: 'provider' });
    expect(parseKeyBody({ provider: 'nope', apiKey: 'x'.repeat(20) })).toEqual({ ok: false, reason: 'provider' });
    expect(parseKeyBody({ provider: 'mistral', apiKey: 'short' })).toEqual({ ok: false, reason: 'key' });
    expect(parseKeyBody({ provider: 'mistral', apiKey: 'has space inside' })).toEqual({ ok: false, reason: 'key' });
    expect(parseKeyBody({ provider: 'mistral', apiKey: 'x'.repeat(600) })).toEqual({ ok: false, reason: 'key' });
    expect(parseKeyBody({ provider: 'groq', apiKey: 'sk-notgroq12345' })).toEqual({ ok: false, reason: 'prefix' });
    expect(parseKeyBody({ provider: 'mistral', apiKey: 'abcdefghijkl', model: 'bad model name' })).toEqual({ ok: false, reason: 'model' });
    expect(parseKeyBody(null)).toEqual({ ok: false, reason: 'provider' });
  });
  it('подсказка — последние четыре знака', () => {
    expect(keyHint('gsk_abcdefgh')).toBe('…efgh');
  });
  it('список провайдеров для формы без встроенной модели, с адресами страниц ключей', () => {
    const list = providerOptions();
    expect(list.map(p => p.id)).not.toContain('workers-ai');
    expect(list.length).toBe(PROVIDERS.length - 1);
    for (const p of list) expect(p.keyUrl).toMatch(/^https:/);
  });
});

describe('шифрование ключа', () => {
  it('мастер-ключ из секрета окружения даёт один и тот же ключ, из базы — создаётся один раз и переживает перезапуск', async () => {
    const mem = withUsers();
    const a = await masterKey({ KEYS_SECRET: 'тайна' }, mem.store, NOW);
    expect(a.source).toBe('env');
    expect(mem.rows('SELECT key FROM app_settings')).toEqual([]);
    const b = await masterKey({}, mem.store, NOW);
    expect(b.source).toBe('db');
    const stored = setting(mem, KEYRING_SETTING_KEY)!;
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const c = await masterKey({}, mem.store, NOW);
    expect(setting(mem, KEYRING_SETTING_KEY)).toBe(stored);
    // шифртекст от первого вызова читается ключом второго — тот же мастер-ключ
    const enc = await encryptSecret(b.key, 'gsk_secret', 'u1');
    expect(await decryptSecret(c.key, enc, 'u1')).toBe('gsk_secret');
    // а ключ из секрета окружения его не читает
    expect(await decryptSecret(a.key, enc, 'u1')).toBeNull();
  });
  it('шифртекст формата v1.<iv>.<ct>, разные при каждом вызове, привязан к пользователю, повреждённый — null', async () => {
    const mem = withUsers();
    const { key } = await masterKey({ KEYS_SECRET: 's' }, mem.store, NOW);
    const e1 = await encryptSecret(key, 'sk-ant-abc', 'u1');
    const e2 = await encryptSecret(key, 'sk-ant-abc', 'u1');
    expect(e1).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(e1).not.toBe(e2);
    expect(await decryptSecret(key, e1, 'u1')).toBe('sk-ant-abc');
    expect(await decryptSecret(key, e1, 'u2')).toBeNull();
    expect(await decryptSecret(key, 'v1.x.y', 'u1')).toBeNull();
    expect(await decryptSecret(key, 'plain', 'u1')).toBeNull();
    expect(e1).not.toContain('sk-ant');
  });
  it('повреждённый keyring — key_unreadable', async () => {
    const mem = withUsers();
    mem.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(KEYRING_SETTING_KEY, 'short', NOW);
    await expect(masterKey({}, mem.store, NOW)).rejects.toMatchObject({ code: 'key_unreadable' });
  });
});

describe('сохранение и чтение ключа', () => {
  it('saveKey шифрует, userProvider расшифровывает; в базе открытого ключа нет; смена мастер-ключа — null', async () => {
    const mem = withUsers();
    const row = await saveKey({ KEYS_SECRET: 'one' }, mem.store, 'u1', { provider: 'groq', apiKey: 'gsk_0123456789', model: null }, NOW);
    expect(row).toMatchObject({ userId: 'u1', provider: 'groq', model: null, keyHint: '…6789', checkedAt: null, checkNote: null, createdAt: NOW, updatedAt: NOW });
    expect(JSON.stringify(mem.rows('SELECT * FROM provider_keys'))).not.toContain('gsk_0123456789');
    expect(await userProvider({ KEYS_SECRET: 'one' }, mem.store, 'u1')).toEqual({ provider: 'groq', apiKey: 'gsk_0123456789', model: null, fallback: true });
    expect(await userProvider({ KEYS_SECRET: 'two' }, mem.store, 'u1')).toBeNull();
    expect(await userProvider({ KEYS_SECRET: 'one' }, mem.store, 'u2')).toBeNull();
    // повторное сохранение заменяет провайдера, createdAt остаётся
    const later = '2026-11-13T03:00:00.000Z';
    const row2 = await saveKey({ KEYS_SECRET: 'one' }, mem.store, 'u1', { provider: 'anthropic', apiKey: 'sk-ant-xyz12345', model: 'claude-sonnet-4-5' }, later);
    expect(row2).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', keyHint: '…2345', createdAt: NOW, updatedAt: later });
    expect(mem.rows('SELECT user_id FROM provider_keys')).toEqual([{ userId: 'u1' }]);
  });
  it('publicKey — без шифртекста, с именем провайдера и моделью по умолчанию', async () => {
    const mem = withUsers();
    const row = await saveKey({ KEYS_SECRET: 'one' }, mem.store, 'u1', { provider: 'groq', apiKey: 'gsk_0123456789', model: null }, NOW);
    const pub = publicKey(row, true)!;
    expect(pub).toMatchObject({ provider: 'groq', short: 'Groq', model: 'openai/gpt-oss-120b', custom: false, hint: '…6789', readable: true });
    expect(JSON.stringify(pub)).not.toContain('keyEnc');
    expect(publicKey(null, false)).toBeNull();
  });
  it('checkKey: ответ модели → ok и checked_at; отказ провайдера → error без отката на встроенную; без ключа — key_none', async () => {
    const mem = withUsers();
    const aiRun = vi.fn(async () => ({ response: 'ok' }));
    const env = { KEYS_SECRET: 'one', AI: { run: aiRun }, DB: null, APP_NAME: 'Offerly' } as unknown as Env;
    await expect(checkKey(env, mem.store, 'u1', NOW)).rejects.toMatchObject({ code: 'key_none' });
    await saveKey(env, mem.store, 'u1', { provider: 'groq', apiKey: 'gsk_0123456789', model: null }, NOW);
    const fetchMock = vi.fn(async () => openaiReply('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkKey(env, mem.store, 'u1', NOW);
    expect(r.ok).toBe(true); expect(r.reply).toBe('ok');
    expect(r.row.checkedAt).toBe(NOW); expect(r.row.checkNote).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gsk_0123456789');
    expect(JSON.parse(init.body as string).messages[0].content).toBe(CHECK_PROMPT);
    expect(aiRun).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid api key', { status: 401 })));
    const bad = await checkKey(env, mem.store, 'u1', '2026-11-13T00:00:00.000Z');
    expect(bad.ok).toBe(false); expect(bad.detail).toContain('Groq 401');
    expect(bad.row.checkNote).toMatch(/^error:Groq 401/); expect(bad.row.checkedAt).toBe(NOW); // прошлая удачная проверка остаётся
    expect(aiRun).not.toHaveBeenCalled();
  });
  it('checkKey при смене мастер-ключа — key_unreadable', async () => {
    const mem = withUsers();
    await saveKey({ KEYS_SECRET: 'one' }, mem.store, 'u1', { provider: 'groq', apiKey: 'gsk_0123456789', model: null }, NOW);
    const env = { KEYS_SECRET: 'two', AI: null, DB: null, APP_NAME: 'Offerly' } as unknown as Env;
    await expect(checkKey(env, mem.store, 'u1', NOW)).rejects.toMatchObject({ code: 'key_unreadable' });
  });
});

describe('chat с провайдером пользователя', () => {
  const base = (over: Partial<ProviderEnv> = {}, aiRun = vi.fn(async () => ({ response: '{"from":"workers"}' }))) =>
    ({ env: { AI: { run: aiRun }, DB: null, APP_NAME: 'Offerly', ...over } as unknown as ProviderEnv, aiRun });

  it('без USER_PROVIDER — встроенная модель, как раньше', async () => {
    const { env, aiRun } = base();
    expect(await chat(env, [{ role: 'user', content: 'hi' }])).toBe('{"from":"workers"}');
    expect(aiRun).toHaveBeenCalledTimes(1);
  });
  it('с USER_PROVIDER зовёт провайдера по HTTP с ключом и его моделью; схема уходит в системную подсказку, ответ очищается', async () => {
    const fetchMock = vi.fn(async () => openaiReply('Here you go:\n```json\n{"a": 1}\n```'));
    vi.stubGlobal('fetch', fetchMock);
    const { env, aiRun } = base({ USER_PROVIDER: { provider: 'groq', apiKey: 'gsk_k', model: 'my-model', fallback: true } });
    const out = await chat(env, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { jsonSchema: { type: 'object' }, maxTokens: 50 });
    expect(out).toBe('{"a": 1}');
    expect(aiRun).not.toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('my-model');
    expect(body.max_tokens).toBe(50);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('{"type":"object"}');
    expect(body.messages.slice(1)).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  });
  it('Anthropic: system отдельно, схема в system, ключ в x-api-key, модель по умолчанию без своей', async () => {
    const fetchMock = vi.fn(async () => anthropicReply('{"b":2}'));
    vi.stubGlobal('fetch', fetchMock);
    const { env } = base({ USER_PROVIDER: { provider: 'anthropic', apiKey: 'sk-ant-k', model: null } });
    expect(await chat(env, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { jsonSchema: { type: 'object' } })).toBe('{"b":2}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toContain('JSON schema'); expect(body.system).toContain('S');
    expect(body.messages).toEqual([{ role: 'user', content: 'U' }]);
  });
  it('провайдер отказал — повтор на встроенной модели (fallback по умолчанию); fallback:false — ошибка наружу', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limit', { status: 429 })));
    const { env, aiRun } = base({ USER_PROVIDER: { provider: 'mistral', apiKey: 'k'.repeat(10), model: null } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await chat(env, [{ role: 'user', content: 'hi' }])).toBe('{"from":"workers"}');
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled(); spy.mockRestore();
    const strict = base({ USER_PROVIDER: { provider: 'mistral', apiKey: 'k'.repeat(10), model: null, fallback: false } });
    await expect(chat(strict.env, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/Mistral 429/);
    expect(strict.aiRun).not.toHaveBeenCalled();
  });
  it('явный opts.provider важнее провайдера пользователя', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openaiReply('nope')));
    const { env, aiRun } = base({ USER_PROVIDER: { provider: 'groq', apiKey: 'gsk_k', model: null } });
    expect(await chat(env, [{ role: 'user', content: 'hi' }], { provider: 'workers-ai' })).toBe('{"from":"workers"}');
    expect(aiRun).toHaveBeenCalledTimes(1);
  });
  it('stripToJson: ограждения, текст вокруг, строки со скобками, чистый объект без изменений', () => {
    expect(stripToJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripToJson('Sure! {"a":{"b":[1,2]}} Hope it helps.')).toBe('{"a":{"b":[1,2]}}');
    expect(stripToJson('{"s":"}{\\"x\\"","n":1}')).toBe('{"s":"}{\\"x\\"","n":1}');
    expect(stripToJson('  {"a":1}  ')).toBe('{"a":1}');
    expect(stripToJson('no json here')).toBe('no json here');
  });
});

describe('хранилище D1', () => {
  it('миграция 0019 создаёт provider_keys; сохранение заменяет строку, удаление возвращает признак, списки по пользователю', async () => {
    const db = freshDb();
    db.exec("INSERT INTO users (id, email, created_at) VALUES ('u1', 'y@example.com', '2026-10-30T00:00:00.000Z'), ('u2', 'z@example.com', '2026-10-30T00:00:00.000Z')");
    db.exec("INSERT INTO assessments (id, user_id, kind, status, started_at) VALUES ('a2', 'u1', 'placement', 'finished', '2026-11-02T00:00:00.000Z'), ('a1', 'u1', 'baseline', 'finished', '2026-10-29T00:00:00.000Z'), ('ax', 'u2', 'placement', 'active', '2026-11-03T00:00:00.000Z')");
    db.exec("INSERT INTO speech_takes (id, user_id, text, duration, words, wpm, pauses, longest_pause, fillers, fluency, model, created_at) VALUES ('s1', 'u1', 'hello there', 2.5, 2, 48, 0, 0, 0, 20, 'w', '2026-11-05T00:00:00.000Z')");
    const store = d1SettingsStore(d1Of(db));
    expect(await store.getProviderKey('u1')).toBeNull();
    const row: ProviderKey = { userId: 'u1', provider: 'groq', model: null, keyEnc: 'v1.a.b', keyHint: '…6789', checkedAt: null, checkNote: null, createdAt: NOW, updatedAt: NOW };
    await store.saveProviderKey(row);
    expect(await store.getProviderKey('u1')).toEqual(row);
    await store.saveProviderKey({ ...row, provider: 'anthropic', model: 'm', keyEnc: 'v1.c.d', keyHint: '…0000', checkedAt: NOW, checkNote: 'ok', updatedAt: '2026-11-13T00:00:00.000Z' });
    expect(await store.getProviderKey('u1')).toMatchObject({ provider: 'anthropic', model: 'm', keyEnc: 'v1.c.d', checkNote: 'ok', createdAt: NOW });
    expect(db.prepare('SELECT count(*) AS n FROM provider_keys').get()).toEqual({ n: 1 });
    expect((await store.listAssessments('u1')).map(a => a.id)).toEqual(['a1', 'a2']);
    expect((await store.listSpeeches('u1')).map(s => s.text)).toEqual(['hello there']);
    expect(await store.deleteProviderKey('u1')).toBe(true);
    expect(await store.deleteProviderKey('u1')).toBe(false);
  });
});

describe('экспорт', () => {
  it('собирает все данные пользователя без ключа, без адресов push и без сессий; имя файла по дате', async () => {
    const mem = sqlStore();
    const user = { id: 'u1', email: 'y@example.com', name: null, locale: 'ru', tz: 'Asia/Almaty' };
    mem.addUser('u1', user.email, user.tz);
    await mem.store.insertSession({ id: 'sess-secret', userId: 'u1', createdAt: NOW, expiresAt: '2027-01-01T00:00:00.000Z' } as any);
    await saveKey({ KEYS_SECRET: 'one' }, mem.store, 'u1', { provider: 'groq', apiKey: 'gsk_0123456789', model: null }, NOW);
    await mem.store.upsertPushSubscription({ id: 's1', userId: 'u1', endpoint: 'https://push.example/secret-endpoint', p256dh: 'P256', auth: 'AUTHSECRET', userAgent: 'Chrome', createdAt: NOW, lastSentAt: null, lastError: null });
    await mem.store.createAssessment({ id: 'a1', userId: 'u1', kind: 'baseline', status: 'finished', startedAt: NOW, finishedAt: NOW, level: 'B1', currentLevel: 'B1', updatedAt: NOW, axes: null, overall: 53, scoredAt: null, scoringNote: null, adaptiveCount: 12, programDayId: null });
    const data = await exportData(mem.store, user, '0.21.0', NOW);
    expect(data).toMatchObject({ app: 'Offerly', version: '0.21.0', exportedAt: NOW, format: 1, user: { id: 'u1', email: 'y@example.com', tz: 'Asia/Almaty' } });
    expect(data.providerKey).toEqual({ provider: 'groq', model: null, hint: '…6789', checkedAt: null, checkNote: null, createdAt: NOW });
    expect(data.assessments).toHaveLength(1); expect(data.assessments[0]).toMatchObject({ id: 'a1', attempts: [] });
    expect(data.push.devices).toEqual([{ id: 's1', userAgent: 'Chrome', createdAt: NOW, lastSentAt: null, lastError: null }]);
    const text = JSON.stringify(data);
    for (const secret of ['gsk_0123456789', 'secret-endpoint', 'AUTHSECRET', 'P256', 'sess-secret', 'keyEnc']) expect(text).not.toContain(secret);
    expect(await exportCounts(mem.store, 'u1')).toEqual({ assessments: 1, cards: 0, programDays: 0, lessons: 0, rehearsals: 0, speeches: 0 });
    expect(exportFileName('2026-11-12')).toBe('offerly-2026-11-12.json');
  });
});

describe('маршруты /api/settings и /api/export', () => {
  const appEnv = { DB: null, AI: { run: async () => ({ response: 'ok' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1', KEYS_SECRET: 'one' } as unknown as Env;
  async function login(mem: ReturnType<typeof sqlStore>, env: Env = appEnv) {
    const app = createApp('0.21.0');
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, { ...env, DB: mem.DB });
    const r1 = await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com' }) });
    const { code } = await r1.json() as any;
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com', code }) });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const json = (path: string, method: string, body: unknown) => call(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const get = (path: string) => call(path, { headers: { cookie } });
    return { app, call, cookie, json, get, uid: mem.rows<{ id: string }>('SELECT id FROM users WHERE email = ?', 'y@example.com')[0].id };
  }

  it('без cookie — 401 на всех маршрутах', async () => {
    const mem = sqlStore();
    const app = createApp('0.21.0');
    for (const [path, method] of [['/settings', 'GET'], ['/settings/key', 'PUT'], ['/settings/key/check', 'POST'], ['/settings/key', 'DELETE'], ['/settings/notifications', 'PUT'], ['/export', 'GET']] as const) {
      const r = await app.request(`https://offerly.test/api${path}`, { method }, { ...appEnv, DB: mem.DB });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it('GET /settings без ключа: провайдеры, встроенная модель, уведомления выключены, счётчики нули', async () => {
    const mem = sqlStore();
    const { get } = await login(mem);
    const j: any = await (await get('/settings')).json();
    expect(j.ok).toBe(true);
    expect(j.provider.key).toBeNull();
    expect(j.provider.keySource).toBe('env');
    expect(j.provider.providers.map((p: any) => p.id)).toContain('groq');
    expect(j.provider.builtin).toContain('Workers AI');
    expect(j.notifications).toMatchObject({ defaultAt: '07:30', mail: { at: null, enabled: false, configured: false }, push: { at: null, enabled: false, devices: 0 } });
    expect(j.notifications.localTime).toMatch(/^\d\d:\d\d$/);
    expect(j.data.counts).toEqual({ assessments: 0, cards: 0, programDays: 0, lessons: 0, rehearsals: 0, speeches: 0 });
    expect(j.data.file).toMatch(/^offerly-\d{4}-\d\d-\d\d\.json$/);
  });

  it('PUT /settings/key сохраняет шифрованно и показывает подсказку; после этого модель зовётся через провайдера; DELETE возвращает встроенную', async () => {
    const mem = sqlStore();
    const { json, get, uid } = await login(mem);
    const bad = await json('/settings/key', 'PUT', { provider: 'groq', apiKey: 'sk-wrong-prefix' });
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ ok: false, error: 'key_invalid', reason: 'prefix' });
    const r = await json('/settings/key', 'PUT', { provider: 'groq', apiKey: 'gsk_0123456789', model: '' });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.provider.key).toMatchObject({ provider: 'groq', short: 'Groq', hint: '…6789', readable: true, custom: false, checkedAt: null });
    expect(JSON.stringify(j)).not.toContain('gsk_0123456789');
    expect(mem.rows('SELECT key_enc FROM provider_keys WHERE user_id = ?', uid)[0].keyEnc).toMatch(/^v1\./);
    // /ai/ping без провайдера в теле → встроенная; а защищённый маршрут с моделью (разбор резюме) пойдёт через Groq
    const fetchMock = vi.fn(async () => openaiReply(JSON.stringify({ specialty: 'инженер', industry: 'энергетика', years: 15, target_role: null, keywords: ['boiler'], summary: 'Вы инженер.' })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await json('/resume', 'POST', { text: 'Thermal power engineer with fifteen years of experience in boilers, turbines and energy audits of district heating plants and industrial sites across Kazakhstan. '.repeat(3) });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer gsk_0123456789');
    const d = await json('/settings/key', 'DELETE', {});
    const dj: any = await d.json();
    expect(dj.removed).toBe(true); expect(dj.provider.key).toBeNull();
    expect((await (await json('/settings/key', 'DELETE', {})).json() as any).removed).toBe(false);
    expect(((await (await get('/settings')).json()) as any).provider.key).toBeNull();
  });

  it('POST /settings/key/check: без ключа 404, успех → checkedAt, отказ провайдера → 502 с деталью; ключ под другим мастер-ключом → 409', async () => {
    const mem = sqlStore();
    const { json } = await login(mem);
    expect((await json('/settings/key/check', 'POST', {})).status).toBe(404);
    await json('/settings/key', 'PUT', { provider: 'anthropic', apiKey: 'sk-ant-0123456789' });
    vi.stubGlobal('fetch', vi.fn(async () => anthropicReply('ok')));
    const ok: any = await (await json('/settings/key/check', 'POST', {})).json();
    expect(ok.ok).toBe(true); expect(ok.reply).toBe('ok'); expect(ok.provider.key.checkNote).toBe('ok'); expect(ok.provider.key.checkedAt).toBeTruthy();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid x-api-key"}', { status: 401 })));
    const r = await json('/settings/key/check', 'POST', {});
    expect(r.status).toBe(502);
    const bad: any = await r.json();
    expect(bad).toMatchObject({ ok: false, error: 'key_check_failed' }); expect(bad.detail).toContain('Anthropic 401'); expect(bad.provider.key.checkNote).toMatch(/^error:/);
    // мастер-ключ сменился: ключ не читается — 409, GET показывает readable:false, встроенная модель работает
    const other = await login(mem, { ...appEnv, KEYS_SECRET: 'two' } as Env);
    expect((await other.json('/settings/key/check', 'POST', {})).status).toBe(409);
    const view: any = await (await other.get('/settings')).json();
    expect(view.provider.key.readable).toBe(false);
  });

  it('PUT /settings/notifications ставит одно время обоим каналам; push без устройств — 404; снятая галочка выключает канал', async () => {
    const mem = sqlStore();
    const { json, get, uid } = await login(mem);
    expect((await json('/settings/notifications', 'PUT', { at: '7:5', mail: true })).status).toBe(400);
    expect((await json('/settings/notifications', 'PUT', { at: '08:00', mail: true, push: true })).status).toBe(404);
    const r: any = await (await json('/settings/notifications', 'PUT', { at: '08:00', mail: true, push: false })).json();
    expect(r.notifications.mail).toMatchObject({ at: '08:00', enabled: true });
    expect(r.notifications.push).toMatchObject({ at: null, enabled: false });
    expect(mem.rows('SELECT notify_at FROM profiles WHERE user_id = ?', uid)[0].notifyAt).toBe('08:00');
    await mem.store.upsertPushSubscription({ id: 's1', userId: uid, endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a', userAgent: null, createdAt: NOW, lastSentAt: null, lastError: null });
    const r2: any = await (await json('/settings/notifications', 'PUT', { at: '06:30', mail: true, push: true })).json();
    expect(r2.notifications.mail.at).toBe('06:30'); expect(r2.notifications.push).toMatchObject({ at: '06:30', enabled: true, devices: 1 });
    expect(mem.rows('SELECT push_at FROM push_settings WHERE user_id = ?', uid)[0].pushAt).toBe('06:30');
    // карточки письма и напоминания видят то же
    expect(((await (await get('/digest?preview=0')).json()) as any).notifyAt).toBe('06:30');
    expect(((await (await get('/push')).json()) as any).pushAt).toBe('06:30');
    const r3: any = await (await json('/settings/notifications', 'PUT', { mail: false, push: false })).json();
    expect(r3.notifications.mail.enabled).toBe(false); expect(r3.notifications.push.enabled).toBe(false);
    expect(mem.rows('SELECT notify_at, push_at FROM profiles JOIN push_settings USING (user_id) WHERE user_id = ?', uid)).toEqual([{ notifyAt: null, pushAt: null }]);
  });

  it('GET /export отдаёт JSON-файл с заголовком вложения, версией и без ключа', async () => {
    const mem = sqlStore();
    const { json, get } = await login(mem);
    await json('/settings/key', 'PUT', { provider: 'groq', apiKey: 'gsk_0123456789' });
    const r = await get('/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="offerly-\d{4}-\d\d-\d\d\.json"$/);
    const text = await r.text();
    expect(text).not.toContain('gsk_0123456789');
    const j = JSON.parse(text);
    expect(j).toMatchObject({ app: 'Offerly', version: '0.21.0', format: 1, user: { email: 'y@example.com' }, providerKey: { provider: 'groq', hint: '…6789' } });
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['profile', 'assessments', 'cards', 'programDays', 'lessons', 'rehearsals', 'achievements', 'speeches', 'push']));
  });
});
