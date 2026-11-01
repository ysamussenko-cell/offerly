/** Репетиция интервью и контрольный срез в настоящем Chromium — экраны, где больше всего логики.
 *  Стенд — собранный dist и API в памяти (e2e/server.ts). Модель по умолчанию отключена: сценарий сначала проходит путь
 *  сбоя (встроенный сценарий интервью, «Разобрать снова», «Оценить письмо снова»), затем кладёт заготовленный ответ
 *  экзаменатора и проверяет разбор. Сервер проверяет заготовку так же, как ответ настоящей модели: фразы и ошибки,
 *  которых нет в тексте ученика, отбрасываются. Сегодня по программе — срез, репетиция идёт вне плана. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, card, shot, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await openWorld();
  await login(w.page, w.stand.url);
  await seed(w.stand, undefined, { format: 'checkpoint' });
  await w.page.reload();
  await heading(w.page, 'Готовность к собеседованию').waitFor();
});
afterAll(async () => { await closeWorld(w); });

/** Ответы кандидата: в первом и третьем — фразы, которые экзаменатор предложит заменить. */
const ANSWERS = [
  'I am working in thermal power engineering since fifteen years. I led energy audits of boiler houses and steam turbines and wrote the heat balance for each plant.',
  'Once our team underestimated the heat losses in a district network because we trusted old drawings. We measured the pipes again, corrected the balance and now we always check the drawings on site.',
  'Boiler efficiency is how much of the fuel energy becomes useful heat. If it falls by three percent, the plant pays more for gas every month, so it is very important for the business.',
  'Last winter a client wanted the audit report in one week instead of three. I split the work, did the measurements myself at night and delivered the report on time with all calculations.',
  'I want this role because I can check technical answers with real engineering experience. In the first three months I would learn the guidelines and review answers about energy carefully.',
];

/** Разбор экзаменатора: четыре оси, баллы по вопросам, три фразы — третья выдумана и должна быть отброшена. */
const REVIEW = {
  grammar: 46, vocabulary: 55, coherence: 52, task_response: 58, level: 'B1',
  summary: 'Вы отвечаете по существу и с примерами из практики. Первым делом уберите кальки с русского во временах и предлогах.',
  strengths: ['Конкретные цифры и действия: «did the measurements myself at night».', 'Понятие объяснено через деньги для бизнеса.'],
  turns: [1, 2, 3, 4, 5].map(position => ({ position, score: 40 + position * 4, note: 'Начните с прямого ответа, затем пример.' })),
  replacements: [
    { original: 'I am working in thermal power engineering since fifteen years', better: 'I have been working in thermal power engineering for fifteen years', note: 'Длительность до настоящего момента — Present Perfect Continuous и for.', topic: 'tenses' },
    { original: 'so it is very important for the business', better: 'which directly affects the operating budget', note: 'Назовите последствие для дела вместо общего «very important».', topic: 'vocabulary' },
    { original: 'we optimised the whole supply chain', better: 'we streamlined the supply chain', note: 'Этой фразы в ответах нет.', topic: 'vocabulary' },
  ],
};

const WRITING = 'Thank you for the review of my heat balance calculation. I used the measured flue gas temperature and the fuel analysis from the laboratory, so the losses are based on real data. I agree that the radiation loss is estimated, and I will add the method and the source in the appendix. Please let me know if the other parts of the calculation needs more detail.';

/** Оценка письма: одна настоящая ошибка из текста и одна выдуманная — выдуманная отбрасывается. */
const WRITING_EVAL = {
  grammar: 50, vocabulary: 60, coherence: 62, task_response: 64, level: 'B2',
  summary: 'Ответ рецензенту прямой и вежливый, метод назван. Проверьте согласование подлежащего и сказуемого.',
  errors: [
    { original: 'the other parts of the calculation needs more detail', corrected: 'the other parts of the calculation need more detail', note: 'Подлежащее во множественном числе — need без -s.', topic: 'tenses' },
    { original: 'the boiler were replaced last year', corrected: 'the boiler was replaced last year', note: 'Этой фразы в тексте нет.', topic: 'tenses' },
  ],
  rewrite: 'Thank you for reviewing my heat balance calculation. I used the measured flue gas temperature and the laboratory fuel analysis, so the losses rest on real data. I agree that the radiation loss is an estimate; I will add the method and its source to the appendix. Please let me know if any other part of the calculation needs more detail.',
};

/** Карточка открытого экрана — первая на странице (ниже — служебная карточка «Состояние»). */
const screen = () => w.page.locator('section.card').first();
const turnLabel = () => w.page.locator('.card .muted', { hasText: /^Вопрос \d+ из 5/ });

describe('репетиция интервью', () => {
  it('вне плана: встроенный сценарий из пяти вопросов, короткий ответ не принимается, «Прервать» сохраняет прогресс', async () => {
    const rc = card(w.page, 'Репетиция интервью');
    await rc.getByRole('button', { name: 'Начать репетицию' }).waitFor();
    expect(await text(rc)).toMatch(/вне плана/);
    await rc.getByRole('button', { name: 'Начать репетицию' }).click();
    await w.page.waitForURL(/screen=rehearsal/);
    await turnLabel().waitFor();
    expect(await text(turnLabel())).toMatch(/^Вопрос 1 из 5 · /);
    // модель отключена — интервьюер берёт встроенный сценарий, вопрос с экрана совпадает с записанным
    expect(await text(w.page.locator('.hint', { hasText: 'Интервьюер' }))).toMatch(/встроенный сценарий/);
    const turns = [...w.stand.memory.turns].sort((a, b) => a.position - b.position);
    expect(turns.map(t => t.kind)).toEqual(['experience', 'mistake', 'explain', 'star', 'role']);
    expect(await text(w.page.locator('p.task'))).toBe(turns[0].question);
    expect(turns.every(t => t.rubric.length > 0)).toBe(true);

    const box = w.page.locator('textarea');
    await box.fill('I have fifteen years of experience.');
    await w.page.getByRole('button', { name: 'Ответить', exact: true }).click();
    await w.page.getByRole('alert').waitFor();
    expect(w.stand.memory.turns.filter(t => t.answeredAt)).toHaveLength(0);

    await box.fill(ANSWERS[0]);
    await w.page.getByRole('button', { name: 'Ответить', exact: true }).click();
    await w.page.locator('.card .muted', { hasText: /^Вопрос 2 из 5/ }).waitFor();
    expect(await box.inputValue()).toBe('');
    await shot(w.page, 'rehearsal');

    await w.page.getByRole('button', { name: 'Прервать — продолжу позже' }).click();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
    const again = card(w.page, 'Репетиция интервью');
    await again.getByRole('button', { name: 'Продолжить репетицию' }).waitFor();
    await again.locator('.progress').waitFor();
    expect(await text(again)).toMatch(/Отвечено 1 из 5/);
  });

  it('после пятого ответа экзаменатор не ответил — разбор запрашивается снова и показывает оси, фразы и журнал', async () => {
    await card(w.page, 'Репетиция интервью').getByRole('button', { name: 'Продолжить репетицию' }).click();
    await w.page.waitForURL(/screen=rehearsal/);
    const box = w.page.locator('textarea');
    for (let i = 1; i < 5; i++) {
      await w.page.locator('.card .muted', { hasText: new RegExp(`^Вопрос ${i + 1} из 5`) }).waitFor();
      await box.fill(ANSWERS[i]);
      await w.page.getByRole('button', { name: i === 4 ? 'Ответить и завершить' : 'Ответить', exact: true }).click();
    }
    await heading(w.page, /^Разбор репетиции/).waitFor();
    await w.page.getByRole('button', { name: 'Разобрать снова' }).waitFor();
    expect(await text(screen())).toMatch(/экзаменатор не вернул разбор/);
    const failed = w.stand.ai.calls.filter(c => c.system.includes('mock interview'));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every(c => !c.answered)).toBe(true);
    // экзаменатору ушли все пять ответов с рубриками вопросов — эталоном разбора
    for (const a of ANSWERS) expect(failed[0].user).toContain(a);
    expect(failed[0].user.match(/WHAT A STRONG ANSWER CONTAINS/g)).toHaveLength(5);

    w.stand.ai.reply('mock interview', REVIEW);
    await w.page.getByRole('button', { name: 'Разобрать снова' }).click();
    await heading(w.page, 'Фразы заменить').waitFor();
    expect(w.stand.ai.pending()).toBe(0);
    const r = w.stand.memory.rehearsals.find(x => x.status === 'finished')!;
    expect(r.overall).not.toBeNull();
    expect(await text(w.page.locator('.level-badge'))).toBe(String(r.overall));
    // беглость не оценена: все ответы набраны текстом
    expect(await text(screen())).toMatch(/все ответы набраны текстом/);
    // выдуманная фраза отброшена — осталось две, обе ушли в журнал
    const reps = w.page.locator('ol.examples > li');
    expect(await reps.count()).toBe(2);
    expect(await text(reps.nth(0).locator('.ex-fix'))).toMatch(/for fifteen years/);
    expect(await text(screen())).not.toMatch(/optimised/);
    expect(await text(screen())).toMatch(/В журнал записано 2 карточки/);
    expect(w.stand.memory.cards.filter(c => c.source === 'rehearsal').map(c => c.example)).toEqual([REVIEW.replacements[0].original, REVIEW.replacements[1].original]);
    // баллы по вопросам — от экзаменатора
    expect(w.stand.memory.turns.map(t => t.score).sort()).toEqual([44, 48, 52, 56, 60]);
    await w.page.getByRole('button', { name: 'Показать разговор (5 вопросов)' }).click();
    expect(await w.page.locator('.review.graded').count()).toBe(5);
    await shot(w.page, 'rehearsal-debrief');

    await w.page.getByRole('button', { name: 'На главную' }).click();
    const rc = card(w.page, 'Репетиция интервью');
    await rc.getByRole('button', { name: 'Открыть разбор' }).waitFor();
    expect(await text(rc)).toMatch(new RegExp(`Репетиция пройдена · уровень разговора ${r.level}, 2 карточки в журнале`));
  });
});

/** Задание среза на экране: вид — из подписи «Задание N из 10 · вид». */
async function currentTask(n: number) {
  const label = w.page.locator('.card .muted', { hasText: new RegExp(`^Задание ${n} из 10 · `) });
  await label.waitFor();
  return (await text(label)).replace(/^Задание \d+ из 10 · /, '');
}

describe('контрольный срез', () => {
  it('по программе: восемь заданий с уровня последнего среза, чтение и письмо; одна ошибка уходит в журнал', async () => {
    const cc = card(w.page, 'Контрольный срез');
    await cc.getByRole('button', { name: 'Начать срез' }).waitFor();
    expect(await text(cc)).toMatch(/сегодня по программе/);
    await cc.getByRole('button', { name: 'Начать срез' }).click();
    await w.page.waitForURL(/screen=checkpoint/);
    await heading(w.page, 'Контрольный срез').waitFor();

    for (let n = 1; n <= 8; n++) {
      const kind = await currentTask(n);
      if (kind === 'выбор варианта') {
        // первое задание — заведомо неверный вариант A, остальные — ключ C
        await w.page.locator('.choices button').nth(n === 1 ? 0 : 2).click();
      } else {
        expect(kind).toBe('исправление ошибки');
        const box = w.page.locator('textarea');
        const prompt = await box.inputValue();
        expect(prompt).toMatch(/ have been inspected /);
        await box.fill(prompt.replace(' have been ', ' has been '));
      }
      await w.page.getByRole('button', { name: 'Ответить', exact: true }).click();
    }
    const cp = w.stand.memory.assessments.find(a => a.kind === 'checkpoint')!;
    const adaptive = w.stand.memory.attempts.filter(a => a.assessmentId === cp.id && a.position <= 8);
    // старт — с уровня исходного среза B1; после неверного ответа уровень опускается
    expect(adaptive[0].level).toBe('B1');
    expect(adaptive[1].level).toBe('A2');
    expect(adaptive.filter(a => a.correct === 1)).toHaveLength(7);

    expect(await currentTask(9)).toBe('чтение с двумя вопросами');
    const qs = w.page.locator('fieldset.q');
    expect(await qs.count()).toBe(2);
    await qs.nth(0).locator('.choices button').nth(1).click();
    await qs.nth(1).locator('.choices button').nth(2).click();
    await w.page.getByRole('button', { name: 'Ответить', exact: true }).click();

    expect(await currentTask(10)).toMatch(/^письмо/);
    await w.page.locator('textarea').fill(WRITING);
    await shot(w.page, 'checkpoint-writing');
    await w.page.getByRole('button', { name: 'Ответить', exact: true }).click();
    await heading(w.page, 'Результат среза').waitFor();
    // модель отключена — письмо не оценено, оси посчитаны по остальным заданиям
    await w.page.getByRole('button', { name: 'Оценить письмо снова' }).waitFor();
    expect(await text(w.page.getByRole('alert'))).toMatch(/Письмо не оценено/);
    expect(await text(w.page.locator('.facts-list'))).toMatch(/верно 7 из 8/);
    expect(await text(w.page.locator('.facts-list'))).toMatch(/оба вопроса верно/);
    expect(w.stand.memory.cards.filter(c => c.source === 'assessment')).toHaveLength(1);
  });

  it('письмо оценивается повторно: сравнение с исходным срезом, правка из письма, день программы пройден', async () => {
    w.stand.ai.reply('examiner of English writing', WRITING_EVAL);
    await w.page.getByRole('button', { name: 'Оценить письмо снова' }).click();
    await w.page.getByRole('button', { name: 'Показать переписанный вариант' }).waitFor();
    expect(w.stand.ai.pending()).toBe(0);
    const call = w.stand.ai.calls.filter(c => c.answered).at(-1)!;
    // экзаменатор письма сравнивает с образцом и рубрикой из банка
    expect(call.user).toContain('MODEL ANSWER');
    expect(call.user).toContain(WRITING);

    const cp = w.stand.memory.assessments.find(a => a.kind === 'checkpoint')!;
    expect(cp.overall).not.toBeNull();
    expect(cp.scoringNote).toBeNull();
    const page = await text(screen());
    expect(page).toMatch(new RegExp(`Сводный балл ${cp.overall} из 100`));
    expect(page).toMatch(/1 правка в тексте/);
    expect(page).not.toMatch(/the boiler were replaced/);
    // сравнение — с исходным срезом 29.10: 53 из 100, B1
    const cmp = w.page.locator('.compare');
    expect(await text(cmp.locator('.compare-cell').first())).toMatch(/Исходный срез/);
    expect(await text(cmp.locator('.compare-cell').first())).toMatch(/53/);
    expect(await text(cmp.locator('.compare-cell').nth(1))).toMatch(new RegExp(String(cp.overall)));
    expect(await text(w.page.locator('.ex-fix', { hasText: 'need more detail' }))).toMatch(/calculation need more detail/);
    expect(await text(screen().locator('.row .muted').first())).toMatch(/день 1 программы/);
    await shot(w.page, 'checkpoint-result');

    const day = w.stand.memory.programDays.find(d => d.format === 'checkpoint')!;
    expect(day.status).toBe('done');
    expect(day.score).toBe(cp.overall);
    // ошибка письма записана в журнал рядом с ошибкой выбора варианта
    expect(w.stand.memory.cards.filter(c => c.source === 'assessment')).toHaveLength(2);

    await w.page.getByRole('button', { name: 'На главную' }).click();
    const cc = card(w.page, 'Контрольный срез');
    await cc.getByRole('button', { name: 'Открыть разбор' }).waitFor();
    expect(await text(cc)).toMatch(new RegExp(`Срез пройден · ${cp.overall} из 100`));
    expect(await text(cc)).toMatch(/день 1 программы · грамматика и лексика: 7 из 8/);
  });
});
