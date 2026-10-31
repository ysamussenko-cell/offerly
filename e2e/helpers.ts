/** Общие шаги сценариев: браузер, вход по коду, засев стенда, ожидания без матчеров @playwright/test. */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startStand, type Stand } from './server';

export const EMAIL = 'e2e@offerly.test';
export const DESKTOP = { width: 1100, height: 900 };
export const PHONE = { width: 390, height: 844 };
/** pointer: coarse (2), hover: none (1) — значения перечислений Blink. */
const PHONE_BLINK = '--blink-settings=availablePointerTypes=2,primaryPointerType=2,availableHoverTypes=1,primaryHoverType=1';

export interface World { stand: Stand; browser: Browser; ctx: BrowserContext; page: Page }

export async function openWorld(viewport = DESKTOP, mobile = false): Promise<World> {
  const stand = await startStand();
  // Эмуляция устройства Playwright не трогает медиазапросы hover/pointer (CDP-эмуляция сбрасывается при навигации),
  // поэтому телефон получает их настройками Blink при запуске: только тач, без наведения — как настоящий телефон.
  const browser = await chromium.launch({ args: mobile ? [PHONE_BLINK] : [] });
  const ctx = await browser.newContext({ viewport, locale: 'ru-RU', timezoneId: 'Asia/Almaty', isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  return { stand, browser, ctx, page };
}

export async function closeWorld(w: World | undefined) {
  if (!w) return;
  await w.ctx.close().catch(() => {});
  await w.browser.close().catch(() => {});
  await w.stand.close().catch(() => {});
}

/** Вход по почте: код приходит в ответе API (режим разработки стенда) и показывается на экране. */
export async function login(page: Page, baseUrl: string, email = EMAIL) {
  await page.goto(baseUrl + '/');
  await page.getByLabel('Почта').fill(email);
  await page.getByRole('button', { name: 'Получить код' }).click();
  const hint = page.getByText('Режим разработки');
  await hint.waitFor();
  const code = (await hint.textContent())?.match(/\d{6}/)?.[0];
  if (!code) throw new Error('код входа не показан на экране');
  await page.getByLabel('Шесть цифр').fill(code);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.locator('.who').waitFor();
  return code;
}

export async function seed(stand: Stand, email = EMAIL, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${stand.url}/__e2e/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, ...extra }) });
  const body = await r.json() as { ok: boolean; today?: string; items?: number; cards?: number };
  if (!body.ok) throw new Error(`засев не удался: ${JSON.stringify(body)}`);
  return body;
}

export const text = async (l: Locator) => ((await l.textContent()) ?? '').trim();
export const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { name, exact: true });
/** Карточка главного экрана по заголовку — кнопки с одинаковым текстом есть в нескольких карточках. */
export const card = (page: Page, name: string) => page.locator('section.card', { has: page.getByRole('heading', { name, exact: true }) });

/** Снимок экрана в папку из E2E_SHOTS (если задана) — чтобы глазами проверить экраны после прогона. */
export async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Страница не шире окна — на телефоне горизонтальной прокрутки быть не должно. */
// Код для браузера — строками: в tsconfig стенда нет DOM-типов (они конфликтуют с типами Workers).
export const overflowX = (page: Page) => page.evaluate('document.documentElement.scrollWidth - window.innerWidth') as Promise<number>;
export const inPage = <T,>(page: Page, expr: string) => page.evaluate(expr) as Promise<T>;
