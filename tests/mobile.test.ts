import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCREEN_NAMES, SCREEN_PARAM, createScreenHistory, hrefFor, isNavState, parseScreen, type HistoryLike, type ScreenName } from '../src/nav';
import { createWakeLock, browserWakeLockEnv, type WakeLockSentinelLike } from '../src/wakeLock';
import { COARSE_POINTER_QUERY, STANDALONE_QUERY, autoFocusFields, isCoarsePointer, isStandalone } from '../src/mobile';
import { MANIFEST, SHORTCUTS } from '../src/manifest';
import { reminderScreen, reminderUrl, buildReminder } from '../functions/_lib/push';
import type { DigestData } from '../functions/_lib/digest';

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

// ---------- адрес экрана ----------

describe('экраны в адресе (?screen=)', () => {
  it('parseScreen — известные имена в любом регистре, неизвестные и пустые — null', () => {
    for (const s of SCREEN_NAMES) expect(parseScreen(`?${SCREEN_PARAM}=${s}`)).toBe(s);
    expect(parseScreen('?screen=Lesson&x=1')).toBe('lesson');
    expect(parseScreen('?screen=journal')).toBeNull();
    expect(parseScreen('?screen=')).toBeNull();
    expect(parseScreen('')).toBeNull();
    expect(parseScreen('?other=lesson')).toBeNull();
  });

  it('hrefFor — главный «/», экран «/?screen=имя»; разбирается обратно', () => {
    expect(hrefFor(null)).toBe('/');
    expect(hrefFor('lesson')).toBe('/?screen=lesson');
    for (const s of SCREEN_NAMES) expect(parseScreen(hrefFor(s).slice(1))).toBe(s);
  });

  it('isNavState — только объект с нашим полем и известным экраном', () => {
    expect(isNavState({ offerly: 'lesson' })).toBe(true);
    expect(isNavState({ offerly: 'lesson' }, 'lesson')).toBe(true);
    expect(isNavState({ offerly: 'lesson' }, 'settings')).toBe(false);
    expect(isNavState({ offerly: 'journal' })).toBe(false);
    expect(isNavState(null)).toBe(false);
    expect(isNavState('lesson')).toBe(false);
    expect(isNavState({ other: 1 })).toBe(false);
  });
});

// ---------- история браузера ----------

/** Подделка history: стек записей и popstate, который приложение получает после back(). */
function fakeHistory(initial: unknown = null) {
  const entries: { state: unknown; url: string }[] = [{ state: initial, url: '/' }];
  let index = 0;
  let onPop: ((state: unknown) => void) | null = null;
  const h: HistoryLike & { entries: typeof entries; index: () => number; url: () => string; listen: (fn: (s: unknown) => void) => void; forward: () => void } = {
    get state() { return entries[index].state; },
    pushState(state, _u, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index].url }); index = entries.length - 1; },
    replaceState(state, _u, url) { entries[index] = { state, url: url ?? entries[index].url }; },
    back() { if (index === 0) return; index--; queueMicrotask(() => onPop?.(entries[index].state)); },
    forward() { if (index >= entries.length - 1) return; index++; queueMicrotask(() => onPop?.(entries[index].state)); },
    entries, index: () => index, url: () => entries[index].url,
    listen(fn) { onPop = fn; },
  };
  return h;
}
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('история экранов: «назад» на телефоне закрывает экран, а не приложение', () => {
  function setup(initial: unknown = null) {
    const h = fakeHistory(initial);
    const onClose = vi.fn();
    const nav = createScreenHistory(h, onClose);
    let open: ScreenName | null = null;
    h.listen(state => { const next = nav.onPop(state, open); if (open && next !== open) open = null; });
    const openScreen = (s: ScreenName) => { nav.open(s); open = s; };
    return { h, nav, onClose, openScreen, current: () => open };
  }

  it('открытие экрана добавляет запись с адресом; повторное открытие того же экрана — нет', () => {
    const { h, openScreen } = setup();
    openScreen('lesson');
    expect(h.entries.length).toBe(2);
    expect(h.state).toEqual({ offerly: 'lesson' });
    expect(h.url()).toBe('/?screen=lesson');
    openScreen('lesson');
    expect(h.entries.length).toBe(2);
  });

  it('кнопка «назад» (popstate на главный) закрывает открытый экран один раз', async () => {
    const { h, onClose, openScreen } = setup();
    openScreen('rehearsal');
    h.back();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.index()).toBe(0);
    expect(h.url()).toBe('/');
  });

  it('закрытие кнопкой на экране снимает запись через history.back(); onClose приходит из popstate — ровно один раз', async () => {
    const { h, nav, onClose, openScreen } = setup();
    openScreen('settings');
    nav.close();
    expect(onClose).not.toHaveBeenCalled(); // ждём popstate
    nav.close(); // второй щелчок до popstate — не второй back()
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.index()).toBe(0);
  });

  it('закрытие, когда верхняя запись — не наша (экран открыт без истории): onClose сразу, история не трогается', () => {
    const h = fakeHistory();
    const onClose = vi.fn();
    const nav = createScreenHistory(h, onClose);
    nav.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.entries.length).toBe(1);
  });

  it('открытие по ссылке (fresh): верхняя запись становится главным, экран — поверх; «назад» ведёт на главный, а не прочь', async () => {
    const h = fakeHistory();
    h.entries[0] = { state: null, url: '/?screen=lesson' }; // приложение открыто ссылкой быстрого доступа
    const onClose = vi.fn();
    const nav = createScreenHistory(h, onClose);
    nav.open('lesson', { fresh: true });
    expect(h.entries.map(e => e.url)).toEqual(['/', '/?screen=lesson']);
    expect(h.state).toEqual({ offerly: 'lesson' });
    h.listen(s => nav.onPop(s, 'lesson'));
    h.back();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.url()).toBe('/');
  });

  it('«вперёд» после «назад» возвращает имя экрана, ничего не закрывая; чужая запись при закрытом экране — тоже без onClose', async () => {
    const { h, nav, onClose, openScreen, current } = setup();
    openScreen('lesson');
    h.back();
    await tick();
    expect(current()).toBeNull();
    let popped: ScreenName | null = null;
    h.listen(s => { popped = nav.onPop(s, null); });
    h.forward();
    await tick();
    expect(popped).toBe('lesson');
    expect(onClose).toHaveBeenCalledTimes(1);
    h.back();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('popstate на запись другого экрана закрывает открытый (устаревшая запись после «вперёд»)', () => {
    const h = fakeHistory({ offerly: 'lesson' });
    const onClose = vi.fn();
    const nav = createScreenHistory(h, onClose);
    expect(nav.onPop({ offerly: 'lesson' }, 'rehearsal')).toBe('lesson');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leave — выход из учётной записи заменяет запись экрана главным без popstate', () => {
    const h = fakeHistory();
    const nav = createScreenHistory(h, vi.fn());
    nav.open('settings');
    nav.leave();
    expect(h.entries.length).toBe(2);
    expect(h.state).toBeNull();
    expect(h.url()).toBe('/');
    nav.leave(); // без записи экрана — ничего
    expect(h.state).toBeNull();
  });

  it('history.back() бросил (встроенный просмотрщик без истории) — экран всё равно закрывается', () => {
    const h = fakeHistory();
    const onClose = vi.fn();
    const nav = createScreenHistory(h, onClose);
    nav.open('lesson');
    h.back = () => { throw new Error('no history'); };
    nav.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------- экран не гаснет ----------

function sentinelFactory() {
  const made: (WakeLockSentinelLike & { released: boolean })[] = [];
  const request = vi.fn(async (_t: 'screen') => {
    const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
    made.push(s);
    return s;
  });
  return { request, made };
}

describe('Screen Wake Lock: занятие, тест и репетиция держат экран', () => {
  it('acquire запрашивает блокировку, release снимает; повторный acquire при удержании — без нового запроса', async () => {
    const { request, made } = sentinelFactory();
    const lock = createWakeLock({ request, visible: () => true });
    expect(await lock.acquire()).toBe(true);
    expect(lock.held()).toBe(true);
    expect(await lock.acquire()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await lock.release();
    expect(made[0].released).toBe(true);
    expect(lock.held()).toBe(false);
  });

  it('без API, в фоне или при отказе браузера — false, без исключений', async () => {
    expect(await createWakeLock({ visible: () => true }).acquire()).toBe(false);
    const { request } = sentinelFactory();
    expect(await createWakeLock({ request, visible: () => false }).acquire()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    const refusing = vi.fn(async () => { throw new DOMException('low battery', 'NotAllowedError'); });
    const lock = createWakeLock({ request: refusing, visible: () => true });
    expect(await lock.acquire()).toBe(false);
    expect(lock.held()).toBe(false);
  });

  it('система сняла блокировку в фоне — при возвращении на экран запрашивается снова; после release — нет', async () => {
    const { request, made } = sentinelFactory();
    let visible = true;
    const lock = createWakeLock({ request, visible: () => visible });
    await lock.acquire();
    visible = false; made[0].released = true; // вкладка ушла в фон, браузер отпустил
    await lock.onVisibility();
    expect(request).toHaveBeenCalledTimes(1);
    visible = true;
    await lock.onVisibility();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held()).toBe(true);
    await lock.release();
    await lock.onVisibility();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held()).toBe(false);
  });

  it('release во время ожидания запроса — полученная блокировка сразу отпускается', async () => {
    let resolve!: (s: WakeLockSentinelLike) => void;
    const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
    const lock = createWakeLock({ request: () => new Promise(r => { resolve = r; }), visible: () => true });
    const p = lock.acquire();
    await lock.release();
    resolve(s);
    expect(await p).toBe(false);
    expect(s.released).toBe(true);
  });

  it('browserWakeLockEnv — запрос только при navigator.wakeLock, видимость по document', () => {
    expect(browserWakeLockEnv({}, { visibilityState: 'visible' }).request).toBeUndefined();
    const wl = { request: vi.fn(async () => ({ released: false, release: async () => {} })) };
    const env = browserWakeLockEnv({ wakeLock: wl } as any, { visibilityState: 'hidden' });
    expect(env.request).toBeTypeOf('function');
    expect(env.visible()).toBe(false);
    expect(browserWakeLockEnv({}, undefined).visible()).toBe(true);
  });
});

// ---------- признаки телефона ----------

describe('признаки телефона', () => {
  const win = (truthy: string[]) => ({ matchMedia: (q: string) => ({ matches: truthy.includes(q) }) });

  it('палец вместо мыши — по медиазапросу; без matchMedia или с исключением — false', () => {
    expect(isCoarsePointer(win([COARSE_POINTER_QUERY]))).toBe(true);
    expect(isCoarsePointer(win([]))).toBe(false);
    expect(isCoarsePointer({})).toBe(false);
    expect(isCoarsePointer(undefined)).toBe(false);
    expect(isCoarsePointer({ matchMedia: () => { throw new Error('x'); } })).toBe(false);
  });

  it('фокус в поле ответа — только с клавиатурой', () => {
    expect(autoFocusFields(win([]))).toBe(true);
    expect(autoFocusFields(win([COARSE_POINTER_QUERY]))).toBe(false);
    expect(autoFocusFields(undefined)).toBe(true);
  });

  it('установленное приложение — display-mode: standalone или navigator.standalone (Safari)', () => {
    expect(isStandalone(win([STANDALONE_QUERY]))).toBe(true);
    expect(isStandalone({ ...win([]), navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ ...win([]), navigator: { standalone: false } })).toBe(false);
    expect(isStandalone(win([]))).toBe(false);
  });

  it('поля ответа: на телефоне без автофокуса, исправления без автозамены (сравнение с эталоном строгое)', () => {
    for (const f of ['src/screens/Lesson.tsx', 'src/screens/Assessment.tsx', 'src/screens/Rehearsal.tsx']) {
      const src = read(f);
      expect(src, f).toContain('autoFocus={focusOnOpen}');
      expect(src, f).not.toMatch(/autoFocus(?![=F])/); // голый autoFocus не остался (autoFocusFields — импорт)
      expect(src, f).toContain('useWakeLock(');
    }
    const lesson = read('src/screens/Lesson.tsx');
    expect(lesson.match(/autoCorrect="off" autoCapitalize="off"/g)?.length).toBe(2); // исправление и карточка
    expect(lesson).toContain('autoCapitalize="sentences"'); // письмо
    expect(read('src/screens/Assessment.tsx')).toContain('autoCorrect="off" autoCapitalize="off"');
  });
});

// ---------- манифест и стили ----------

describe('манифест PWA и мобильные стили', () => {
  it('ссылки быстрого доступа ведут на известные экраны, со значком не меньше 96 px и короткими подписями', () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(2);
    for (const s of SHORTCUTS) {
      expect(parseScreen(s.url.slice(1))).toBe(s.screen);
      expect(s.url.startsWith(MANIFEST.scope)).toBe(true);
      expect(s.short_name.length).toBeLessThanOrEqual(12);
      expect(s.name).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      for (const i of s.icons) expect(Number(i.sizes.split('x')[0])).toBeGreaterThanOrEqual(96);
    }
    expect(MANIFEST.shortcuts.map(s => s.url)).toEqual(SHORTCUTS.map(s => s.url));
    expect(MANIFEST.shortcuts[0]).not.toHaveProperty('screen');
  });

  it('манифест: standalone с запасным minimal-ui, id и scope в корне, значки с maskable, цвета проекта', () => {
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.display_override[0]).toBe('standalone');
    expect(MANIFEST.id).toBe('/');
    expect(MANIFEST.start_url).toBe('/');
    expect(MANIFEST.theme_color).toBe('#141C2B');
    expect(MANIFEST.background_color).toBe('#F6F3EE');
    expect(MANIFEST.icons.some(i => (i as { purpose?: string }).purpose === 'maskable')).toBe(true);
    expect(MANIFEST.lang).toBe('ru');
    expect(read('vite.config.ts')).toContain('manifest: MANIFEST');
  });

  it('стили: safe-area со всех сторон, цели для пальца, без «потянуть, чтобы обновить» в установленном приложении', () => {
    const css = read('src/styles.css');
    for (const side of ['top', 'right', 'bottom', 'left']) expect(css).toContain(`env(safe-area-inset-${side})`);
    expect(css).toMatch(/\(hover: none\) and \(pointer: coarse\)[^}]*\{[^}]*\.btn[^}]*min-height: 44px/s);
    expect(css).toMatch(/@media \(display-mode: standalone\)[\s\S]*overscroll-behavior-y: contain/);
    expect(read('index.html')).toContain('viewport-fit=cover');
  });
});

// ---------- уведомление открывает экран дня ----------

describe('клик по уведомлению открывает экран дня', () => {
  const day = (format: string) => ({ format } as DigestData['day']);
  it('reminderScreen — занятие и смешанный день → lesson, репетиция, срез; без программы, без дня или пройденный день → главный', () => {
    expect(reminderScreen({ programExists: true, day: day('lesson'), todayDone: false })).toBe('lesson');
    expect(reminderScreen({ programExists: true, day: day('mixed'), todayDone: false })).toBe('lesson');
    expect(reminderScreen({ programExists: true, day: day('rehearsal'), todayDone: false })).toBe('rehearsal');
    expect(reminderScreen({ programExists: true, day: day('checkpoint'), todayDone: false })).toBe('checkpoint');
    expect(reminderScreen({ programExists: false, day: null, todayDone: false })).toBeNull();
    expect(reminderScreen({ programExists: true, day: null, todayDone: false })).toBeNull();
    expect(reminderScreen({ programExists: true, day: day('lesson'), todayDone: true })).toBeNull();
  });

  it('reminderUrl — адрес приложения без двойных «/», экран как в src/nav.ts', () => {
    expect(reminderUrl('https://offerly-c8b.pages.dev', null)).toBe('https://offerly-c8b.pages.dev/');
    expect(reminderUrl('https://offerly-c8b.pages.dev/', 'lesson')).toBe('https://offerly-c8b.pages.dev/?screen=lesson');
    const u = new URL(reminderUrl('https://example.test', 'rehearsal'));
    expect(parseScreen(u.search)).toBe('rehearsal');
  });

  it('buildReminder кладёт адрес экрана дня в полезную нагрузку', () => {
    const d = {
      programExists: true, todayDone: false, dueCards: 0, today: '2026-11-01',
      day: { format: 'rehearsal', formatLabel: 'репетиция интервью', topicLabel: '', writingLabel: null } as unknown as DigestData['day'],
      view: { streak: { current: 0 }, goal: { left: 10 }, countdown: { daysLeft: null } },
    } as unknown as DigestData;
    const r = buildReminder(d, { APP_NAME: 'Offerly', APP_URL: 'https://offerly-c8b.pages.dev' });
    expect(r.url).toBe('https://offerly-c8b.pages.dev/?screen=rehearsal');
    expect(r.title).toBe('Offerly: Репетиция интервью');
  });
});
