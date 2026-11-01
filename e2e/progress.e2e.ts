/** Программа, журнал ошибок, достижения и банк заданий в настоящем Chromium — экраны, где ученик видит свой прогресс.
 *  Стенд — собранный dist и API на SQLite в памяти (e2e/server.ts). Два ученика на одном стенде: первый составляет программу сам
 *  (засев без дня программы), второй проходит занятие дня по засеянному банку — разминку без ошибок, письмо, две карточки
 *  журнала (одна верно, одна неверно) — и видит, как это меняет журнал, достижения и день программы. Банк пополняется
 *  заготовленными ответами модели: генератор пишет три задания, экзаменатор решает каждое вслепую — одно принято,
 *  одно отклонено по ключу, одно не доходит до проверки. Даты программы зависят от дня запуска, поэтому сценарий
 *  проверяет инварианты разметки (28 дней, срезы на 14-й и 28-й, воскресенья — репетиции), а не конкретные дни. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, card, shot, EMAIL, type World } from './helpers';
import { ACHIEVEMENTS } from '../functions/_lib/achievements';
import { PROGRAM_TOPICS, MIXED_TOPIC } from '../functions/_lib/program';
import { todayIn } from '../functions/_lib/dates';

const PLANNER = 'plan@offerly.test';
const TZ = 'Asia/Almaty';

let w: World;
beforeAll(async () => { w = await openWorld(); });
afterAll(async () => { await closeWorld(w); });

const userId = (email: string): string => w.stand.rows('SELECT id FROM users WHERE email = ?', email)[0].id;
const daysOf = (email: string) => w.stand.rows('SELECT * FROM program_days WHERE user_id = ? ORDER BY day_date', userId(email));
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const label = (topic: string) => PROGRAM_TOPICS.find(t => t.id === topic)!.label;
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 50));
  if (!cond()) throw new Error(`не дождался: ${what}`);
};

describe('программа', () => {
  it('«Составить программу»: 28 дней по неделям, срезы на 14-й и 28-й день, воскресенья — репетиции, открыта текущая неделя', async () => {
    await login(w.page, w.stand.url, PLANNER);
    await seed(w.stand, PLANNER, { program: false });
    await w.page.reload();
    const pc = card(w.page, 'Программа');
    await pc.getByRole('button', { name: 'Составить программу' }).click();
    await pc.locator('.weeks').waitFor();

    const days = daysOf(PLANNER);
    expect(days).toHaveLength(28);
    const today = todayIn(TZ, new Date());
    expect(days[0].dayDate).toBe(today);
    expect(days.filter(d => d.format === 'checkpoint').map(d => d.position)).toEqual([14, 28]);
    const rehearsals = days.filter(d => d.format === 'rehearsal');
    expect(rehearsals).toHaveLength(4);
    // репетиция — в воскресенье; если воскресенье занято срезом, то в субботу накануне
    for (const r of rehearsals) expect(weekday(r.dayDate) === 0 || days.find(d => d.position === r.position + 1)?.format === 'checkpoint').toBe(true);
    for (const d of days.filter(x => x.topic === MIXED_TOPIC.id)) expect(weekday(d.dayDate)).toBe(6);
    // письмо чередуется по дням занятий
    const writings = days.filter(d => d.format === 'lesson').map(d => d.writing);
    expect(writings.every((x, i) => x === (i % 2 ? 'explain' : 'review'))).toBe(true);
    expect(await text(pc)).toMatch(/28 дней · 22 занятия, 4 репетиции, 2 среза/);

    // открыта только текущая неделя, в ней отмечено «сегодня»
    const heads = pc.locator('.week-h');
    expect(await heads.count()).toBe(4);
    expect(await pc.locator('.week-h[aria-expanded="true"]').count()).toBe(1);
    expect(await text(pc.locator('.week-h[aria-expanded="true"]'))).toMatch(/^Неделя 1.*текущая$/);
    expect(await pc.locator('li.day.today').count()).toBe(1);
    for (let i = 1; i < 4; i++) await heads.nth(i).click();
    expect(await pc.locator('li.day').count()).toBe(28);
    // у дня — тема или формат, формат письма и причина выбора
    const first = pc.locator('li.day').first();
    if (days[0].format === 'lesson') expect(await text(first.locator('.day-title'))).toContain(label(days[0].topic));
    expect(await text(first.locator('.day-reason'))).toContain(days[0].reason!);
    await shot(w.page, 'program');
  });

  it('«Переставить темы»: два клика по занятиям меняют их темы местами, срезы и репетиции не выбираются', async () => {
    const pc = card(w.page, 'Программа');
    await pc.getByRole('button', { name: 'Переставить темы' }).click();
    expect(await text(pc.locator('.hint.warn'))).toMatch(/Выберите два занятия/);
    // двигаются только будущие занятия; репетиции и срезы — нет
    const days = daysOf(PLANNER);
    expect(await pc.locator('li.day.movable').count()).toBe(days.filter(d => d.format === 'lesson').length);
    expect(await pc.locator('li.day.rehearsal.movable, li.day.checkpoint.movable').count()).toBe(0);

    const ia = days.findIndex(d => d.format === 'lesson' && d.topic !== MIXED_TOPIC.id);
    const ib = days.findIndex((d, i) => i > ia && d.format === 'lesson' && d.topic !== MIXED_TOPIC.id && d.topic !== days[ia].topic);
    const [a, b] = [days[ia], days[ib]];
    const items = pc.locator('li.day');
    await items.nth(ia).click();
    expect(await items.nth(ia).getAttribute('class')).toMatch(/\bpicked\b/);
    expect(await text(pc.locator('.hint.warn'))).toMatch(/Теперь выберите второе занятие/);
    await items.nth(ib).click();
    await until(() => daysOf(PLANNER)[ia].topic === b.topic, 'перестановка тем');
    const after = daysOf(PLANNER);
    expect([after[ia].topic, after[ib].topic]).toEqual([b.topic, a.topic]);
    expect([after[ia].reason, after[ib].reason]).toEqual([b.reason, a.reason]);
    await pc.locator('.hint.warn', { hasText: 'Выберите два занятия' }).waitFor();
    expect(await text(items.nth(ia).locator('.day-title'))).toContain(label(b.topic));
    expect(await text(items.nth(ib).locator('.day-title'))).toContain(label(a.topic));
    await pc.getByRole('button', { name: 'Готово' }).click();
    expect(await pc.locator('li.day.movable').count()).toBe(0);
  });

  it('«Пересобрать по свежим ошибкам» строит дни заново с того же начала', async () => {
    const pc = card(w.page, 'Программа');
    const before = daysOf(PLANNER).map(d => d.id);
    await pc.getByRole('button', { name: 'Пересобрать по свежим ошибкам' }).click();
    await until(() => daysOf(PLANNER).every(d => !before.includes(d.id)), 'пересборка');
    const days = daysOf(PLANNER);
    expect(days).toHaveLength(28);
    expect(days[0].dayDate).toBe(todayIn(TZ, new Date()));
    await pc.getByRole('button', { name: 'Пересобрать по свежим ошибкам' }).waitFor();
    expect(await text(pc)).toMatch(/22 занятия, 4 репетиции, 2 среза/);

    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
  });
});

/** Письмо занятия (отзыв рецензента) и оценка экзаменатора без ошибок — открывает «Первый отзыв рецензента без правок». */
const WRITING = 'Thank you for the review of my heat balance calculation. I used the measured flue gas temperature and the fuel analysis from the laboratory, so the losses are based on real data. I agree that the radiation loss is estimated, and I will add the method and the source in the appendix. Please let me know if any other part of the calculation needs more detail.';
const WRITING_EVAL = {
  grammar: 70, vocabulary: 68, coherence: 72, task_response: 74, level: 'B2',
  summary: 'Ответ рецензенту прямой и вежливый, метод и источник данных названы. Ошибок нет.',
  errors: [], rewrite: WRITING,
};

const answerButton = () => w.page.getByRole('button', { name: 'Ответить', exact: true });
const stepLabel = (n: number) => w.page.locator('.card .muted', { hasText: new RegExp(`^Шаг ${n} из 8 · `) });
const fresh = () => w.page.locator('.tag.today', { hasText: 'новое' });

describe('журнал ошибок и достижения', () => {
  it('до занятия: две карточки к повтору сегодня, достижений нет', async () => {
    await login(w.page, w.stand.url);
    await seed(w.stand);
    await w.page.reload();
    const jc = card(w.page, 'Журнал ошибок');
    await jc.getByRole('button', { name: 'Показать карточки' }).waitFor();
    expect(await text(jc)).toMatch(/2 карточки в работе, 2 к повтору сегодня\./);
    expect(await text(jc.locator('.chips'))).toBe('Времена · 2');
    await jc.getByRole('button', { name: 'Показать карточки' }).click();
    const cards = jc.locator('ol.examples > li');
    expect(await cards.count()).toBe(2);
    expect(await text(cards.nth(0).locator('.ex-src'))).toBe('времена · повтор сегодня · ещё не повторялась');
    expect(await text(cards.nth(0).locator('s'))).toMatch(/^We have installed \d boilers in 2020/);
    expect(await text(cards.nth(0).locator('.ex-fix'))).toMatch(/^We installed \d boilers in 2020/);

    const ac = card(w.page, 'Достижения');
    await ac.getByText('Открытых пока нет').waitFor();
    expect(await text(ac)).toContain(`0 из ${ACHIEVEMENTS.length}`);
    await ac.getByRole('button', { name: `Показать все (${ACHIEVEMENTS.length})` }).click();
    expect(await ac.locator('li.ach').count()).toBe(ACHIEVEMENTS.length);
    await ac.getByRole('button', { name: 'Только ближайшие' }).click();
  });

  it('занятие: разминка без ошибок, письмо без правок, карточки — одна верно, одна неверно; в итоге новые достижения', async () => {
    await card(w.page, 'Сегодня').getByRole('button', { name: 'Начать занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
    // разминка: выбор варианта — ключ C, исправление — глагол в третьем лице
    for (let n = 1; n <= 5; n++) {
      await stepLabel(n).waitFor();
      if (await w.page.locator('.choices').count()) await w.page.locator('.choices button').nth(2).click();
      else { const box = w.page.locator('textarea'); await box.fill((await box.inputValue()).replace(' have been ', ' has been ')); }
      await answerButton().click();
      await w.page.locator('.review.ok').waitFor();
      await w.page.getByRole('button', { name: 'Дальше' }).click();
    }

    expect(await text(stepLabel(6))).toMatch(/письмо$/);
    w.stand.ai.reply('examiner of English writing', WRITING_EVAL);
    await w.page.locator('textarea').fill(WRITING);
    await answerButton().click();
    await w.page.locator('.review.graded').waitFor();
    expect(await text(w.page.locator('.review .verdict'))).toMatch(/^Письмо: \d+ из 100 · B2$/);
    expect(w.stand.ai.pending()).toBe(0);
    await w.page.getByRole('button', { name: 'Дальше' }).click();

    // карточки журнала: первая — как надо, вторая — по-прежнему с ошибкой
    await stepLabel(7).waitFor();
    const box = w.page.locator('textarea');
    await box.fill((await box.inputValue()).replace('We have installed', 'We installed'));
    await answerButton().click();
    await w.page.locator('.review.ok').waitFor();
    expect(await text(w.page.locator('.review'))).toMatch(/1 из 3 верных подряд, следующий повтор через \d+ д/);
    await w.page.getByRole('button', { name: 'Дальше' }).click();
    await stepLabel(8).waitFor();
    await box.fill((await box.inputValue()).replace(' at the plant', ' at that plant'));
    await answerButton().click();
    await w.page.locator('.review.bad').waitFor();
    expect(await text(w.page.locator('.review'))).toContain('Серия сброшена, карточка вернётся завтра.');
    await shot(w.page, 'lesson-card-review');
    await w.page.getByRole('button', { name: 'К итогу' }).click();

    await heading(w.page, 'Занятие пройдено · Союзы и инверсия').waitFor();
    const [lesson] = w.stand.rows('SELECT * FROM lessons WHERE user_id = ?', userId(EMAIL));
    // бонус предлагается по хешу id занятия — если предложен, отказываемся: он к журналу и достижениям не относится
    if (lesson.bonus === 'offered') {
      await w.page.getByRole('button', { name: 'Не сегодня' }).click();
      await w.page.getByText(/^Отклонена\./).waitFor();
    }
    const facts = await text(w.page.locator('.facts-list'));
    expect(facts).toMatch(/Разминка по теме «Союзы и инверсия»: верно 5 из 5/);
    expect(facts).toMatch(/Карточки журнала: верно 1 из 2\./);
    const unlocked = w.page.locator('.unlocked li.ach b');
    expect((await unlocked.allTextContents()).sort()).toEqual(['Первый отзыв рецензента без правок', 'Пять подряд без ошибки — союзы и инверсия', 'Разминка без ошибок']);
    await shot(w.page, 'lesson-summary');
    await w.page.getByRole('button', { name: 'На главную' }).click();
    await heading(w.page, 'Готовность к собеседованию').waitFor();
  });

  it('после занятия: журнал переносит карточки по FSRS, неверная вернётся завтра', async () => {
    const today = todayIn(TZ, new Date());
    const tomorrow = todayIn(TZ, new Date(Date.now() + 86_400_000));
    const cards = w.stand.rows('SELECT * FROM error_cards WHERE user_id = ?', userId(EMAIL));
    expect(cards).toHaveLength(2);
    const ok = cards.find(c => c.streak === 1)!, bad = cards.find(c => c.lapses === 1)!;
    expect(ok.due! > today).toBe(true);
    expect(bad.due).toBe(tomorrow);
    expect(bad.streak).toBe(0);

    const jc = card(w.page, 'Журнал ошибок');
    await jc.getByText(/ближайший повтор/).waitFor();
    expect(await text(jc)).toMatch(/2 карточки в работе, ближайший повтор \d+ \S+ \d{4} г\./);
    expect(await text(jc)).not.toMatch(/к повтору сегодня/);
    await jc.getByRole('button', { name: 'Показать карточки' }).click();
    const statuses = await jc.locator('ol.examples > li .ex-src').allTextContents();
    expect(statuses).toHaveLength(2);
    expect(statuses.some(s => /^времена · повтор .+ · 1 из 3 верных подряд$/.test(s))).toBe(true);
    expect(statuses.some(s => /^времена · повтор .+ · серия сброшена · 1 сбой$/.test(s))).toBe(true);
    expect(statuses.every(s => !s.includes('повтор сегодня'))).toBe(true);
    await shot(w.page, 'journal');
  });

  it('достижения: три открытых с отметкой «новое», растяжка 2 из 3; после показа отметка гаснет', async () => {
    const ac = card(w.page, 'Достижения');
    await ac.locator('li.ach.on').first().waitFor();
    const rows = w.stand.rows('SELECT * FROM achievements WHERE user_id = ?', userId(EMAIL));
    expect(rows.map(r => r.code).sort()).toEqual(['review-clean', 'streak5:conjunctions', 'warmup-perfect']);
    expect(await text(ac)).toContain(`3 из ${ACHIEVEMENTS.length}`);
    expect(await ac.locator('li.ach.on').count()).toBe(3);
    expect(await ac.locator('li.ach.on .tag', { hasText: 'новое' }).count()).toBe(3);
    expect(await text(ac.locator('li.ach.on', { hasText: 'Разминка без ошибок' }).locator('small'))).toMatch(/^открыто · \d+ \S+ \d{4} г\.$/);
    // растяжка: позиции 4 и 5 разминки ступенью выше — две верных из трёх
    const stretch = ac.locator('li.ach:not(.on)', { hasText: 'Три растяжки подряд' });
    expect(await text(stretch.locator('small'))).toBe('2 из 3');
    expect(await stretch.locator('.progress').getAttribute('aria-label')).toBe('2 из 3');
    await shot(w.page, 'achievements');

    // показанное отмечается увиденным — после перезагрузки «новое» не горит
    await until(() => w.stand.rows('SELECT code FROM achievements WHERE user_id = ? AND seen_at IS NULL', userId(EMAIL)).length === 0, 'отметка увиденным');
    await w.page.reload();
    await card(w.page, 'Достижения').locator('li.ach.on').first().waitFor();
    expect(await fresh().count()).toBe(0);
    expect(await card(w.page, 'Достижения').locator('li.ach.on').count()).toBe(3);
  });

  it('день программы отмечен пройденным с баллом занятия', async () => {
    const day = daysOf(EMAIL)[0];
    const [lesson] = w.stand.rows('SELECT * FROM lessons WHERE user_id = ?', userId(EMAIL));
    expect(day.status).toBe('done');
    expect(day.score).toBe(lesson.score);
    const pc = card(w.page, 'Программа');
    expect(await text(pc.locator('li.day.today .tag.ok'))).toBe(`пройдено · ${lesson.score}`);
    expect(await text(pc)).toMatch(/пройдено 1/);
  });
});

/** Ответ генератора: годное задание, задание с ключом, который экзаменатор не подтвердит, и задание без пропуска. */
const GENERATED = {
  items: [
    { prompt: 'The auditor asked for ___ copy of the heat balance before the site visit.', options: ['the', 'a', 'an', '—'], answer: 'B', explanation: 'Предмет упомянут впервые и исчисляем — неопределённый артикль a.' },
    { prompt: 'We replaced ___ feed pump that failed during the winter tests.', options: ['a', 'an', 'the', '—'], answer: 'C', explanation: 'Насос определён придаточным — артикль the.' },
    { prompt: 'The report describes the boiler house and its auxiliary equipment.', options: ['a', 'an', 'the', '—'], answer: 'C', explanation: 'Пропуска нет — задание не годится.' },
  ],
};

describe('банк заданий', () => {
  const bank = () => card(w.page, 'Банк заданий');
  const b1mcq = () => w.stand.rows("SELECT id FROM items WHERE level = 'B1' AND kind = 'mcq' AND status = 'verified'").length;

  it('сводка по уровням и видам совпадает с банком; без модели пополнение даёт ошибку и ничего не пишет', async () => {
    const bc = bank();
    await bc.locator('table.bank tbody tr').first().waitFor();
    const row = bc.locator('table.bank tbody tr', { has: w.page.locator('th', { hasText: /^B1$/ }) });
    expect(await text(row.locator('td').first())).toBe(String(b1mcq()));
    const verified = w.stand.rows("SELECT id FROM items WHERE status = 'verified'").length;
    expect(await text(bc)).toMatch(new RegExp(`Принято: ${verified} задани\\S*\\. Отклонено проверкой: 0 заданий\\.`));

    const before = w.stand.rows('SELECT id FROM items').length;
    await bc.getByLabel('Сколько').selectOption('3');
    await bc.getByRole('button', { name: 'Пополнить банк' }).click();
    await bc.getByRole('alert').waitFor();
    expect(w.stand.rows('SELECT id FROM items')).toHaveLength(before);
  });

  it('пополнение: генератор пишет три задания, экзаменатор решает вслепую — одно принято, одно отклонено, одно не дошло', async () => {
    const bc = bank();
    const before = b1mcq();
    w.stand.ai.reply('You write calibrated English test items', GENERATED);
    w.stand.ai.reply('copy of the heat balance', { answer: 'B', level: 'B1', issues: [] }, 'user');
    w.stand.ai.reply('feed pump that failed', { answer: 'A', level: 'B1', issues: [] }, 'user');
    await bc.getByRole('button', { name: 'Пополнить банк' }).click();
    await bc.locator('ol.items').waitFor();
    expect(w.stand.ai.pending()).toBe(0);

    expect(await text(bc.locator('ol.items').locator('xpath=preceding-sibling::p[1]'))).toBe('B1 · Артикли: принято 1, отклонено 1 · не дошло до проверки: 1 (в предложении нет пропуска ___)');
    const ok = bc.locator('li.item.verified'), bad = bc.locator('li.item.rejected');
    expect(await ok.count()).toBe(1);
    expect(await bad.count()).toBe(1);
    expect(await text(ok.locator('.opts li.ok'))).toBe('B a');
    expect(await text(ok)).toContain('Проверка: ключ и уровень подтверждены');
    expect(await text(bad)).toContain('Проверка: ключ C не совпал с решением экзаменатора A');

    // генератор пишет в профессиональном мире ученика; экзаменатор не видит ни ключа, ни объяснения
    const gen = w.stand.ai.calls.filter(c => c.answered && c.system.includes('You write calibrated English test items')).at(-1)!;
    expect(gen.system).toContain('boiler efficiency');
    const checks = w.stand.ai.calls.filter(c => c.answered && c.system.includes('independent examiner'));
    expect(checks).toHaveLength(2);
    for (const c of checks) { expect(c.user).not.toContain('артикль'); expect(c.user).toContain('Solve this gap-fill item'); }

    // сводка обновилась: B1 · выбор варианта +1, отклонено 1
    expect(b1mcq()).toBe(before + 1);
    const row = bc.locator('table.bank tbody tr', { has: w.page.locator('th', { hasText: /^B1$/ }) });
    await row.locator('td').first().filter({ hasText: new RegExp(`^${before + 1}$`) }).waitFor();
    expect(await text(bc)).toMatch(/Отклонено проверкой: 1 задание\./);
    await shot(w.page, 'bank');
  });

  it('«Показать имеющиеся» — задания по уровню, виду и теме с ключами и заметками проверки', async () => {
    const bc = bank();
    await bc.getByRole('button', { name: 'Показать имеющиеся' }).click();
    const n = w.stand.rows("SELECT id FROM items WHERE level = 'B1' AND kind = 'mcq' AND topic = 'articles'").length;
    await bc.getByText(new RegExp(`^B1 · Артикли · .+: последние ${n} задани`)).waitFor();
    expect(await bc.locator('ol.items > li').count()).toBe(n);
    expect(await bc.locator('ol.items > li.rejected').count()).toBe(1);
  });
});
