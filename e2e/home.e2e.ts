/** Главный экран в настоящем Chromium: карточка «Готовность к собеседованию» до и после занятия — прибавка по баллу,
 *  разбор, прогноз, серия, недельная цель, план недели. Отдельно — цель своими минутами, обратный отсчёт, пропуски
 *  с заморозкой и пустое состояние без теста и программы. Три ученика на одном стенде. Пропуски зависят от дня недели,
 *  поэтому ожидание по заморозке считает computeStreak; минуты сдвигаются в базе — занятие в браузере идёт секунды. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, seed, text, heading, shot, EMAIL, type World } from './helpers';
import { addDays, todayIn } from '../functions/_lib/dates';
import { computeStreak, weekStart } from '../functions/_lib/dashboard';
import { nextStep } from '../functions/_lib/scoring';

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
const fact = (name: string) => home().locator('.home-facts > div', { has: w.page.getByRole('term').filter({ hasText: name }) });
const cell = (date: string) => home().locator('ol.week-strip > li').nth((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${weekStart(today())}T00:00:00Z`)) / 86_400_000);
const openHome = async () => { await w.page.reload(); await badge().waitFor(); };
const answerButton = () => w.page.getByRole('button', { name: 'Ответить', exact: true });
const stepLabel = (n: number) => w.page.locator('.card .muted', { hasText: new RegExp(`^Шаг ${n} из 8 · `) });

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
  await heading(w.page, 'Готовность к собеседованию').waitFor();
}

describe('готовность до и после занятия', () => {
  it('до занятия: база среза 53, серии нет, цель 0 из 125 по анкете, сегодня в плане и кнопка', async () => {
    await login(w.page, w.stand.url);
    await seed(w.stand);
    await openHome();
    expect(await badge().getAttribute('aria-label')).toBe(`Готовность ${BASE} из 100`);
    const all = await text(home());
    expect(all).toContain('уровень B1 · цель C1');
    expect(all).toMatch(/за последнюю неделю готовность не росла — ступень не приближается/);
    expect(all).toMatch(/База 53 — исходный срез 29 окт · занятий после него ещё не было/);
    expect(await text(fact('Собеседование'))).toContain('дата не задана');
    expect(await text(fact('Серия'))).toMatch(/0 дней.*занятий ещё не было/);
    expect(await text(fact('Недельная цель'))).toMatch(/0 из 125 мин.*осталось/);
    expect(await text(fact('Недельная цель'))).toContain('по анкете: 25 мин × 5 дней');

    const strip = home().locator('ol.week-strip > li');
    expect(await strip.count()).toBe(7);
    expect(await home().locator('li.is-today').count()).toBe(1);
    expect(await text(cell(today()))).toMatch(/Союзы и инверсия.*сегодня$/);
    expect(await home().locator('ol.week-strip > li.free').count()).toBe(6);
    await shot(w.page, 'home-before');
  });

  it('своя недельная цель переживает перезагрузку и возвращается к анкете', async () => {
    const goal = fact('Недельная цель');
    await goal.getByRole('button', { name: 'изменить' }).click();
    await home().getByLabel('Минут в неделю').fill('200');
    await home().getByRole('button', { name: 'Сохранить' }).click();
    await goal.getByText('0 из 200 мин').waitFor();
    expect(w.stand.rows('SELECT weekly_goal_minutes AS g FROM profiles WHERE user_id = ?', userId(EMAIL))[0].g).toBe(200);
    await openHome();
    expect(await text(goal)).toMatch(/0 из 200 мин.*своя/);

    await goal.getByRole('button', { name: 'изменить' }).click();
    await home().getByRole('button', { name: 'вернуть по анкете (125 мин)' }).click();
    await goal.getByText('0 из 125 мин').waitFor();
    expect(w.stand.rows('SELECT weekly_goal_minutes AS g FROM profiles WHERE user_id = ?', userId(EMAIL))[0].g).toBeNull();
  });

  it('кнопка карточки открывает занятие; недоделанное — «Продолжить занятие» и статус «идёт»', async () => {
    await home().getByRole('button', { name: 'Начать занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
    await stepLabel(1).waitFor();
    await w.page.goBack();
    await home().getByRole('button', { name: 'Продолжить занятие' }).waitFor();
    expect(await text(cell(today()))).toMatch(/идёт$/);
    await home().getByRole('button', { name: 'Продолжить занятие' }).click();
    await w.page.waitForURL(/screen=lesson/);
  });

  it('после занятия: готовность выросла по баллу, серия 1, день пройден, кнопки нет, прогноз по темпу', async () => {
    await passLesson();
    const [lesson] = w.stand.rows('SELECT * FROM lessons WHERE user_id = ?', userId(EMAIL));
    expect(lesson.status).toBe('finished');
    const gained = Math.round(2 * lesson.score / 100 * 10) / 10;
    const value = Math.round(BASE + gained);
    expect(value).toBeGreaterThan(BASE);
    await home().locator(`.level-badge[aria-label="Готовность ${value} из 100"]`).waitFor();

    const all = await text(home());
    expect(all).toContain(`База 53 — исходный срез 29 окт · занятия +${String(gained).replace('.', ',')} (1 занятие)`);
    const perDay = Math.round((value - BASE) / 7 * 10) / 10;
    const next = nextStep(value)!;
    expect(all).toContain(`До ${next.level} — ${next.points} балл`);
    expect(all).toContain(`при текущем темпе (+${String(perDay).replace('.', ',')} в день) — через `);
    expect(await text(fact('Серия'))).toMatch(/1 день.*сегодня засчитано/);
    expect(await text(cell(today()))).toContain(`пройдено · ${lesson.score}`);
    expect(await home().getByRole('button', { name: /занятие$/ }).count()).toBe(0);
    await shot(w.page, 'home-after');
  });

  it('минуты недели: шаг дороже десяти минут считается как десять, цель и полоса сходятся', async () => {
    const steps = w.stand.rows('SELECT id, answered_at AS a FROM lesson_steps WHERE answered_at IS NOT NULL ORDER BY position');
    expect(steps.length).toBe(8);
    steps.forEach((s, i) => {
      const minutes = i === 0 ? 60 : 3;
      w.stand.db.prepare('UPDATE lesson_steps SET created_at = ? WHERE id = ?').run(new Date(Date.parse(s.a) - minutes * 60_000).toISOString(), s.id);
    });
    await openHome();
    const goal = fact('Недельная цель');
    expect(await text(goal)).toContain('31 из 125 мин');
    expect(await goal.locator('.progress').getAttribute('aria-label')).toBe('Выполнено 25%');
    expect(await text(cell(today()))).toMatch(/ · 31 мин$/);

    await goal.getByRole('button', { name: 'изменить' }).click();
    await home().getByLabel('Минут в неделю').fill('30');
    await home().getByRole('button', { name: 'Сохранить' }).click();
    await goal.getByText('цель недели выполнена').waitFor();
    expect(await goal.locator('.progress').getAttribute('aria-label')).toBe('Выполнено 100%');
  });

  it('обратный отсчёт: через 10 дней с прогнозом к дате, завтра, сегодня, дата прошла', async () => {
    const setDate = (offset: number) => w.stand.db.prepare('UPDATE profiles SET interview_date = ? WHERE user_id = ?').run(addDays(today(), offset), userId(EMAIL));
    const value = Number((await badge().getAttribute('aria-label'))!.match(/\d+/)![0]);
    const perDay = Math.round((value - BASE) / 7 * 10) / 10;

    setDate(10);
    await openHome();
    expect(await text(fact('Собеседование'))).toContain('через 10 дней');
    expect(await text(home())).toContain(`к собеседованию при этом темпе — ${Math.round(value + perDay * 10)}`);
    setDate(1);
    await openHome();
    expect(await text(fact('Собеседование'))).toContain('завтра');
    setDate(0);
    await openHome();
    expect(await text(fact('Собеседование'))).toContain('сегодня');
    expect(await text(home())).not.toContain('к собеседованию при этом темпе');
    setDate(-1);
    await openHome();
    expect(await text(fact('Собеседование'))).toContain('дата прошла');
    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
  });
});

describe('пропуски и заморозка', () => {
  it('три пропущенных занятия: первое в неделе закрывает заморозка, остальные снижают готовность по баллу', async () => {
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
    expect(await text(home())).toMatch(new RegExp(`пропуски -${counted} \\(${counted} пропуск`));
    expect(await text(fact('Серия'))).toContain(s.freezeAvailable ? 'заморозка на эту неделю есть' : 'заморозка недели потрачена');
    // в полосе только текущая неделя: прошедшие её дни подписаны по итогу, будущий — план
    for (const d of pastDates.filter(x => x >= weekStart(today()))) {
      expect(await text(cell(d))).toMatch(s.frozen.includes(d) ? /заморозка$/ : /пропущено$/);
    }
    if (tomorrow < addDays(weekStart(today()), 7)) expect(await text(cell(tomorrow))).toMatch(/план$/);
    await shot(w.page, 'home-missed');
    await w.page.getByRole('button', { name: 'Выйти' }).click();
    await heading(w.page, 'Вход').waitFor();
  });
});

describe('пустое состояние', () => {
  it('без теста и программы: прочерк вместо балла, подсказка, никаких кнопок дня', async () => {
    await login(w.page, w.stand.url, EMPTY);
    await seed(w.stand, EMPTY, { program: false });
    const uid = userId(EMPTY);
    w.stand.db.prepare('DELETE FROM assessments WHERE user_id = ?').run(uid);
    await openHome();
    expect(await badge().getAttribute('aria-label')).toBe('Готовность не посчитана');
    expect(await text(badge())).toBe('—');
    const all = await text(home());
    expect(all).toContain('Готовность появится после теста уровня');
    expect(all).toContain('Программы ещё нет');
    expect(all).not.toContain('База ');
    expect(await home().locator('ol.week-strip > li.free').count()).toBe(7);
    expect(await home().getByRole('button', { name: /^(Начать|Продолжить)/ }).count()).toBe(0);
  });
});
