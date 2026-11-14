/** Главный экран в настоящем Chromium (7.1): карточка «Сегодня» — день программы и одна кнопка, готовность числом,
 *  срок до собеседования, неделя семью отметками без подписей. До и после занятия, обратный отсчёт, пропуски с заморозкой,
 *  пустое состояние; недельная цель — теперь в «Настройках». Три ученика на одном стенде. Пропуски зависят от дня недели,
 *  поэтому ожидание по заморозке считает computeStreak. Правило «без шума»: ни одного абзаца длиннее 140 знаков. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, shot, EMAIL, type World } from './helpers';
import { addDays, todayIn } from '../functions/_lib/dates';
import { computeStreak, weekStart } from '../functions/_lib/dashboard';

const TZ = 'Asia/Almaty';
const MISSER = 'miss@offerly.test';
const EMPTY = 'empty@offerly.test';
const BASE_DATE = '2026-10-29';
const BASE = 53;

const WRITING = 'Thank you for the review of my heat balance calculation. I used the measured flue gas temperature and the fuel analysis from the laboratory, so the losses are based on real data. I agree that the radiation loss is estimated, and I will add the method and the source in the appendix. Please let me know if any other part of the calculation needs more detail.';
const WRITING_EVAL = {
  grammar: 70, vocabulary: 68, coherence: 72, task_response: 74, level: 'B2',
  summary: 'Ответ рецензенту прямой и вежливый, метод и источник данных названы. Ошибок нет.',
  errors: [], rewrite: WRITING,
};

let w: World;
beforeAll(async () => { w = await openWorld(); });
afterAll(async () => { await closeWorld(w); });

const today = () => todayIn(TZ, new Date());
const userId = (email: string): string => w.stand.rows('SELECT id FROM users WHERE email = ?', email)[0].id;
const home = () => w.page.locator('section.card.home');
const badge = () => home().locator('.level-badge.readiness');
const countdown = () => home().locator('.home-facts .countdown');
const mark = (date: string) => home().locator('ol.week-marks > li').nth((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${weekStart(today())}T00:00:00Z`)) / 86_400_000);
const openHome = async () => { await w.page.reload(); await badge().waitFor(); };
const answerButton = () => w.page.getByRole('button', { name: 'Ответить', exact: true });
const stepLabel = (n: number) => w.page.locator(`.card .progress[aria-label="Шаг ${n} из 8"]`);

/** Разминка без ошибок, письмо без правок, две карточки журнала верно — до итога и обратно на главный. */
async function passLesson() {
  for (let n = 1; n <= 5; n++) {
    await stepLabel(n).waitFor();
    if (await w.page.locator('.choices').count()) await w.page.locator('.choices button').nth(2).click();
    else { const box = w.page.locator('textarea'); await box.fill((await box.inputValue()).replace(' have been ', ' has been ')); }
    await answerButton().click();
    await w.page.locator('.review.ok').waitFor();
    await w.page.getByRole('button', { name: 'Дальше' }).click();
  }
  await stepLabel(6).waitFor();
  w.stand.ai.reply('examiner of English writing', WRITING_EVAL);
  await w.page.locator('textarea').fill(WRITING);
  await answerButton().click();
  await w.page.locator('.review.graded').waitFor();
  await w.page.getByRole('button', { name: 'Дальше' }).click();
  for (const n of [7, 8]) {
    await stepLabel(n).waitFor();
    const box = w.page.locator('textarea');
    await box.fill((await box.inputValue()).replace('We have installed', 'We installed'));
    await answerButton().click();
    await w.page.locator('.review.ok').waitFor();
    await w.page.getByRole('button', { name: n === 8 ? 'К итогу' : 'Дальше' }).click();
  }
  await heading(w.page, /^Занятие пройдено/).waitFor();
  const [lesson] = w.stand.rows('SELECT * FROM lessons WHERE user_id = ?', userId(EMAIL));
  if (lesson.bonus === 'offered') {
    await w.page.getByRole('button', { name: 'Не сегодня' }).click();
    await w.page.getByText(/^Отклонена\./).waitFor();
  }
  await w.page.getByRole('button', { name: 'На главную' }).click();
  await heading(w.page, 'Сегодня').waitFor();
}

/** Без шума: не больше одного абзаца-строки, ни одного текста длиннее 140 знаков, нет механики готовности. */
async function quiet() {
  const texts = await home().locator('p, small, li').allInnerTexts();
  for (const t of texts) expect(t.length, t).toBeLessThanOrEqual(140);
  const all = await text(home());
  for (const word of ['База ', 'Серия', 'заморозк', 'бонус', 'свободно', 'Недельная цель']) expect(all, word).not.toContain(word);
}

describe('«Сегодня» до и после занятия', () => {
  it('до занятия: тема дня и «Начать занятие», готовность 53, срок не задан, семь отметок без подписей', async () => {
    await login(w.page, w.stand.url);
    await seed(w.stand);
    await openHome();
    expect(await badge().getAttribute('aria-label')).toBe(`Готовность ${BASE} из 100`);
    expect(await text(home().locator('.today-title'))).toMatch(/^Союзы и инверсия · \d+ минут/);
    expect(await home().getByRole('button').count()).toBe(1);
    await home().getByRole('button', { name: 'Начать занятие' }).waitFor();
    expect(await text(countdown())).toContain('дата собеседования не задана');

    const marks = home().locator('ol.week-marks > li');
    expect(await marks.count()).toBe(7);
    expect(await home().locator('li.is-today').count()).toBe(1);
    expect(await mark(today()).getAttribute('class')).toContain('today');
    expect(await mark(today()).getAttribute('aria-label')).toMatch(/Союзы и инверсия, сегодня$/);
    expect(await home().locator('ol.week-marks > li.free').count()).toBe(6);
    await quiet();
    expect(await heading(w.page, 'Готовность к собеседованию').count()).toBe(0);
    await shot(w.page, 'home-before');
  });

  it('кнопка открывает занятие; недоделанное — «Продолжить занятие» и отметка «идёт»', async () => {
    await home().getByRole('button', { name: 'Начать занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
    await stepLabel(1).waitFor();
    await w.page.goBack();
    await home().getByRole('button', { name: 'Продолжить занятие' }).waitFor();
    expect(await mark(today()).getAttribute('class')).toContain('active');
    await home().getByRole('button', { name: 'Продолжить занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
  });

  it('после занятия: готовность выросла по баллу, день пройден с баллом, вместо кнопки занятия — «Открыть разбор»', async () => {
    await passLesson();
    const [lesson] = w.stand.rows('SELECT * FROM lessons WHERE user_id = ?', userId(EMAIL));
    expect(lesson.status).toBe('finished');
    const gained = Math.round(2 * lesson.score / 100 * 10) / 10;
    const value = Math.round(BASE + gained);
    expect(value).toBeGreaterThan(BASE);
    await home().locator(`.level-badge[aria-label="Готовность ${value} из 100"]`).waitFor();
    expect(await text(home().locator('.today-title'))).toBe(`Союзы и инверсия — пройдено · ${lesson.score}`);
    expect(await mark(today()).getAttribute('class')).toContain('done');
    expect(await home().getByRole('button', { name: /занятие$/ }).count()).toBe(0);
    await home().getByRole('button', { name: 'Открыть разбор' }).click();
    await heading(w.page, /^Занятие пройдено/).waitFor();
    await w.page.goBack();
    await badge().waitFor();
    await quiet();
    await shot(w.page, 'home-after');
  });

  it('недельная цель — в «Настройках»: своя переживает перезагрузку и возвращается к анкете', async () => {
    await w.page.getByRole('button', { name: 'Настройки' }).click();
    const goal = w.page.locator('section.card.goal');
    await goal.getByText('125 мин в неделю · по анкете: 25 мин × 5 дней').waitFor();
    await goal.getByRole('button', { name: 'изменить' }).click();
    await goal.getByLabel('Минут в неделю').fill('200');
    await goal.getByRole('button', { name: 'Сохранить' }).click();
    await goal.getByText('200 мин в неделю · своя').waitFor();
    expect(w.stand.rows('SELECT weekly_goal_minutes AS g FROM profiles WHERE user_id = ?', userId(EMAIL))[0].g).toBe(200);
    await w.page.reload();
    await goal.getByText('200 мин в неделю · своя').waitFor();
    await goal.getByRole('button', { name: 'изменить' }).click();
    await goal.getByRole('button', { name: 'вернуть по анкете (125 мин)' }).click();
    await goal.getByText('125 мин в неделю · по анкете: 25 мин × 5 дней').waitFor();
    expect(w.stand.rows('SELECT weekly_goal_minutes AS g FROM profiles WHERE user_id = ?', userId(EMAIL))[0].g).toBeNull();
    await w.page.getByRole('button', { name: 'назад' }).click();
    await badge().waitFor();
  });

  it('обратный отсчёт: через 10 дней с датой, завтра, сегодня, дата прошла', async () => {
    const setDate = (offset: number) => w.stand.db.prepare('UPDATE profiles SET interview_date = ? WHERE user_id = ?').run(addDays(today(), offset), userId(EMAIL));
    setDate(10);
    await openHome();
    expect(await text(countdown())).toMatch(/через 10 дней.*собеседование · /s);
    setDate(1);
    await openHome();
    expect(await text(countdown())).toContain('завтра');
    setDate(0);
    await openHome();
    expect(await text(countdown())).toContain('сегодня');
    setDate(-1);
    await openHome();
    expect(await text(countdown())).toContain('дата прошла');
    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
  });
});

describe('пропуски и заморозка', () => {
  it('три пропущенных занятия: первое в неделе закрывает заморозка, остальные снижают готовность', async () => {
    await login(w.page, w.stand.url, MISSER);
    await seed(w.stand, MISSER);
    const uid = userId(MISSER);
    const columns = (w.stand.db.prepare('PRAGMA table_info(program_days)').all() as { name: string }[]).map(c => c.name);
    const copy = (date: string) => {
      const select = columns.map(c => (c === 'id' || c === 'day_date' ? '?' : c)).join(', ');
      w.stand.db.prepare(`INSERT INTO program_days (${columns.join(', ')}) SELECT ${select} FROM program_days WHERE user_id = ? AND day_date = ?`)
        .run(...columns.flatMap(c => (c === 'id' ? [`miss-${date}`] : c === 'day_date' ? [date] : [])), uid, today());
    };
    const pastDates = [1, 2, 3].map(n => addDays(today(), -n));
    pastDates.forEach(copy);
    const tomorrow = addDays(today(), 1);
    copy(tomorrow);
    await openHome();

    const s = computeStreak(new Set(), new Set([...pastDates, today()]), today());
    expect(s.frozen.length + s.missed.length).toBe(3);
    expect(s.missed.length).toBeGreaterThan(0);
    const counted = s.missed.filter(d => d > BASE_DATE).length;
    expect(await badge().getAttribute('aria-label')).toBe(`Готовность ${BASE - counted} из 100`);
    // на полосе только текущая неделя: прошедшие дни — цветом по итогу, будущий — план; подписи только в подсказке
    for (const d of pastDates.filter(x => x >= weekStart(today()))) {
      expect(await mark(d).getAttribute('class')).toContain(s.frozen.includes(d) ? 'frozen' : 'missed');
    }
    if (tomorrow < addDays(weekStart(today()), 7)) expect(await mark(tomorrow).getAttribute('aria-label')).toMatch(/план$/);
    await quiet();
    await shot(w.page, 'home-missed');
    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
  });
});

describe('пустое состояние', () => {
  it('без теста и программы: прочерк вместо балла, одна строка про программу, никаких кнопок', async () => {
    await login(w.page, w.stand.url, EMPTY);
    await seed(w.stand, EMPTY, { program: false });
    const uid = userId(EMPTY);
    w.stand.db.prepare('DELETE FROM assessments WHERE user_id = ?').run(uid);
    await openHome();
    expect(await badge().getAttribute('aria-label')).toBe('Готовность не посчитана');
    expect(await text(badge())).toBe('—');
    expect(await text(home().locator('.today-title'))).toBe('Программы ещё нет — составьте её в карточке «Программа».');
    expect(await text(home())).toContain('готовность — после теста уровня');
    expect(await home().locator('ol.week-marks > li.free').count()).toBe(7);
    expect(await home().getByRole('button').count()).toBe(0);
    await quiet();
  });
});
