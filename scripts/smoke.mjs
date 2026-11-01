#!/usr/bin/env node
/**
 * Дымовые проверки живого адреса (из обзора 31.10.2026: раньше жили прямо в deploy.yml).
 *
 *   node scripts/smoke.mjs <адрес> [--group health,smoke,deep,install] [--worker <адрес Worker>] [--wait <сек>]
 *
 * Печатает аннотации GitHub Actions (`::notice` / `::warning` / `::error`) одной строкой — логи шагов из облачной
 * сессии не читаются, аннотации видны в `gh run view`. Код выхода 1, если хотя бы одна проверка группы упала.
 * Группы разнесены по шагам workflow: GitHub показывает не больше 10 аннотаций notice на шаг (тест это держит).
 * Локально: `npm run e2e:stand`, затем `npm run smoke -- http://localhost:4180 --group smoke,install`.
 */
import { pathToFileURL } from 'node:url';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Экранирование данных команды GitHub: `%`, перевод строки и возврат каретки. */
export function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function annotation(level, title, message) {
  return `::${level} title=${title}::${escapeData(message)}`;
}

/** Код ответа без тела; сетевой сбой — 0, чтобы проверка упала с понятной строкой, а не исключением. */
async function status(ctx, path, init = {}) {
  try { const r = await ctx.fetch(ctx.base + path, init); await r.arrayBuffer().catch(() => null); return r.status; } catch { return 0; }
}
async function text(ctx, path) {
  try { const r = await ctx.fetch(ctx.base + path); return { status: r.status, body: await r.text(), headers: r.headers }; }
  catch (e) { return { status: 0, body: String(e?.message ?? e), headers: new Headers() }; }
}
const post = (body) => ({ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const put = (body) => ({ method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (body) => ({ method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * Проверка «без cookie → ждём код»: одна аннотация на область, все маршруты области в одной строке.
 * routes: [описание, путь, init?, ждём = 401]
 */
function closed(title, routes, note = '') {
  return async (ctx) => {
    const got = await Promise.all(routes.map(([, path, init, want = 401]) => status(ctx, path, init).then(code => ({ code, want }))));
    const parts = routes.map(([label], i) => `${label} → ${got[i].code}${got[i].want !== 401 ? ` (ждём ${got[i].want})` : ''}`);
    const ok = got.every(g => g.code === g.want);
    const all401 = routes.every(([, , , want = 401]) => want === 401);
    return [{
      level: 'notice', title,
      message: `${parts.join('; ')}${all401 ? ' (без cookie, ждём 401 везде)' : ''}${note ? `; ${note}` : ''}`,
    }, ...(ok ? [] : [{ level: 'error', title, message: 'неожиданные коды ответа' }])];
  };
}

async function healthCheck(ctx) {
  // после деплоя адрес отвечает не сразу: несколько попыток с паузой
  let last = { status: 0, body: '' };
  for (let i = 0; i <= ctx.retries; i++) {
    if (i > 0) await ctx.sleep(ctx.retryDelayMs);
    last = await text(ctx, '/api/health');
    try { const h = JSON.parse(last.body); if (last.status === 200 && h.ok && h.db === 'ok' && h.ai === 'ok') return [{ level: 'notice', title: 'health', message: last.body.trim() }]; } catch { /* повторить */ }
  }
  return [
    { level: 'notice', title: 'health', message: `${last.status}: ${last.body.trim().slice(0, 500)}` },
    { level: 'error', title: 'health', message: 'health не ok: ждём ok:true, db:ok, ai:ok' },
  ];
}

async function deepCheck(ctx) {
  const r = await text(ctx, '/api/health?deep=2');
  let h = {};
  try { h = JSON.parse(r.body); } catch { /* ниже — ошибка */ }
  ctx.deep = h;
  const out = [{ level: 'notice', title: 'extract', message: r.body.trim().slice(0, 900) }];
  if (h.extract !== 'ok') out.push({ level: 'error', title: 'extract', message: `самопроверка извлечения не прошла (код ${r.status})` });
  if (h.ai_chat !== 'ok') out.push({ level: 'warning', title: 'ai_chat', message: String(h.ai_chat) });
  if (!String(h.analysis).startsWith('ok')) out.push({ level: 'warning', title: 'analysis', message: String(h.analysis) });
  return out;
}

async function pwaCheck(ctx) {
  const [sw, mf, root] = await Promise.all([status(ctx, '/sw.js'), status(ctx, '/manifest.webmanifest'), text(ctx, '/')]);
  const theme = (root.body.match(/data-theme/g) ?? []).length;
  const out = [{ level: 'notice', title: 'pwa', message: `GET /sw.js → ${sw}; GET /manifest.webmanifest → ${mf} (ждём 200); скрипт темы в index.html: ${theme}` }];
  if (sw !== 200 || mf !== 200) out.push({ level: 'error', title: 'pwa', message: 'service worker или манифест не отдаются' });
  return out;
}

async function voiceCheck(ctx) {
  const contour = String(ctx.deep?.voice);
  const form = new FormData();
  form.append('audio', new Blob(['{}'], { type: 'audio/wav' }), 'a.wav');
  const out = await closed('voice', [
    ['POST /api/voice/transcribe', '/api/voice/transcribe', { method: 'POST', body: form }],
    ['POST /api/voice/speak', '/api/voice/speak', post({ text: 'hello' })],
    ['GET /api/voice/meta', '/api/voice/meta'],
  ], `контур: ${contour}`)(ctx);
  if (!contour.startsWith('ok:')) out.push({ level: 'warning', title: 'voice', message: `голосовой контур не подтверждён: ${contour}` });
  return out;
}

async function digestCheck(ctx) {
  let worker = 'worker без адреса workers.dev или не задеплоен — см. digest deploy';
  if (ctx.worker) {
    try { const r = await ctx.fetch(ctx.worker.replace(/\/$/, '') + '/', { signal: AbortSignal.timeout(20_000) }); worker = (await r.text()).replace(/\n/g, '').slice(0, 600); }
    catch (e) { worker = `нет ответа: ${String(e?.message ?? e).slice(0, 200)}`; }
  }
  const out = await closed('digest', [
    ['GET /api/digest', '/api/digest'],
    ['PUT /api/digest', '/api/digest', put({ notifyAt: '07:00' })],
    ['POST /api/digest/send', '/api/digest/send', { method: 'POST' }],
  ], `worker: ${worker}`)(ctx);
  if (!worker.includes('"ok":true')) out.push({ level: 'warning', title: 'digest', message: `состояние Worker не подтверждено: ${worker}` });
  return out;
}

async function pushCheck(ctx) {
  const [psw, sw] = await Promise.all([status(ctx, '/push-sw.js'), text(ctx, '/sw.js')]);
  const linked = (sw.body.match(/push-sw\.js/g) ?? []).length;
  const out = await closed('push', [
    ['GET /api/push', '/api/push'],
    ['PUT /api/push', '/api/push', put({ pushAt: '07:00' })],
    ['POST /api/push/subscribe', '/api/push/subscribe', post({ endpoint: 'https://x', keys: {} })],
    ['DELETE /api/push/subscribe', '/api/push/subscribe', del({ endpoint: 'https://x' })],
    ['POST /api/push/send', '/api/push/send', { method: 'POST' }],
  ], `GET /push-sw.js → ${psw}, подключён в sw.js: ${linked}; ключи VAPID: ${String(ctx.deep?.push)}`)(ctx);
  if (psw !== 200 || linked === 0) out.push({ level: 'error', title: 'push', message: 'скрипт push не отдаётся или не подключён в sw.js' });
  return out;
}

async function itemsCheck(ctx) {
  const t = await text(ctx, '/api/items/topics');
  let summary = 'ответ не JSON';
  try { const j = JSON.parse(t.body); summary = `${(j.topics ?? []).length} тем, ${(j.kinds ?? []).length} вида, уровни ${(j.levels ?? []).join('/')}`; } catch { /* оставить */ }
  const rest = await closed('items', [
    ['GET /api/items/stats', '/api/items/stats'],
    ['POST /api/items/generate', '/api/items/generate', post({ kind: 'mcq', level: 'B1', topic: 'articles' })],
  ])(ctx);
  rest[0].message = `GET /api/items/topics → ${t.status} (${summary}); ${rest[0].message}`;
  if (t.status !== 200 && rest.length === 1) rest.push({ level: 'error', title: 'items', message: 'неожиданные коды ответа' });
  return rest;
}

async function installCheck(ctx) {
  const [page, rel] = await Promise.all([text(ctx, '/install'), text(ctx, '/api/release')]);
  const root = (page.body.match(/id="root"/g) ?? []).length;
  let relInfo = 'ответ не JSON';
  try { const r = JSON.parse(rel.body); relInfo = r.available ? `установщик ${r.version} → ${r.windows?.name}` : `без установщика: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`; } catch { /* оставить */ }
  const cc = rel.headers.get('cache-control');
  const out = [{ level: 'notice', title: 'install', message: `GET /install → ${page.status} (оболочка SPA: ${root}); GET /api/release → ${rel.status}, ${relInfo}; cache-control: ${cc ?? 'нет'}` }];
  if (page.status !== 200 || root === 0 || rel.status !== 200) out.push({ level: 'error', title: 'install', message: 'страница установки или /api/release не отвечают' });
  return out;
}

function resumeForm() {
  const form = new FormData();
  form.append('file', new Blob(['{}'], { type: 'text/plain' }), 'cv.txt');
  return form;
}

/** Группы проверок = шаги workflow. Порядок внутри группы — порядок аннотаций. */
export const GROUPS = {
  health: [healthCheck],
  smoke: [
    closed('auth', [
      ['GET /api/me', '/api/me'],
      ['POST /api/auth/request с плохим адресом', '/api/auth/request', post({ email: 'bad' }), 400],
    ]),
    async (ctx) => closed('resume', [
      ['GET /api/profile', '/api/profile'],
      ['POST /api/resume', '/api/resume', { method: 'POST', body: resumeForm() }],
    ])(ctx),
    closed('onboarding', [['PUT /api/onboarding', '/api/onboarding', put({ targetRole: 'x' })]]),
    itemsCheck,
    closed('assessment', [
      ['GET /api/assessment', '/api/assessment'],
      ['POST /api/assessment/start', '/api/assessment/start', { method: 'POST' }],
      ['POST /api/assessment/answer', '/api/assessment/answer', post({ attemptId: 'x', answer: 'A' })],
      ['POST /api/assessment/score', '/api/assessment/score', { method: 'POST' }],
    ]),
    closed('cards', [['GET /api/cards', '/api/cards']]),
    closed('program', [
      ['GET /api/program', '/api/program'],
      ['POST /api/program/generate', '/api/program/generate', { method: 'POST' }],
      ['POST /api/program/swap', '/api/program/swap', post({ a: 'x', b: 'y' })],
    ]),
    closed('lesson', [
      ['GET /api/lesson', '/api/lesson'],
      ['POST /api/lesson/start', '/api/lesson/start', { method: 'POST' }],
      ['POST /api/lesson/answer', '/api/lesson/answer', post({ stepId: 'x', answer: 'A' })],
    ]),
    closed('achievements', [
      ['POST /api/lesson/bonus', '/api/lesson/bonus', post({ accept: true })],
      ['GET /api/achievements', '/api/achievements'],
      ['POST /api/achievements/seen', '/api/achievements/seen', { method: 'POST' }],
    ]),
    closed('dashboard', [
      ['GET /api/dashboard', '/api/dashboard'],
      ['PUT /api/dashboard/goal', '/api/dashboard/goal', put({ minutes: 100 })],
    ]),
  ],
  deep: [
    deepCheck,
    pwaCheck,
    closed('rehearsal', [
      ['GET /api/rehearsal', '/api/rehearsal'],
      ['POST /api/rehearsal/start', '/api/rehearsal/start', { method: 'POST' }],
      ['POST /api/rehearsal/answer', '/api/rehearsal/answer', post({ turnId: 'x', answer: 'A' })],
      ['POST /api/rehearsal/review', '/api/rehearsal/review', { method: 'POST' }],
      ['POST /api/rehearsal/abandon', '/api/rehearsal/abandon', { method: 'POST' }],
    ]),
    voiceCheck,
    closed('checkpoint', [
      ['GET /api/checkpoint', '/api/checkpoint'],
      ['POST /api/checkpoint/start', '/api/checkpoint/start', { method: 'POST' }],
      ['POST /api/checkpoint/answer', '/api/checkpoint/answer', post({ attemptId: 'x', answer: 'A' })],
      ['POST /api/checkpoint/score', '/api/checkpoint/score', { method: 'POST' }],
      ['POST /api/checkpoint/abandon', '/api/checkpoint/abandon', { method: 'POST' }],
    ]),
    digestCheck,
    pushCheck,
    closed('settings', [
      ['GET /api/settings', '/api/settings'],
      ['PUT /api/settings/key', '/api/settings/key', put({ provider: 'groq', apiKey: 'gsk_0123456789' })],
      ['POST /api/settings/key/check', '/api/settings/key/check', { method: 'POST' }],
      ['DELETE /api/settings/key', '/api/settings/key', { method: 'DELETE' }],
      ['PUT /api/settings/notifications', '/api/settings/notifications', put({ at: '07:00', mail: true })],
      ['GET /api/export', '/api/export'],
    ]),
  ],
  install: [installCheck],
};

/**
 * Прогнать группы против адреса. Возвращает аннотации и итог; печать — через log.
 * Проверки группы идут по порядку (deep кладёт ответ /api/health?deep=2 в ctx для voice и push).
 */
export async function runSmoke(base, opts = {}) {
  const groups = opts.groups ?? Object.keys(GROUPS);
  const ctx = {
    base: String(base).replace(/\/$/, ''),
    fetch: opts.fetch ?? globalThis.fetch,
    worker: opts.worker || '',
    retries: opts.retries ?? 5,
    retryDelayMs: opts.retryDelayMs ?? 10_000,
    sleep: opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    deep: null,
  };
  const log = opts.log ?? (line => console.log(line));
  const results = [];
  for (const g of groups) {
    const checks = GROUPS[g];
    if (!checks) { const a = { group: g, level: 'error', title: 'smoke', message: `нет группы ${g}; есть: ${Object.keys(GROUPS).join(', ')}` }; results.push(a); log(annotation(a.level, a.title, a.message)); continue; }
    for (const check of checks) {
      let out;
      try { out = await check(ctx); } catch (e) { out = [{ level: 'error', title: g, message: `проверка упала: ${String(e?.message ?? e).slice(0, 300)}` }]; }
      for (const a of out) { results.push({ group: g, ...a }); log(annotation(a.level, a.title, a.message)); }
    }
  }
  return { ok: !results.some(a => a.level === 'error'), annotations: results };
}

export function parseArgs(argv) {
  const opts = { base: process.env.SMOKE_URL ?? '', groups: undefined, worker: '', waitSeconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group' || a === '--groups') opts.groups = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--worker') opts.worker = argv[++i] ?? '';
    else if (a === '--wait') opts.waitSeconds = Number(argv[++i] ?? 0);
    else if (!a.startsWith('--')) opts.base = a;
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.base) { console.log(annotation('error', 'smoke', 'не задан адрес: node scripts/smoke.mjs <адрес> [--group …]')); process.exit(1); }
  if (opts.waitSeconds > 0) await new Promise(r => setTimeout(r, opts.waitSeconds * 1000));
  const { ok } = await runSmoke(opts.base, { groups: opts.groups, worker: opts.worker });
  process.exit(ok ? 0 : 1);
}
