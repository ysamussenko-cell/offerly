import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseLatest, fetchRelease, fileNameOf, latestUrl, LATEST_URL, RELEASES_URL, CACHE_SECONDS } from '../functions/_lib/release';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';

const SETUP_URL = 'https://github.com/ysamussenko-cell/offerly/releases/download/v0.23.0/Offerly_0.23.0_x64-setup.exe';
const LATEST = {
  version: '0.23.0',
  notes: 'Трей, нативные уведомления, автообновление.',
  pub_date: '2026-11-03T06:30:00Z',
  platforms: { 'windows-x86_64': { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==', url: SETUP_URL } },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('latest.json релиза: разбор', () => {
  it('формат Tauri: версия, дата в ISO, заметки, установщик Windows с именем файла и признаком подписи', () => {
    const p = parseLatest(LATEST)!;
    expect(p.version).toBe('0.23.0');
    expect(p.publishedAt).toBe('2026-11-03T06:30:00.000Z');
    expect(p.notes).toBe('Трей, нативные уведомления, автообновление.');
    expect(p.windows).toEqual({ url: SETUP_URL, name: 'Offerly_0.23.0_x64-setup.exe', signed: true });
  });
  it('версия с «v», без даты и заметок; ключи windows-* — x86_64 и nsis предпочтительнее; без подписи — signed:false', () => {
    const p = parseLatest({
      version: 'v1.2.3', platforms: {
        'windows-aarch64': { url: 'https://example.com/arm.exe' },
        'windows-x86_64-msi': { url: 'https://example.com/Offerly%20Setup.msi' },
        'windows-x86_64-nsis': { url: 'https://example.com/setup.exe' },
      },
    })!;
    expect(p.version).toBe('1.2.3');
    expect(p.publishedAt).toBeNull(); expect(p.notes).toBeNull();
    expect(p.windows).toEqual({ url: 'https://example.com/setup.exe', name: 'setup.exe', signed: false });
    expect(fileNameOf('https://example.com/Offerly%20Setup.msi')).toBe('Offerly Setup.msi');
    expect(fileNameOf('not a url')).toBeNull();
  });
  it('релиз без сборки для Windows → windows:null; мусор, массив, плохая версия, http-адрес → null или без установщика', () => {
    expect(parseLatest({ version: '0.1.0', platforms: { 'darwin-aarch64': { url: 'https://x/y.dmg' } } })!.windows).toBeNull();
    expect(parseLatest({ version: '0.1.0' })!.windows).toBeNull();
    expect(parseLatest({ version: '0.1.0', platforms: { 'windows-x86_64': { url: 'http://insecure/x.exe' } } })!.windows).toBeNull();
    expect(parseLatest(null)).toBeNull();
    expect(parseLatest([])).toBeNull();
    expect(parseLatest('text')).toBeNull();
    expect(parseLatest({ version: 'latest' })).toBeNull();
    expect(parseLatest({ platforms: {} })).toBeNull();
  });
  it('длинные заметки и странная дата обрезаются и отбрасываются', () => {
    const p = parseLatest({ version: '0.1.0', notes: 'x'.repeat(5000), pub_date: 'вчера' })!;
    expect(p.notes!.length).toBe(2000);
    expect(p.publishedAt).toBeNull();
  });
});

describe('fetchRelease', () => {
  it('ходит за latest.json GitHub с кэшем края и собирает ответ с установщиком', async () => {
    const fetchMock = vi.fn(async () => json(LATEST));
    const r = await fetchRelease({}, fetchMock as unknown as typeof fetch);
    expect(r).toMatchObject({ available: true, version: '0.23.0', windows: { url: SETUP_URL, name: 'Offerly_0.23.0_x64-setup.exe', signed: true }, releasesUrl: RELEASES_URL, source: LATEST_URL });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { cf: { cacheTtl: number } }];
    expect(url).toBe(LATEST_URL);
    expect(init.cf).toEqual({ cacheTtl: CACHE_SECONDS, cacheEverything: true });
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });
  it('RELEASE_URL из окружения заменяет адрес; мусор в переменной игнорируется', async () => {
    expect(latestUrl({ RELEASE_URL: 'https://cdn.example/latest.json' })).toBe('https://cdn.example/latest.json');
    expect(latestUrl({ RELEASE_URL: 'ftp://nope' })).toBe(LATEST_URL);
    expect(latestUrl({})).toBe(LATEST_URL);
    const fetchMock = vi.fn(async () => json(LATEST));
    const r = await fetchRelease({ RELEASE_URL: 'https://cdn.example/latest.json' }, fetchMock as unknown as typeof fetch);
    expect(r.source).toBe('https://cdn.example/latest.json');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://cdn.example/latest.json');
  });
  it('404 — релизов ещё нет (none); 500 — error с кодом; сбой сети — error network; не-JSON — error; релиз без Windows — no_windows', async () => {
    expect(await fetchRelease({}, (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch)).toMatchObject({ available: false, reason: 'none', detail: null });
    expect(await fetchRelease({}, (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)).toMatchObject({ available: false, reason: 'error', detail: 'HTTP 500' });
    const net = await fetchRelease({}, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    expect(net).toMatchObject({ available: false, reason: 'error' });
    expect((net as { detail: string }).detail).toContain('network: fetch failed');
    const html = await fetchRelease({}, (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch);
    expect(html).toMatchObject({ available: false, reason: 'error' });
    expect((html as { detail: string }).detail).toMatch(/не разобран/);
    expect(await fetchRelease({}, (async () => json({ platforms: {} })) as unknown as typeof fetch)).toMatchObject({ available: false, reason: 'error', detail: 'latest.json без версии' });
    const mac = await fetchRelease({}, (async () => json({ version: '0.5.0', platforms: { 'darwin-aarch64': { url: 'https://x/y.dmg' } } })) as unknown as typeof fetch);
    expect(mac).toMatchObject({ available: false, reason: 'no_windows' });
    expect((mac as { detail: string }).detail).toContain('0.5.0');
    const big = await fetchRelease({}, (async () => new Response('x'.repeat(70_000), { status: 200 })) as unknown as typeof fetch);
    expect(big).toMatchObject({ available: false, reason: 'error' });
  });
});

describe('GET /api/release', () => {
  function makeApp(envExtra: Partial<Env> = {}) {
    const mem = memoryStore();
    const env = { DB: null, AI: null, APP_NAME: 'Offerly', ...envExtra } as unknown as Env;
    const app = createApp('test', () => mem.store);
    return (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
  }
  it('открыт без сессии, отдаёт релиз и заголовок кэша', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(LATEST)));
    const r = await makeApp()('/release');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(`public, max-age=${CACHE_SECONDS}`);
    const j: any = await r.json();
    expect(j.ok).toBe(true); expect(j.available).toBe(true);
    expect(j.windows.url).toBe(SETUP_URL); expect(j.version).toBe('0.23.0');
  });
  it('без релизов — 200 и available:false, страница сама скажет, что установщик готовится', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const r = await makeApp()('/release');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, available: false, reason: 'none', releasesUrl: RELEASES_URL });
  });
});
