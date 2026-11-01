/** Тест уровня от первого задания до результата в настоящем Chromium: 12 адаптивных заданий (исправления на 3, 6, 9, 12),
 *  чтение с двумя вопросами, письмо; экзаменатор письма — заготовленный ответ стенда (выдуманная ошибка отбрасывается сервером).
 *  Результат: уровень, лестница, радар пяти осей (беглость не оценивается), письмо с переписанным вариантом, три примера ошибок;
 *  карточка «Тест уровня» на главном заменяет исходный срез 29.10 результатом теста. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, card, shot, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await openWorld();
  await login(w.page, w.stand.url);
  await seed(w.stand);
  await w.page.reload();
  await heading(w.page, 'Готовность к собеседованию').waitFor();
});
afterAll(async () => { await closeWorld(w); });

const WRITING = 'Thank you for the review of my heat balance calculation. I used the measured flue gas temperature and the fuel analysis from the laboratory, so the losses are based on real data. I agree that the radiation loss is estimated, and I will add the method and the source in the appendix. Please let me know if the other parts of the calculation needs more detail.';

/** Оценка письма: одна ошибка из текста и одна выдуманная — выдуманная не должна дойти до экрана. */
const WRITING_EVAL = {
  grammar: 52, vocabulary: 60, coherence: 62, task_response: 64, level: 'B2',
  summary: 'Ответ рецензенту прямой и вежливый, метод назван. Проверьте согласование подлежащего и сказуемого.',
  errors: [
    { original: 'the other parts of the calculation needs more detail', corrected: 'the other parts of the calculation need more detail', note: 'Подлежащее во множественном числе — need без -s.', topic: 'tenses' },
    { original: 'the boiler were replaced last year', corrected: 'the boiler was replaced last year', note: 'Этой фразы в тексте нет.', topic: 'tenses' },
  ],
  rewrite: 'Thank you for reviewing my heat balance calculation. I used the measured flue gas temperature and the laboratory fuel analysis, so the losses rest on real data. I agree that the radiation loss is an estimate; I will add the method and its source to the appendix. Please let me know if any other part of the calculation needs more detail.',
};

/** Вид задания на экране — из подписи «Задание N из 14 · вид». */
async function currentTask(n: number) {
  const label = w.page.locator('.card .muted', { hasText: new RegExp(`^Задание ${n} из 14 · `) });
  await label.waitFor();
  return (await text(label)).replace(/^Задание \d+ из 14 · /, '');
}

const send = () => w.page.getByRole('button', { name: 'Ответить', exact: true }).click();

describe('тест уровня до результата', () => {
  it('12 адаптивных заданий: исправления на 3, 6, 9, 12; ошибка опускает уровень, верные ответы поднимают', async () => {
    const tc = card(w.page, 'Тест уровня');
    await tc.getByRole('button', { name: 'Пройти тест' }).waitFor();
    expect(await text(tc)).toMatch(/Исходный срез/);
    await tc.getByRole('button', { name: 'Пройти тест' }).click();
    await w.page.waitForURL(/screen=test/);
    await heading(w.page, 'Тест уровня').waitFor();

    for (let n = 1; n <= 12; n++) {
      const kind = await currentTask(n);
      if (n % 3 === 0) {
        expect(kind).toBe('исправление ошибки');
        const box = w.page.locator('textarea');
        const prompt = await box.inputValue();
        expect(prompt).toMatch(/ have been inspected /);
        // на третьей позиции ошибка оставлена как есть — неверно; дальше исправлена
        await box.fill(n === 3 ? prompt : prompt.replace(' have been ', ' has been '));
        await send();
      } else {
        expect(kind).toBe('выбор варианта');
        await w.page.locator('.choices button').first().waitFor();
        if (n === 1) {
          // первое — заведомо неверный вариант A мышью
          await w.page.locator('.choices button').nth(0).click();
          await send();
        } else {
          // остальные — клавишами: 3 выбирает ключ C, Enter отправляет
          await w.page.keyboard.press('3');
          expect(await w.page.locator('.choices button').nth(2).getAttribute('aria-checked')).toBe('true');
          await w.page.keyboard.press('Enter');
        }
      }
    }

    const [t] = w.stand.rows("SELECT * FROM assessments WHERE kind = 'placement'");
    expect(t.status).toBe('active');
    const adaptive = w.stand.rows('SELECT * FROM attempts WHERE assessment_id = ? AND position <= 12 ORDER BY position', t.id);
    expect(adaptive).toHaveLength(12);
    // старт — с уровня исходного среза B1; каждый неверный ответ опускает на ступень, верные поднимают до C1 и держат там
    expect(adaptive.map(a => a.level).slice(0, 7)).toEqual(['B1', 'A2', 'B1', 'A2', 'B1', 'B2', 'C1']);
    expect(adaptive.at(-1)!.level).toBe('C1');
    expect(adaptive.filter(a => a.correct === 1)).toHaveLength(10);
  });

  it('чтение и письмо: экзаменатор оценивает письмо по образцу и рубрике, открывается результат', async () => {
    expect(await currentTask(13)).toBe('чтение с двумя вопросами');
    const qs = w.page.locator('fieldset.q');
    expect(await qs.count()).toBe(2);
    // первый вопрос верно (B), второй — неверно (A вместо C)
    await qs.nth(0).locator('.choices button').nth(1).click();
    await qs.nth(1).locator('.choices button').nth(0).click();
    await send();

    expect(await currentTask(14)).toMatch(/^письмо/);
    w.stand.ai.reply('examiner of English writing', WRITING_EVAL);
    await w.page.locator('textarea').fill(WRITING);
    await shot(w.page, 'placement-writing');
    await send();
    await heading(w.page, 'Результат теста').waitFor();
    expect(w.stand.ai.pending()).toBe(0);
    const call = w.stand.ai.calls.filter(c => c.answered).at(-1)!;
    expect(call.user).toContain('MODEL ANSWER');
    expect(call.user).toContain(WRITING);
  });

  it('результат: уровень, лестница, радар пяти осей, письмо с переписанным вариантом, три примера ошибок без выдуманной', async () => {
    const [t] = w.stand.rows("SELECT * FROM assessments WHERE kind = 'placement'");
    expect(t.status).toBe('finished');
    expect(t.overall).not.toBeNull();
    expect(t.scoringNote).toBeNull();
    const screen = w.page.locator('section.card').first();
    const page = await text(screen);
    expect(page).toMatch(/ваш уровень по тесту/);
    expect(page).toMatch(new RegExp(`Сводный балл ${t.overall} из 100 по 4 осям`));

    const ladder = w.page.locator('.ladder');
    expect(await ladder.getAttribute('aria-label')).toBe(`Сводный балл ${t.overall} из 100, уровень ${t.level}`);
    expect(await text(ladder.locator('.ladder-step.current b'))).toBe(t.level);
    expect(await w.page.locator('.level-badge').first().textContent()).toBe(t.level);

    // радар: пять осей, беглость речи в тесте не измеряется
    const title = await text(w.page.locator('.radar svg title'));
    for (const axis of ['Точность грамматики', 'Словарь', 'Связность', 'Ответ на вопрос задания']) expect(title).toMatch(new RegExp(`${axis}: \\d+`));
    expect(title).toMatch(/Беглость речи: не оценивалась/);
    expect(await w.page.locator('.radar-dot').count()).toBe(4);
    expect(await w.page.locator('dl.axes > div.off').count()).toBe(1);

    // письмо: уровень и резюме экзаменатора, одна правка (выдуманная отброшена), переписанный вариант по кнопке
    expect(page).toMatch(/B2 · Ответ рецензенту прямой и вежливый/);
    expect(page).toMatch(/1 правка в тексте/);
    await w.page.getByRole('button', { name: 'Показать переписанный вариант' }).click();
    expect(await text(screen.locator('.passage[lang="en"]'))).toBe(WRITING_EVAL.rewrite);
    await w.page.getByRole('button', { name: 'Скрыть переписанный вариант' }).waitFor();

    // три примера: письмо, исправление, выбор варианта — каждый из собственных ответов
    const ex = w.page.locator('ol.examples > li');
    expect(await ex.count()).toBe(3);
    expect(await text(ex.nth(0).locator('.ex-src'))).toBe('письмо');
    expect(await text(ex.nth(0).locator('.ex-fix'))).toBe('the other parts of the calculation need more detail');
    expect(await text(ex.nth(1).locator('.ex-src'))).toMatch(/^исправление ошибки · /);
    expect(await text(ex.nth(1).locator('.ex-quote'))).toMatch(/The turbine have been inspected/);
    expect(await text(ex.nth(1).locator('.ex-fix'))).toMatch(/The turbine has been inspected/);
    expect(await text(ex.nth(2).locator('.ex-src'))).toMatch(/^выбор варианта · /);
    expect(await text(ex.nth(2).locator('.ex-quote'))).toMatch(/We finished a energy audit/);
    expect(await text(ex.nth(2).locator('.ex-fix'))).toMatch(/We finished the energy audit/);
    expect(page).not.toMatch(/the boiler were replaced/);

    const facts = await text(w.page.locator('.facts-list'));
    expect(facts).toMatch(/верно 10 из 12/);
    expect(facts).toMatch(/один вопрос из двух/);
    await shot(w.page, 'placement-result');

    // ошибки теста — в журнале; выдуманная фраза экзаменатора туда не попала
    const cards = w.stand.rows("SELECT * FROM error_cards WHERE source = 'assessment'");
    // выбор варианта, исправление и правка из письма; чтение карточек не даёт
    expect(cards).toHaveLength(3);
    expect(cards.some(c => /calculation needs more detail/.test(String(c.example)))).toBe(true);
    expect(cards.some(c => /boiler were replaced/.test(String(c.example)))).toBe(false);
  });

  it('на главном карточка «Тест уровня» показывает результат теста вместо исходного среза', async () => {
    const [t] = w.stand.rows("SELECT * FROM assessments WHERE kind = 'placement'");
    await w.page.getByRole('button', { name: 'На главную' }).click();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    const tc = card(w.page, 'Тест уровня');
    await tc.getByRole('button', { name: 'Открыть разбор' }).waitFor();
    await tc.getByRole('button', { name: 'Пройти заново' }).waitFor();
    const body = await text(tc);
    expect(body).not.toMatch(/Исходный срез/);
    expect(await text(tc.locator('.level-badge'))).toBe(t.level);
    expect(body).toMatch(/грамматика и лексика: 10 из 12/);
    await shot(w.page, 'placement-home');

    // разбор открывается повторно без нового вызова модели
    const before = w.stand.ai.calls.length;
    await tc.getByRole('button', { name: 'Открыть разбор' }).click();
    await heading(w.page, 'Результат теста').waitFor();
    expect(await w.page.locator('ol.examples > li').count()).toBe(3);
    expect(w.stand.ai.calls.length).toBe(before);
    await w.page.keyboard.press('Escape');
    await heading(w.page, 'Готовность к собеседованию').waitFor();
  });
});
