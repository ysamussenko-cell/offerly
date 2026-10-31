/** Ключевые сценарии приложения в настоящем Chromium: вход → резюме → главный экран → занятие → тест → настройки.
 *  Стенд — собранный dist и API в памяти (e2e/server.ts); модель отключена, задания из засеянного банка. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, card, shot, EMAIL, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await openWorld(); });
afterAll(async () => { await closeWorld(w); });

describe('вход и первый экран', () => {
  it('вход по почте с кодом: шапка показывает адрес, новому пользователю предлагается резюме', async () => {
    await login(w.page, w.stand.url);
    expect(await text(w.page.locator('.who'))).toBe(EMAIL);
    await heading(w.page, 'Резюме').waitFor();
    expect(w.stand.memory.users.map(u => u.email)).toEqual([EMAIL]);
    expect(w.stand.memory.sessions).toHaveLength(1);
  });

  it('после разбора резюме и анкеты главный экран собирает карточки', async () => {
    const s = await seed(w.stand);
    expect(s.items).toBeGreaterThan(50);
    await w.page.reload();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    for (const name of ['Сегодня', 'Тест уровня', 'Журнал ошибок', 'Программа']) await heading(w.page, name).waitFor();
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Начать занятие' }).waitFor();
    const test = card(w.page, 'Тест уровня');
    await test.getByRole('button', { name: 'Пройти тест' }).waitFor();
    await test.getByRole('button', { name: 'Открыть срез' }).waitFor();
    // исходный срез из засева: B1, 53 из 100
    expect(await text(test)).toMatch(/B1/);
    expect(await text(test)).toMatch(/53/);
    await shot(w.page, 'home');
  });
});

describe('занятие дня', () => {
  it('разминка: выбор клавишами 3 и Enter — «Верно», затем мышью неверный вариант — «Неверно» с эталоном', async () => {
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Начать занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
    await heading(w.page, /^Занятие · /).waitFor();
    const choices = w.page.locator('.choices button');
    await choices.first().waitFor();
    expect(await choices.count()).toBe(4);
    expect(await text(w.page.locator('.card .muted', { hasText: 'Шаг 1 из' }))).toMatch(/Шаг 1 из \d+/);

    // шаг 1 — клавишами: 3 выбирает вариант C (ключ засева), Enter отправляет
    await w.page.keyboard.press('3');
    expect(await choices.nth(2).getAttribute('aria-checked')).toBe('true');
    await w.page.keyboard.press('Enter');
    await w.page.locator('.review.ok').waitFor();
    expect(await text(w.page.locator('.review .verdict'))).toBe('Верно');
    await w.page.getByRole('button', { name: 'Дальше' }).click();

    // шаг 2 — мышью: вариант A заведомо неверен, разбор показывает эталон и запись в журнал
    await choices.first().waitFor();
    await choices.nth(0).click();
    await w.page.getByRole('button', { name: 'Ответить' }).click();
    await w.page.locator('.review.bad').waitFor();
    expect(await text(w.page.locator('.review .verdict'))).toBe('Неверно');
    expect(await text(w.page.locator('.review .ex-fix'))).toMatch(/the/);
    expect(await text(w.page.locator('.review'))).toMatch(/журнал/);
    await shot(w.page, 'lesson-review');
    expect(w.stand.memory.steps.filter(s => s.answeredAt)).toHaveLength(2);
  });

  it('«назад» в браузере закрывает занятие и возвращает на главный, где занятие можно продолжить', async () => {
    await w.page.goBack();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    expect(new URL(w.page.url()).searchParams.get('screen')).toBeNull();
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Продолжить занятие' }).waitFor();
    expect(w.stand.memory.lessons[0].status).toBe('active');
  });
});

describe('тест уровня', () => {
  it('«Пройти тест» выдаёт первое задание из 14, «Прервать» возвращает на главный с кнопкой «Продолжить»', async () => {
    await card(w.page, 'Тест уровня').getByRole('button', { name: 'Пройти тест' }).click();
    await w.page.waitForURL(/screen=test/);
    await heading(w.page, 'Тест уровня').waitFor();
    await w.page.locator('.choices button').first().waitFor();
    expect(await text(w.page.locator('.card .muted', { hasText: 'Задание 1 из' }))).toMatch(/Задание 1 из 14/);
    await shot(w.page, 'test');
    await w.page.getByRole('button', { name: 'Прервать — продолжу позже' }).click();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    await card(w.page, 'Тест уровня').getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
    expect(w.stand.memory.assessments.filter(a => a.kind === 'placement' && a.status === 'active')).toHaveLength(1);
    // ключ задания наружу не ушёл
    const body = await (await w.ctx.request.get(`${w.stand.url}/api/assessment`)).text();
    expect(body).not.toMatch(/"answer":"C"/);
    expect(body).not.toMatch(/explanation/);
  });
});

describe('настройки и выход', () => {
  it('экран настроек открывается из шапки, в нём модель, уведомления и данные; повторный клик закрывает', async () => {
    await w.page.getByRole('button', { name: 'Настройки' }).click();
    await w.page.waitForURL(/screen=settings/);
    for (const name of ['Модель', 'Уведомления', 'Данные']) await heading(w.page, name).waitFor();
    expect(await w.page.getByRole('button', { name: 'Настройки' }).getAttribute('aria-pressed')).toBe('true');
    await shot(w.page, 'settings');
    await w.page.getByRole('button', { name: 'Настройки' }).click();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    expect(new URL(w.page.url()).searchParams.get('screen')).toBeNull();
  });

  it('выход закрывает сессию и возвращает экран входа', async () => {
    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
    expect(w.stand.memory.sessions).toHaveLength(0);
    expect((await w.ctx.request.get(`${w.stand.url}/api/me`)).status()).toBe(401);
  });
});
