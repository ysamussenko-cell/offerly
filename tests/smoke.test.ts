import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { GROUPS, runSmoke, annotation, escapeData, parseArgs } from '../scripts/smoke.mjs';

/** Дымовые проверки scripts/smoke.mjs прогоняются против API в памяти; статика PWA — заглушки, как их отдаёт Pages. */
const SHELL = '<!doctype html><html><head><script>document.documentElement.dataset.theme="light";/* data-theme */</script></head><body><div id="root"></div></body></html>';
const STATIC: Record<string, () => Response> = {
  '/': () => new Response(SHELL),
  '/install': () => new Response(SHELL),
  '/sw.js': () => new Response('importScripts("push-sw.js");'),
  '/push-sw.js': () => new Response('self.addEventListener("push", () => {});'),
  '/manifest.webmanifest': () => new Response('{}'),
};

function stand(patch: (path: string, init?: RequestInit) => Response | null = () => null) {
  const mem = memoryStore();
  const env = {
    DB: { prepare: () => ({ first: async () => ({ 1: 1 }) }) },
    AI: { run: async () => ({ response: 'ok' }) },
    APP_NAME: 'Offerly',
  } as unknown as Env;
  const app = createApp('test', () => mem.store);
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const patched = patch(path, init);
    if (patched) return patched;
    if (path.startsWith('/api/')) return app.request(url.pathname + url.search, init, env);
    return STATIC[path]?.() ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('scripts/smoke.mjs', () => {
  it('против настоящего API все группы проходят: закрытые маршруты отвечают 401, открытые — 200', async () => {
    // релиз GitHub недоступен — /api/release всё равно 200 с available:false
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const { fetcher } = stand();
    const lines: string[] = [];
    const res = await runSmoke('https://offerly.test/', { fetch: fetcher, log: l => lines.push(l), retries: 0 });
    expect(res.annotations.filter(a => a.level === 'error')).toEqual([]);
    expect(res.ok).toBe(true);
    expect(lines.every(l => /^::(notice|warning|error) title=[\w ]+::[^\n]*$/.test(l))).toBe(true);
    const titles = res.annotations.filter(a => a.level === 'notice').map(a => a.title);
    expect(titles).toEqual(['health', 'auth', 'resume', 'onboarding', 'items', 'assessment', 'cards', 'program', 'lesson', 'achievements', 'dashboard',
      'extract', 'pwa', 'rehearsal', 'voice', 'checkpoint', 'digest', 'push', 'settings', 'install']);
    const msg = (t: string) => res.annotations.find(a => a.title === t && a.level === 'notice')!.message;
    expect(msg('auth')).toContain('POST /api/auth/request с плохим адресом → 400');
    expect(msg('items')).toMatch(/^GET \/api\/items\/topics → 200 \(\d+ тем/);
    expect(msg('pwa')).toContain('скрипт темы в index.html: 1');
    expect(msg('push')).toContain('подключён в sw.js: 1');
    expect(msg('install')).toContain('GET /api/release → 200, без установщика');
    expect(msg('digest')).toContain('worker без адреса');
  });

  it('в каждой группе (= шаге workflow) не больше 10 аннотаций notice — предел GitHub', () => {
    for (const [g, checks] of Object.entries(GROUPS)) expect(checks.length, g).toBeLessThanOrEqual(10);
  });

  it('маршрут, открытый без cookie, роняет группу: error и ok:false', async () => {
    const { fetcher } = stand(p => p === '/api/cards' ? new Response('[]', { status: 200 }) : null);
    const res = await runSmoke('https://offerly.test', { fetch: fetcher, groups: ['smoke'], log: () => {} });
    expect(res.ok).toBe(false);
    expect(res.annotations.filter(a => a.level === 'error')).toEqual([{ group: 'smoke', level: 'error', title: 'cards', message: 'неожиданные коды ответа' }]);
    expect(res.annotations.find(a => a.title === 'cards')!.message).toBe('GET /api/cards → 200 (без cookie, ждём 401 везде)');
  });

  it('health ждёт, пока адрес оживёт, и падает, если так и не ожил', async () => {
    let n = 0;
    const { fetcher } = stand(p => p === '/api/health' && n++ < 2 ? new Response('starting', { status: 503 }) : null);
    const sleep = vi.fn(async () => {});
    const ok = await runSmoke('https://offerly.test', { fetch: fetcher, groups: ['health'], retries: 3, retryDelayMs: 5, sleep, log: () => {} });
    expect(ok.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(ok.annotations[0].message).toMatch(/"ok":true/);

    const dead = stand(p => p === '/api/health' ? new Response('{"ok":false,"db":"error","ai":"ok"}', { status: 200 }) : null);
    const bad = await runSmoke('https://offerly.test', { fetch: dead.fetcher, groups: ['health'], retries: 1, sleep, log: () => {} });
    expect(bad.ok).toBe(false);
    expect(bad.annotations.map(a => a.level)).toEqual(['notice', 'error']);
  });

  it('сбой самопроверки извлечения — ошибка; модель и голос — только предупреждения', async () => {
    const { fetcher } = stand(p => p === '/api/health' ? new Response(JSON.stringify({ ok: true, extract: 'error: pdf', ai_chat: 'error: 429', analysis: 'error: x', voice: 'error: tts', push: 'db' })) : null);
    const res = await runSmoke('https://offerly.test', { fetch: fetcher, groups: ['deep'], log: () => {} });
    expect(res.ok).toBe(false);
    const by = (l: string) => res.annotations.filter(a => a.level === l).map(a => a.title);
    expect(by('error')).toEqual(['extract']);
    expect(by('warning')).toEqual(['ai_chat', 'analysis', 'voice', 'digest']);
    expect(res.annotations.find(a => a.title === 'push')!.message).toContain('ключи VAPID: db');
  });

  it('сетевой сбой не бросает исключение, а даёт код 0 и ошибку; неизвестная группа — ошибка', async () => {
    const res = await runSmoke('https://offerly.test', { fetch: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch, groups: ['install', 'nope'], log: () => {} });
    expect(res.ok).toBe(false);
    expect(res.annotations[0].message).toContain('GET /install → 0');
    expect(res.annotations.at(-1)!.message).toMatch(/^нет группы nope/);
  });

  it('аннотация — одна строка: перевод строки и % экранируются по правилам GitHub', () => {
    expect(escapeData('a\nb\r100%')).toBe('a%0Ab%0D100%25');
    expect(annotation('notice', 'x', 'a\nb')).toBe('::notice title=x::a%0Ab');
  });

  it('аргументы: адрес, группы, Worker, пауза', () => {
    expect(parseArgs(['https://a.dev', '--group', 'deep, install', '--worker', 'https://w.dev', '--wait', '20']))
      .toEqual({ base: 'https://a.dev', groups: ['deep', 'install'], worker: 'https://w.dev', waitSeconds: 20 });
  });

  it('deploy.yml не держит проверок в YAML: шаги вызывают scripts/smoke.mjs по группам, curl к /api не осталось', () => {
    const wf = readFileSync('.github/workflows/deploy.yml', 'utf-8');
    for (const g of Object.keys(GROUPS)) expect(wf, g).toMatch(new RegExp(`node scripts/smoke\\.mjs [^\\n]*--group ${g}\\b`));
    expect(wf).not.toMatch(/curl[^\n]*\/api\//);
    expect(wf).toContain('--worker "${{ steps.digest.outputs.url }}"');
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.scripts.smoke).toBe('node scripts/smoke.mjs');
  });
});
