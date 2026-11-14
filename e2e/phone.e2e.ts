/** Телефон и страница установки: вёрстка без горизонтальной прокрутки, экран занятия на 390 px,
 *  /install отдаётся оболочкой и показывает шаги для платформы. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, heading, card, overflowX, inPage, shot, PHONE, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await openWorld(PHONE, true); });
afterAll(async () => { await closeWorld(w); });

describe('телефон 390 px', () => {
  it('экран входа и главный не шире окна', async () => {
    await w.page.goto(w.stand.url + '/');
    await heading(w.page, 'Вход').waitFor();
    expect(await overflowX(w.page)).toBeLessThanOrEqual(0);
    await login(w.page, w.stand.url);
    await seed(w.stand);
    await w.page.reload();
    await heading(w.page, 'Сегодня').waitFor();
    await heading(w.page, 'Журнал ошибок').waitFor();
    expect(await overflowX(w.page)).toBeLessThanOrEqual(0);
    await shot(w.page, 'phone-home');
  });

  it('занятие на телефоне: варианты на всю ширину, строки клавиш нет, поле ответа без автофокуса', async () => {
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Начать занятие' }).tap();
    await w.page.waitForURL(/screen=lesson/);
    const choices = w.page.locator('.choices button');
    await choices.first().waitFor();
    expect(await overflowX(w.page)).toBeLessThanOrEqual(0);
    const width = await inPage<number>(w.page, "document.querySelector('.choices button').getBoundingClientRect().width");
    const cardWidth = await inPage<number>(w.page, "document.querySelector('section.card').getBoundingClientRect().width");
    expect(width).toBeGreaterThan(cardWidth * 0.6);
    // строки клавиш на экране занятия нет (7.8) — ни на телефоне, ни на компьютере
    expect(await w.page.locator('.keys').count()).toBe(0);
    await shot(w.page, 'phone-lesson');
    expect(await inPage<string>(w.page, 'document.activeElement && document.activeElement.tagName')).not.toBe('TEXTAREA');
  });

  it('жест «назад» возвращает на главный, а не закрывает приложение', async () => {
    await w.page.goBack();
    await heading(w.page, 'Сегодня').waitFor();
    expect(new URL(w.page.url()).searchParams.get('screen')).toBeNull();
  });
});

describe('страница установки', () => {
  it('/install отдаётся оболочкой SPA, показывает заголовок и карточку Windows, кнопка установки PWA есть', async () => {
    await w.page.goto(w.stand.url + '/install');
    await heading(w.page, 'Установить Offerly').waitFor();
    await heading(w.page, 'Для Windows — установщик').waitFor();
    await shot(w.page, 'phone-install');
    expect(await overflowX(w.page)).toBeLessThanOrEqual(0);
    const manifest = await w.ctx.request.get(`${w.stand.url}/manifest.webmanifest`);
    expect(manifest.status()).toBe(200);
    const m = await manifest.json() as { shortcuts?: { url: string }[] };
    expect(m.shortcuts?.map(s => s.url)).toEqual(['/?screen=lesson', '/?screen=rehearsal', '/?screen=settings']);
  });
});
