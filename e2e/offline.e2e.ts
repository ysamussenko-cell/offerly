/** Офлайн и тема в настоящем Chromium. Без сети: плашка, оболочка из кэша service worker при перезагрузке, вошедшему
 *  ученику не показывается форма входа, ответ не теряется и уходит после возврата сети.
 *  Тема: три режима, выбор переживает перезагрузку, вечер и система в «Авто», скрипт в index.html до загрузки приложения. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BrowserContextOptions } from 'playwright';
import { openWorld, closeWorld, login, seed, heading, card, inPage, shot, DESKTOP, type World } from './helpers';

// Тексты и цвета — как договор экрана; модули src/ здесь не подключаются: в tsconfig стенда нет DOM-типов.
const OFFLINE_NOTICE = 'Нет сети. Экраны открываются из кэша, но ответы и проверка не отправятся — подключитесь и повторите.';
const SESSION_UNREACHABLE = 'Нет связи с сервером, поэтому вход не проверить. Занятия и ответы хранятся на сервере — подключитесь, и экран откроется сам.';
const ANSWER_OFFLINE = 'Нет сети. Ответ не отправлен — текст остаётся на экране, подключитесь и отправьте снова.';
const THEME_COLORS = { light: '#141C2B', dark: '#0F1520' };

let w: World;
beforeAll(async () => { w = await openWorld(); });
afterAll(async () => { await closeWorld(w); });

const banner = () => w.page.locator('p.offline');
const homeHeading = () => heading(w.page, 'Готовность к собеседованию');
const answer = () => w.page.getByRole('button', { name: 'Ответить', exact: true });
const answersStored = (): number => w.stand.rows<{ n: number }>('SELECT COUNT(*) AS n FROM lesson_steps WHERE answered_at IS NOT NULL')[0].n;

describe('без сети', () => {
  it('service worker держит оболочку; плашка появляется и исчезает вместе с сетью, экран остаётся', async () => {
    await login(w.page, w.stand.url);
    await seed(w.stand);
    await w.page.reload();
    await homeHeading().waitFor();
    await w.page.waitForFunction('navigator.serviceWorker.controller !== null');
    expect(await banner().count()).toBe(0);

    await w.ctx.setOffline(true);
    await banner().waitFor();
    expect((await banner().textContent())?.trim()).toBe(OFFLINE_NOTICE);
    expect(await homeHeading().isVisible()).toBe(true);
    await shot(w.page, 'offline-home');

    await w.ctx.setOffline(false);
    await banner().waitFor({ state: 'detached' });
  });

  it('перезагрузка без сети: оболочка из кэша, вместо формы входа — «Нет связи»; сеть вернулась — главный без перезагрузки', async () => {
    await w.ctx.setOffline(true);
    await w.page.reload();
    await heading(w.page, 'Нет связи').waitFor();
    await w.page.getByText(SESSION_UNREACHABLE).waitFor();
    await banner().waitFor();
    expect(await w.page.getByLabel('Почта').count()).toBe(0);
    await shot(w.page, 'offline-reload');

    // кнопка без сети снова приводит к тому же экрану, а не к форме входа
    await w.page.getByRole('button', { name: 'Проверить снова' }).click();
    await heading(w.page, 'Нет связи').waitFor();
    expect(await w.page.getByLabel('Почта').count()).toBe(0);

    await w.ctx.setOffline(false);
    await homeHeading().waitFor();
    expect(await banner().count()).toBe(0);
    expect(await w.page.locator('.who').textContent()).toContain('e2e@offerly.test');
  });

  it('страница установки открывается без сети', async () => {
    await w.ctx.setOffline(true);
    await w.page.goto(w.stand.url + '/install');
    await heading(w.page, 'Установить Offerly').waitFor();
    await w.ctx.setOffline(false);
    await w.page.goto(w.stand.url + '/');
    await homeHeading().waitFor();
  });

  it('ответ в занятии без сети не отправлен и не потерян: текст на экране, после возврата сети уходит', async () => {
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Начать занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
    // варианты отвечаем верно, пока не встретится шаг с исправлением — на нём и пропадает сеть
    for (let n = 0; n < 5 && !(await w.page.locator('textarea').count()); n++) {
      const choices = w.page.locator('.choices button');
      await choices.first().waitFor();
      await choices.nth(2).click();
      await answer().click();
      await w.page.locator('.review.ok').waitFor();
      await w.page.getByRole('button', { name: 'Дальше' }).click();
      await w.page.locator('.choices button, textarea').first().waitFor();
    }
    const box = w.page.locator('textarea');
    const typed = (await box.inputValue()).replace(' have been ', ' has been ');
    await box.fill(typed);
    const stored = answersStored();

    await w.ctx.setOffline(true);
    await banner().waitFor();
    await answer().click();
    await w.page.getByText(ANSWER_OFFLINE).waitFor();
    expect(await box.inputValue()).toBe(typed);
    expect(answersStored()).toBe(stored);
    await shot(w.page, 'offline-answer');

    await w.ctx.setOffline(false);
    await banner().waitFor({ state: 'detached' });
    await answer().click();
    await w.page.locator('.review.ok').waitFor();
    expect(await w.page.getByText(ANSWER_OFFLINE).count()).toBe(0);
    expect(answersStored()).toBe(stored + 1);
  });
});

describe('тема', () => {
  const ALMATY = '+05:00';
  const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00${ALMATY}`);
  const BG = { light: 'rgb(246, 243, 238)' };

  /** Отдельный контекст без service worker: свои системная тема и часы. */
  async function themed(options: BrowserContextOptions, time: Date) {
    const ctx = await w.browser.newContext({ viewport: DESKTOP, locale: 'ru-RU', timezoneId: 'Asia/Almaty', serviceWorkers: 'block', ...options });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    await page.clock.install({ time });
    return { ctx, page };
  }
  const attr = (page: World['page']) => inPage<string>(page, "document.documentElement.getAttribute('data-theme')");
  const meta = (page: World['page']) => inPage<string>(page, `document.querySelector('meta[name="theme-color"]').content`);
  const bg = (page: World['page']) => inPage<string>(page, 'getComputedStyle(document.body).backgroundColor');
  const mode = (page: World['page'], name: string) => page.getByRole('group', { name: 'Тема оформления' }).getByRole('button', { name, exact: true });

  it('днём «Авто» светлая на бумаге; выбор «Тёмная» переживает перезагрузку, возврат к «Авто» снимает его', async () => {
    const { ctx, page } = await themed({ colorScheme: 'light' }, at('10:00'));
    await page.goto(w.stand.url + '/');
    await mode(page, 'Авто').waitFor();
    expect(await attr(page)).toBe('light');
    expect(await bg(page)).toBe(BG.light);
    expect(await mode(page, 'Авто').getAttribute('aria-pressed')).toBe('true');
    await page.getByText('Сейчас светлая').waitFor();

    await mode(page, 'Тёмная').click();
    expect(await attr(page)).toBe('dark');
    expect(await meta(page)).toBe(THEME_COLORS.dark);
    const dark = await bg(page);
    expect(dark).not.toBe(BG.light);

    await page.reload();
    await mode(page, 'Тёмная').waitFor();
    expect(await attr(page)).toBe('dark');
    expect(await mode(page, 'Тёмная').getAttribute('aria-pressed')).toBe('true');
    expect(await bg(page)).toBe(dark);

    await mode(page, 'Авто').click();
    expect(await inPage<string | null>(page, "localStorage.getItem('offerly.theme')")).toBeNull();
    expect(await attr(page)).toBe('light');
    expect(await meta(page)).toBe(THEME_COLORS.light);
    await ctx.close();
  });

  it('«Авто»: вечер наступает сам, система в тёмной теме включает тёмную и днём, «Светлая» сильнее обоих', async () => {
    const evening = await themed({ colorScheme: 'light' }, at('19:58'));
    await evening.page.goto(w.stand.url + '/');
    await mode(evening.page, 'Авто').waitFor();
    expect(await attr(evening.page)).toBe('light');
    await evening.page.clock.fastForward('03:00');
    await evening.page.getByText('Сейчас тёмная: вечером, с 20:00 до 7:00.').waitFor();
    expect(await attr(evening.page)).toBe('dark');
    await mode(evening.page, 'Светлая').click();
    expect(await attr(evening.page)).toBe('light');
    await evening.ctx.close();

    const system = await themed({ colorScheme: 'dark' }, at('10:00'));
    await system.page.goto(w.stand.url + '/');
    await system.page.getByText('Сейчас тёмная: система в тёмной теме.').waitFor();
    expect(await attr(system.page)).toBe('dark');
    await system.ctx.close();
  });

  it('скрипт в index.html ставит тему до загрузки приложения — вечером страница не мигает светлым', async () => {
    const { ctx, page } = await themed({ colorScheme: 'light' }, at('21:00'));
    await page.route('**/assets/*.js', r => r.abort());
    await page.goto(w.stand.url + '/');
    expect(await attr(page)).toBe('dark');
    expect(await meta(page)).toBe(THEME_COLORS.dark);
    await ctx.close();
  });
});
