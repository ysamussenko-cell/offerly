import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isDesktop, clockIn, reminderState, applyReminder, makeTicker, desktopNotify, minutesOf, CONFIG_TTL_MS, DESKTOP_REMINDED_KEY, DESKTOP_PUSH_TEXT, type ReminderInfo } from '../src/desktop';
import { pushSupport, SUPPORT_TEXT, type SupportEnv } from '../src/push';
import { parseLatest, LATEST_URL } from '../functions/_lib/release';
import { createApp, type Env } from '../functions/_lib/app';
import { sqlStore } from './helpers/sqliteD1';
// @ts-expect-error — модуль .mjs без типов: чистые функции сборки latest.json
import { buildLatest, changelogNotes, pickSetup, SETUP_RE, describe as describeLatest } from '../desktop/scripts/latest.mjs';

const TZ = 'Asia/Almaty'; // UTC+5
const utc = (iso: string) => new Date(iso);

const info = (over: Partial<ReminderInfo> = {}): ReminderInfo => ({
  at: '07:41', tz: TZ, localTime: '07:45', today: '2026-11-12', windowMinutes: 180, todayDone: false,
  reminder: { title: 'Offerly: Занятие · Артикли', body: 'Письмо — разбор ошибки · к повтору 14 карточек · серия 1 день' }, ...over,
});

function deps(over: Partial<ReminderInfo> = {}, remembered: string | null = null) {
  let stored = remembered;
  const fetchInfo = vi.fn(async () => info(over));
  const notify = vi.fn(async () => {});
  return { fetchInfo, notify, storage: { get: () => stored, set: (d: string) => { stored = d; } }, stored: () => stored };
}

describe('приложение для Windows: признак и часы', () => {
  it('isDesktop — по глобальным объектам Tauri; обычный браузер и отсутствие window — false', () => {
    expect(isDesktop({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isDesktop({ __TAURI__: { core: {} } })).toBe(true);
    expect(isDesktop({})).toBe(false);
    expect(isDesktop(undefined)).toBe(false);
    expect(isDesktop(null)).toBe(false);
  });

  it('clockIn — дата и минуты в поясе пользователя, полночь как 0, неизвестный пояс → UTC', () => {
    expect(clockIn(TZ, utc('2026-11-12T02:41:00Z'))).toEqual({ date: '2026-11-12', minutes: 7 * 60 + 41 });
    expect(clockIn(TZ, utc('2026-11-11T19:00:00Z'))).toEqual({ date: '2026-11-12', minutes: 0 });
    expect(clockIn('UTC', utc('2026-11-12T23:59:00Z'))).toEqual({ date: '2026-11-12', minutes: 23 * 60 + 59 });
    expect(clockIn('Nowhere/Nope', utc('2026-11-12T10:00:00Z'))).toEqual({ date: '2026-11-12', minutes: 600 });
    expect(minutesOf('07:41')).toBe(461);
  });

  it('reminderState — рано, пора (в окне 3 часа), поздно, уже показано сегодня', () => {
    const win = 180;
    expect(reminderState({ date: '2026-11-12', minutes: 460 }, '07:41', null, win)).toBe('early');
    expect(reminderState({ date: '2026-11-12', minutes: 461 }, '07:41', null, win)).toBe('due');
    expect(reminderState({ date: '2026-11-12', minutes: 461 + 179 }, '07:41', null, win)).toBe('due');
    expect(reminderState({ date: '2026-11-12', minutes: 461 + 180 }, '07:41', null, win)).toBe('late');
    expect(reminderState({ date: '2026-11-12', minutes: 500 }, '07:41', '2026-11-12', win)).toBe('shown');
    expect(reminderState({ date: '2026-11-13', minutes: 500 }, '07:41', '2026-11-12', win)).toBe('due');
  });
});

describe('приложение для Windows: напоминание дня', () => {
  it('applyReminder: пора и занятие не пройдено — уведомление и отметка дня; пройдено — только отметка; рано/поздно — ничего', async () => {
    const d = deps();
    expect(await applyReminder(info(), d)).toBe('notified');
    expect(d.notify).toHaveBeenCalledWith('Offerly: Занятие · Артикли', 'Письмо — разбор ошибки · к повтору 14 карточек · серия 1 день');
    expect(d.stored()).toBe('2026-11-12');
    expect(await applyReminder(info(), d)).toBe('shown');
    expect(d.notify).toHaveBeenCalledTimes(1);

    const done = deps();
    expect(await applyReminder(info({ todayDone: true }), done)).toBe('done');
    expect(done.notify).not.toHaveBeenCalled();
    expect(done.stored()).toBe('2026-11-12');

    const early = deps();
    expect(await applyReminder(info({ localTime: '07:00' }), early)).toBe('early');
    expect(await applyReminder(info({ localTime: '11:00' }), early)).toBe('late');
    expect(early.notify).not.toHaveBeenCalled();
    expect(early.stored()).toBeNull();
  });

  it('планировщик: первый шаг читает сервер, дальше решает по местным часам и ходит на сервер только когда пора; конфигурация перечитывается раз в час', async () => {
    let now = utc('2026-11-12T01:00:00Z'); // 06:00 Алматы
    const d = deps();
    const tick = makeTicker({ ...d, now: () => now });
    d.fetchInfo.mockResolvedValueOnce(info({ localTime: '06:00' }));
    expect(await tick()).toBe('early');
    expect(d.fetchInfo).toHaveBeenCalledTimes(1);
    now = utc('2026-11-12T01:30:00Z');
    expect(await tick()).toBe('early');
    expect(d.fetchInfo).toHaveBeenCalledTimes(1); // по часам, без сервера
    now = utc('2026-11-12T02:41:00Z'); // 07:41 — пора: свежий ответ сервера и уведомление
    d.fetchInfo.mockResolvedValueOnce(info({ localTime: '07:41' }));
    expect(await tick()).toBe('notified');
    expect(d.fetchInfo).toHaveBeenCalledTimes(2);
    expect(d.notify).toHaveBeenCalledTimes(1);
    now = utc('2026-11-12T02:42:00Z');
    expect(await tick()).toBe('skip'); // уже показано — на сервер не ходим
    expect(d.fetchInfo).toHaveBeenCalledTimes(2);
    now = utc(new Date(utc('2026-11-12T02:41:00Z').getTime() + CONFIG_TTL_MS + 4 * 60_000).toISOString());
    expect(await tick()).toBe('shown'); // прошёл час с последнего чтения конфигурации — перечитана, день уже показан
    expect(d.fetchInfo).toHaveBeenCalledTimes(3);
  });

  it('планировщик: сбой сервера или уведомления — error, без отметки дня; следующий шаг пробует снова', async () => {
    let now = utc('2026-11-12T02:50:00Z');
    const d = deps();
    d.fetchInfo.mockRejectedValueOnce(new Error('сеть'));
    const tick = makeTicker({ ...d, now: () => now });
    expect(await tick()).toBe('error');
    expect(d.stored()).toBeNull();
    d.notify.mockRejectedValueOnce(new Error('нет IPC'));
    expect(await tick()).toBe('error');
    expect(d.stored()).toBeNull();
    now = utc('2026-11-12T02:51:00Z');
    expect(await tick()).toBe('notified');
    expect(d.stored()).toBe('2026-11-12');
  });

  it('desktopNotify зовёт plugin:notification через IPC; без Tauri — ошибка', async () => {
    const invoke = vi.fn(async () => undefined);
    await desktopNotify('Заголовок', 'Текст', { __TAURI__: { core: { invoke } } });
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Заголовок', body: 'Текст' } });
    await expect(desktopNotify('a', 'b', {})).rejects.toThrow(/только в приложении/);
    expect(DESKTOP_REMINDED_KEY).toBe('offerly_desktop_reminded_on');
  });

  it('карточка «Напоминание» в приложении: pushSupport → desktop с текстом про само приложение', () => {
    const env = (over: Partial<SupportEnv> = {}): SupportEnv => ({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130.0', secure: true, serviceWorker: true, pushManager: false, notification: false, standalone: false, ...over });
    expect(pushSupport(env({ desktop: true }))).toBe('desktop');
    expect(pushSupport(env({ desktop: false }))).toBe('no_push');
    expect(SUPPORT_TEXT.desktop).toBe(DESKTOP_PUSH_TEXT);
    expect(DESKTOP_PUSH_TEXT).toMatch(/трее/);
  });
});

describe('GET /api/push/reminder', () => {
  const appEnv = { DB: null, AI: { run: async () => ({ response: '{}' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1', APP_URL: 'https://offerly-c8b.pages.dev' } as unknown as Env;
  async function login(app: ReturnType<typeof createApp>) {
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, appEnv);
    const r1 = await call('/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com' }) });
    const { code } = await r1.json() as any;
    const r2 = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'y@example.com', code }) });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    return { call, cookie };
  }

  it('без сессии — 401; с сессией — время (напоминание → письмо → по умолчанию), пояс, часы, окно и текст без отправки', async () => {
    const mem = sqlStore();
    const app = createApp('test', () => mem.store);
    expect((await app.request('https://offerly.test/api/push/reminder', {}, appEnv)).status).toBe(401);
    const { call, cookie } = await login(app);
    const r = await call('/push/reminder', { headers: { cookie } });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j).toMatchObject({ ok: true, at: '07:30', windowMinutes: 180, todayDone: false });
    expect(j.tz).toBeTypeOf('string');
    expect(j.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(j.localTime).toMatch(/^\d{2}:\d{2}$/);
    expect(j.reminder.title).toMatch(/^Offerly: /);
    expect(j.reminder.body).toMatch(/карточ/);
    expect(mem.rows('SELECT id FROM push_subscriptions')).toHaveLength(0);

    await call('/digest', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ notifyAt: '07:41' }) });
    expect(((await (await call('/push/reminder', { headers: { cookie } })).json()) as any).at).toBe('07:41');
    await call('/push', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pushAt: '08:15' }) });
    expect(((await (await call('/push/reminder', { headers: { cookie } })).json()) as any).at).toBe('08:15');
  });
});

describe('релиз для Windows: версии и latest.json', () => {
  const root = new URL('..', import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

  it('версия одна везде: package.json, API и Worker (читают package.json), tauri.conf.json, Cargo.toml', () => {
    const pkg = JSON.parse(read('package.json')).version;
    expect(read('functions/api/[[route]].ts')).toContain(`import { VERSION } from '../_lib/version'`);
    expect(read('workers/digest/index.ts')).toContain(`import { VERSION } from '../../functions/_lib/version'`);
    expect(JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version).toBe(pkg);
    expect(read('desktop/src-tauri/Cargo.toml')).toMatch(new RegExp(`^version = "${pkg.replace(/\./g, '\\.')}"$`, 'm'));
  });

  it('tauri.conf.json: окно на живой адрес, автообновление по latest.json релиза с открытым ключом, установщик NSIS с .sig; capability — IPC для живого адреса', () => {
    const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'));
    expect(conf.productName).toBe('Offerly');
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', url: 'https://offerly-c8b.pages.dev/' });
    expect(conf.app.withGlobalTauri).toBe(true);
    expect(conf.plugins.updater.endpoints).toEqual([LATEST_URL]);
    expect(conf.plugins.updater.pubkey.length).toBeGreaterThan(80);
    expect(conf.bundle.targets).toEqual(['nsis']);
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    const cap = JSON.parse(read('desktop/src-tauri/capabilities/default.json'));
    expect(cap.remote.urls).toEqual(['https://offerly-c8b.pages.dev/*']);
    expect(cap.permissions).toContain('notification:default');
    const unsigned = JSON.parse(read('desktop/src-tauri/tauri.unsigned.conf.json'));
    expect(unsigned.bundle.createUpdaterArtifacts).toBe(false);
  });

  it('latest.mjs: раздел CHANGELOG, выбор установщика и подписи, сам latest.json читается страницей установки', () => {
    const md = '# Изменения\n\n## 0.23.0 — 2026-11-01\n- Первое `приложение` для Windows.\n- Трей.\n\n## 0.22.0 — 2026-10-31\n- Страница установки.\n';
    expect(changelogNotes(md, '0.23.0')).toBe('Первое приложение для Windows.\nТрей.');
    expect(changelogNotes(md, '0.22.0')).toBe('Страница установки.');
    expect(changelogNotes(md, '0.21.0')).toBeNull();
    expect(changelogNotes(`## 1.0.0\n- ${'x'.repeat(3000)}`, '1.0.0')!.length).toBeLessThanOrEqual(2000);

    expect(SETUP_RE.test('Offerly_0.23.0_x64-setup.exe')).toBe(true);
    expect(pickSetup(['Offerly_0.23.0_x64-setup.exe', 'Offerly_0.23.0_x64-setup.exe.sig', 'Offerly_0.23.0_x64-setup.nsis.zip'])).toEqual({ name: 'Offerly_0.23.0_x64-setup.exe', version: '0.23.0', sigName: 'Offerly_0.23.0_x64-setup.exe.sig' });
    expect(pickSetup(['Offerly_0.23.0_x64-setup.exe'])).toMatchObject({ sigName: null });
    expect(pickSetup(['Offerly_0.23.0_x64_en-US.msi'])).toBeNull();

    const latest = buildLatest({ version: '0.23.0', notes: 'Трей.', pubDate: '2026-11-01T10:00:00Z', setupName: 'Offerly_0.23.0_x64-setup.exe', signature: 'c2ln' });
    expect(latest).toEqual({
      version: '0.23.0', notes: 'Трей.', pub_date: '2026-11-01T10:00:00Z',
      platforms: { 'windows-x86_64': { signature: 'c2ln', url: 'https://github.com/ysamussenko-cell/offerly/releases/download/v0.23.0/Offerly_0.23.0_x64-setup.exe' } },
    });
    const parsed = parseLatest(latest)!;
    expect(parsed.windows).toEqual({ url: latest.platforms['windows-x86_64'].url, name: 'Offerly_0.23.0_x64-setup.exe', signed: true });
    expect(parseLatest(buildLatest({ version: '0.23.0', notes: null, pubDate: '2026-11-01T10:00:00Z', setupName: 'Offerly_0.23.0_x64-setup.exe', signature: '' }))!.windows!.signed).toBe(false);
    expect(describeLatest(latest)).toMatch(/подписан/);
    expect(() => buildLatest({ version: '0.23.0', notes: null, pubDate: 'x', setupName: 'Offerly_0.22.0_x64-setup.exe', signature: '' })).toThrow(/не равна/);
    expect(() => buildLatest({ version: '0.23.0', notes: null, pubDate: 'x', setupName: 'setup.exe', signature: '' })).toThrow(/шаблону/);
  });
});
