/** Настройки (4.6) глубже, чем открытие экрана в `app.e2e.ts`: свой ключ провайдера и копия данных в настоящем Chromium на SQL миграций.
 *  Провайдеры подменены: запросы на api.anthropic.com и api.groq.com перехватываются в процессе стенда, наружу ничего не уходит.
 *  Ключи в сценарии ненастоящие. Проверяется главное обещание экрана: ключ уходит на сервер один раз, хранится зашифрованным
 *  и обратно не возвращается — ни на экран, ни в ответ API, ни в файл экспорта. */
import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, card, shot, inPage, EMAIL, type World } from './helpers';

const CLAUDE_KEY = 'sk-ant-e2e-not-a-real-key-0042';
const GROQ_KEY = 'gsk_e2e-not-a-real-key-7777';
const OTHER = 'other@offerly.test';
const PUSH_ENDPOINT = 'https://push.e2e.test/settings-device';
const PROVIDER_HOSTS = ['api.anthropic.com', 'api.groq.com'];

let w: World;
/** Что ответит подменённый провайдер и что он получил. */
let providerStatus = 200;
const received: { host: string; apiKey: string; model: string }[] = [];

beforeAll(async () => {
  w = await openWorld();
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    if (!PROVIDER_HOSTS.includes(host)) return real(input, init);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
    received.push({ host, apiKey: headers.get('x-api-key') ?? (headers.get('authorization') ?? '').replace(/^Bearer /, ''), model: body.model });
    if (providerStatus !== 200) return new Response('invalid api key', { status: providerStatus });
    const reply = host === 'api.anthropic.com' ? { content: [{ text: 'ok' }] } : { choices: [{ message: { content: 'ok' } }] };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await login(w.page, w.stand.url);
  await seed(w.stand);
  // Засев даёт готовый разбор без текста резюме; текст нужен, чтобы «Разобрать снова» дошёл до модели.
  w.stand.db.prepare('UPDATE profiles SET resume_text = ?').run('Energy auditor, ten years of boiler and heat network audits.');
  await w.page.goto(`${w.stand.url}/?screen=settings`);
  await heading(w.page, 'Модель').waitFor();
});
afterAll(async () => { vi.unstubAllGlobals(); await closeWorld(w); });

const model = () => card(w.page, 'Модель');
const notice = () => model().getByRole('status');
const keyRow = () => w.stand.rows<{ provider: string; model: string | null; keyEnc: string; keyHint: string; checkNote: string | null; checkedAt: string | null }>('SELECT * FROM provider_keys');
const userId = (email = EMAIL) => w.stand.rows<{ id: string }>('SELECT id FROM users WHERE email = ?', email)[0].id;
/** Ключа нет ни на странице, ни в ответе API, ни в строке базы. */
async function expectKeyHidden(key: string) {
  expect(await w.page.content()).not.toContain(key);
  expect(await (await w.ctx.request.get(`${w.stand.url}/api/settings`)).text()).not.toContain(key);
  expect(JSON.stringify(keyRow())).not.toContain(key);
}

describe('свой ключ провайдера', () => {
  it('новый ученик работает на встроенной модели, ключа в базе нет', async () => {
    expect(await text(model().locator('.muted').first())).toBe('встроенная');
    expect(await text(model())).toContain('Работает встроенная модель');
    await model().getByRole('button', { name: 'Подключить свой ключ' }).waitFor();
    expect(await model().getByRole('button', { name: 'Проверить' }).count()).toBe(0);
    expect(keyRow()).toHaveLength(0);
  });

  it('ключ с чужим префиксом и неверное имя модели не отправляются', async () => {
    await model().getByRole('button', { name: 'Подключить свой ключ' }).click();
    const save = model().getByRole('button', { name: 'Сохранить ключ' });
    await model().locator('input[type=password]').fill('wrong-prefix-key-0000');
    await model().getByText('Ключ этого провайдера начинается иначе').waitFor();
    expect(await save.isDisabled()).toBe(true);
    await model().locator('input[type=password]').fill(CLAUDE_KEY);
    await model().locator('input[type=text]').fill('плохая модель');
    await model().getByText('Имя модели — буквы, цифры').waitFor();
    expect(await save.isDisabled()).toBe(true);
    await model().locator('input[type=text]').fill('');
    expect(await save.isDisabled()).toBe(false);
    await model().getByRole('button', { name: 'отмена' }).click();
    expect(await model().locator('input[type=password]').count()).toBe(0);
    expect(keyRow()).toHaveLength(0);
  });

  it('сохранённый ключ лежит зашифрованным, наружу — только последние четыре знака', async () => {
    await model().getByRole('button', { name: 'Подключить свой ключ' }).click();
    await model().locator('input[type=password]').fill(CLAUDE_KEY);
    await model().getByRole('button', { name: 'Сохранить ключ' }).click();
    await notice().getByText('Ключ Claude сохранён (…0042)').waitFor();
    expect(await text(model().locator('.muted').first())).toBe('свой ключ · Claude');
    expect(await text(model())).toContain('ещё не проверялся');
    expect(keyRow()).toHaveLength(1);
    expect(keyRow()[0]).toMatchObject({ provider: 'anthropic', model: null, keyHint: '…0042', checkNote: null });
    expect(keyRow()[0].keyEnc).toMatch(/^v1\./);
    await expectKeyHidden(CLAUDE_KEY);
    expect(received).toHaveLength(0);
    await shot(w.page, 'settings-key');
  });

  it('отказ провайдера при проверке показан с его ответом и не уходит на встроенную модель', async () => {
    providerStatus = 401;
    const before = w.stand.ai.calls.length;
    await model().getByRole('button', { name: 'Проверить' }).click();
    await notice().getByText('Провайдер не ответил на пробный запрос').waitFor();
    expect(await text(notice())).toContain('Anthropic 401');
    expect(await text(model())).toContain('последняя проверка не прошла');
    expect(keyRow()[0].checkNote).toMatch(/^error:Anthropic 401/);
    expect(keyRow()[0].checkedAt).toBeNull();
    expect(w.stand.ai.calls.length).toBe(before);
    expect(received.at(-1)).toMatchObject({ host: 'api.anthropic.com', apiKey: CLAUDE_KEY });
  });

  it('успешная проверка: провайдер получил расшифрованный ключ, ответ на экране, дата записана', async () => {
    providerStatus = 200;
    await model().getByRole('button', { name: 'Проверить' }).click();
    await notice().getByText('Провайдер ответил: «ok»').waitFor();
    expect(await text(model())).toContain('проверен');
    expect(keyRow()[0].checkNote).toBe('ok');
    expect(keyRow()[0].checkedAt).toBeTruthy();
    expect(received.at(-1)).toMatchObject({ apiKey: CLAUDE_KEY, model: 'claude-haiku-4-5-20251001' });
    await expectKeyHidden(CLAUDE_KEY);
  });

  it('работа модели идёт через свой ключ, а при отказе провайдера — через встроенную', async () => {
    const analyze = () => w.ctx.request.post(`${w.stand.url}/api/resume/analyze`);
    let hits = received.length, builtin = w.stand.ai.calls.length;
    await analyze();
    expect(received.length).toBeGreaterThan(hits);
    expect(received.at(-1)?.apiKey).toBe(CLAUDE_KEY);
    expect(w.stand.ai.calls.length).toBe(builtin);

    providerStatus = 500;
    hits = received.length; builtin = w.stand.ai.calls.length;
    await analyze();
    expect(received.length).toBeGreaterThan(hits);
    expect(w.stand.ai.calls.length).toBeGreaterThan(builtin);
    providerStatus = 200;
  });
});

describe('копия данных', () => {
  beforeAll(async () => {
    // Устройство с адресом push-подписки — адреса и ключей подписки в файле быть не должно.
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const body = JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth }, userAgent: 'e2e' });
    const status = await inPage<number>(w.page, `fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }).then(r => r.status)`);
    expect(status).toBeLessThan(300);
    // Второй ученик: его данные в чужой файл не попадают.
    const other = await w.browser.newContext({ locale: 'ru-RU', timezoneId: 'Asia/Almaty' });
    await login(await other.newPage(), w.stand.url, OTHER);
    await seed(w.stand, OTHER);
    await other.close();
    await w.page.reload();
    await heading(w.page, 'Данные').waitFor();
  });

  it('файл скачивается под именем с карточки, сводка сходится с содержимым', async () => {
    const data = card(w.page, 'Данные');
    const name = await text(data.locator('.mono'));
    expect(name).toMatch(/^offerly-\d{4}-\d{2}-\d{2}\.json$/);
    const [download] = await Promise.all([w.page.waitForEvent('download'), data.getByRole('link', { name: 'Скачать копию данных' }).click()]);
    expect(download.suggestedFilename()).toBe(name);
    const raw = await readFile(await download.path(), 'utf-8');
    const file = JSON.parse(raw) as {
      app: string; format: number; user: { id: string; email: string };
      profile: unknown; providerKey: { provider: string; hint: string }; assessments: { attempts: unknown[] }[];
      cards: { userId: string }[]; programDays: { userId: string }[]; push: { devices: { id: string; userAgent: string }[] };
    };
    expect(file).toMatchObject({ app: 'Offerly', format: 1, user: { id: userId(), email: EMAIL } });
    expect(file.profile).toBeTruthy();
    expect(file.assessments.length).toBeGreaterThan(0);
    expect(file.cards.length).toBeGreaterThan(0);
    const summary = await text(data);
    expect(summary).toContain(`${file.assessments.length} тест`);
    expect(summary).toContain(`${file.cards.length} карточ`);
    expect(summary).toContain(`${file.programDays.length} д`);
    // Ни ключа, ни шифртекста, ни адреса подписки; подсказка ключа и устройство без адреса — есть.
    expect(file.providerKey).toMatchObject({ provider: 'anthropic', hint: '…0042' });
    expect(raw).not.toContain(CLAUDE_KEY);
    expect(raw).not.toContain(keyRow()[0].keyEnc);
    expect(raw).not.toContain(PUSH_ENDPOINT);
    expect(raw).not.toMatch(/p256dh/);
    expect(file.push.devices).toHaveLength(1);
    expect(file.push.devices[0].userAgent).toBe('e2e');
    // Только свои данные.
    expect(raw).not.toContain(OTHER);
    expect(raw).not.toContain(userId(OTHER));
    expect(file.cards.every(c => c.userId === userId())).toBe(true);
    await shot(w.page, 'settings-data');
  });

  it('без входа файл не отдаётся', async () => {
    const r = await fetch(`${w.stand.url}/api/export`);
    expect(r.status).toBe(401);
  });
});

describe('нечитаемый ключ, замена и удаление', () => {
  it('ключ, который мастер-ключ не расшифровывает, показан как нечитаемый: проверять нечего, задания идут через встроенную', async () => {
    w.stand.db.prepare('UPDATE provider_keys SET key_enc = ?').run('v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA');
    await w.page.reload();
    await heading(w.page, 'Модель').waitFor();
    expect(await text(model().locator('.muted').first())).toBe('ключ не читается');
    expect(await text(model())).toContain('Введите ключ заново или уберите его');
    expect(await model().getByRole('button', { name: 'Проверить' }).count()).toBe(0);
    const hits = received.length, builtin = w.stand.ai.calls.length;
    await w.ctx.request.post(`${w.stand.url}/api/resume/analyze`);
    expect(received.length).toBe(hits);
    expect(w.stand.ai.calls.length).toBeGreaterThan(builtin);
  });

  it('замена на другого провайдера со своей моделью делает ключ снова рабочим и сбрасывает прежнюю проверку', async () => {
    await model().getByRole('button', { name: 'Заменить ключ' }).click();
    await model().locator('select').selectOption('groq');
    await model().locator('input[type=password]').fill(GROQ_KEY);
    await model().locator('input[type=text]').fill('openai/gpt-oss-20b');
    await model().getByRole('button', { name: 'Сохранить ключ' }).click();
    await notice().getByText('Ключ Groq сохранён (…7777)').waitFor();
    expect(keyRow()).toHaveLength(1);
    expect(keyRow()[0]).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-20b', keyHint: '…7777', checkNote: null, checkedAt: null });
    await model().getByRole('button', { name: 'Проверить' }).click();
    await notice().getByText('Провайдер ответил: «ok»').waitFor();
    expect(received.at(-1)).toEqual({ host: 'api.groq.com', apiKey: GROQ_KEY, model: 'openai/gpt-oss-20b' });
    expect(await text(model())).toContain('модель openai/gpt-oss-20b');
    await expectKeyHidden(GROQ_KEY);
  });

  it('«убрать ключ» стирает строку в базе и возвращает встроенную модель', async () => {
    await model().getByRole('button', { name: 'убрать ключ' }).click();
    await notice().getByText('Ключ удалён. Работает встроенная модель.').waitFor();
    expect(await text(model().locator('.muted').first())).toBe('встроенная');
    expect(keyRow()).toHaveLength(0);
    const hits = received.length, builtin = w.stand.ai.calls.length;
    await w.ctx.request.post(`${w.stand.url}/api/resume/analyze`);
    expect(received.length).toBe(hits);
    expect(w.stand.ai.calls.length).toBeGreaterThan(builtin);
  });
});

describe('время уведомлений и выход с экрана', () => {
  it('подключённое устройство уже включило напоминание; письмо встаёт на то же время, настройка переживает перезагрузку', async () => {
    const n = () => card(w.page, 'Уведомления');
    expect(await text(n().locator('.muted').first())).toBe('в 07:30');
    expect(await text(n())).toContain('почта на сервере не настроена');
    await n().getByRole('checkbox', { name: /Напоминание на устройствах \(1\)/ }).waitFor();
    await n().locator('input[type=time]').fill('00:00');
    await n().getByRole('checkbox', { name: /Письмо на почту/ }).check();
    await n().getByRole('button', { name: 'Сохранить' }).click();
    await n().getByRole('status').getByText('Письмо и напоминание в 00:00').waitFor();
    expect(w.stand.rows<{ notifyAt: string }>('SELECT notify_at FROM profiles WHERE user_id = ?', userId())[0].notifyAt).toBe('00:00');
    expect(w.stand.rows<{ pushAt: string }>('SELECT push_at FROM push_settings WHERE user_id = ?', userId())[0].pushAt).toBe('00:00');
    await w.page.reload();
    await heading(w.page, 'Уведомления').waitFor();
    expect(await text(n().locator('.muted').first())).toBe('в 00:00');
    await n().getByRole('button', { name: 'Сохранено' }).waitFor();
  });

  it('снятые галочки выключают оба канала, устройство остаётся подключённым', async () => {
    const n = card(w.page, 'Уведомления');
    await n.getByRole('checkbox', { name: /Письмо на почту/ }).uncheck();
    await n.getByRole('checkbox', { name: /Напоминание на устройствах/ }).uncheck();
    await n.getByRole('button', { name: 'Сохранить' }).click();
    await n.getByRole('status').getByText('Уведомления выключены').waitFor();
    expect(await text(n.locator('.muted').first())).toBe('выключены');
    expect(w.stand.rows<{ notifyAt: string | null }>('SELECT notify_at FROM profiles WHERE user_id = ?', userId())[0].notifyAt).toBeNull();
    expect(w.stand.rows<{ pushAt: string | null }>('SELECT push_at FROM push_settings WHERE user_id = ?', userId())[0].pushAt).toBeNull();
    expect(w.stand.rows('SELECT id FROM push_subscriptions WHERE user_id = ?', userId())).toHaveLength(1);
    await w.page.locator('h2', { hasText: 'Настройки' }).click();
  });

  it('Esc вне поля ввода закрывает настройки', async () => {
    await w.page.keyboard.press('Escape');
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    expect(new URL(w.page.url()).searchParams.get('screen')).toBeNull();
  });
});
