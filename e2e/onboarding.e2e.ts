/** Знакомство нового ученика в настоящем Chromium: резюме файлом (TXT, DOCX) и вставленным текстом, сбой и повтор
 *  разбора моделью, экран «Что я понял из резюме», анкета из шести вопросов, правка ответов и замена резюме.
 *  Профиль от «модели» — заготовка стенда (stand.ai.reply); проверяется, что сервер её нормализует и кладёт в SQL. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openWorld, closeWorld, login, text, heading, card, shot, EMAIL, type World } from './helpers';
import { makeDocx, SAMPLE_RESUME } from '../tests/helpers/fixtures';
import { addDays, todayIn } from '../functions/_lib/dates';

/** Начало системной подсказки разбора резюме (functions/_lib/profile.ts). */
const RESUME_PROMPT = "You read a candidate's résumé";
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PROFILE_DOCX = {
  specialty: 'инженер-теплоэнергетик', industry: 'энергетика', years: 15, target_role: 'эксперт по оценке ответов ИИ',
  keywords: ['boiler efficiency', 'energy audit', 'Energy Audit', 'heat loss calculation', 'feasibility study'],
  summary: 'Вы инженер-теплоэнергетик с пятнадцатью годами в генерации. Сильные стороны — энергоаудит и расчёты тепловых балансов.',
};
const PROFILE_TEXT = {
  specialty: 'энергоаудитор', industry: 'промышленность', years: 12, target_role: null,
  keywords: ['energy audit', 'heat balance', 'district heating'],
  summary: 'Вы энергоаудитор с двенадцатью годами опыта. Сильная сторона — обследования промышленных объектов.',
};

const PASTED = [
  'Energy auditor, Almaty. 12 years of energy audits of industrial sites and district heating networks.',
  'Prepared heat balance calculations, loss assessments and feasibility studies for modernization projects.',
  'Wrote technical reports for clients; reviewed contractor documentation; presented results to plant management.',
].join('\n');

let w: World;
let userId = '';
beforeAll(async () => { w = await openWorld(); });
afterAll(async () => { await closeWorld(w); });

const profileRow = () => w.stand.rows('SELECT * FROM profiles WHERE user_id = ?', userId)[0];
const resumeInput = () => w.page.locator('input[type=file]');

describe('резюме', () => {
  it('новый ученик видит экран резюме; слишком короткий TXT отклоняется понятной ошибкой без записи в базу', async () => {
    await login(w.page, w.stand.url);
    userId = String(w.stand.rows('SELECT id FROM users WHERE email = ?', EMAIL)[0].id);
    await heading(w.page, 'Резюме').waitFor();
    await w.page.getByRole('button', { name: 'Выбрать файл' }).waitFor();

    await resumeInput().setInputFiles({ name: 'cv.txt', mimeType: 'text/plain', buffer: Buffer.from('Thermal power engineer, 15 years.') });
    const alert = w.page.getByRole('alert');
    await alert.waitFor();
    expect(await text(alert)).toBe('Текста мало — меньше двухсот знаков. Нужно полное резюме, а не заголовок.');
    expect(profileRow()?.resumeText ?? null).toBeNull();
    expect(w.stand.ai.calls).toHaveLength(0);
    await heading(w.page, 'Резюме').waitFor();
  });

  it('DOCX читается, но модель недоступна: текст сохранён, карточка предлагает «Разобрать снова»', async () => {
    await resumeInput().setInputFiles({ name: 'resume.docx', mimeType: DOCX_MIME, buffer: Buffer.from(makeDocx(SAMPLE_RESUME)) });
    const profileCard = card(w.page, 'Что я понял из резюме');
    await profileCard.waitFor();
    expect(await text(profileCard)).toMatch(/профиль ещё не собран/);
    expect(await text(profileCard)).toMatch(/resume\.docx/);
    // причина сбоя не теряется при смене экрана — строка на карточке профиля
    const reason = profileCard.getByRole('alert');
    expect(await text(reason)).toMatch(/^Текст сохранён, но модель не смогла собрать профиль\. Нажмите «Разобрать снова»\./);
    await profileCard.getByRole('button', { name: 'Разобрать снова' }).waitFor();

    const row = profileRow();
    expect(row.resumeName).toBe('resume.docx');
    expect(String(row.resumeText)).toContain('Thermal Power Engineer');
    expect(String(row.resumeText)).toContain('energy audit');
    expect(row.specialty).toBeNull();
    // модель получила извлечённый текст, а не байты файла
    expect(w.stand.ai.calls).toHaveLength(1);
    expect(w.stand.ai.calls[0].system).toContain(RESUME_PROMPT);
    expect(w.stand.ai.calls[0].user).toContain('Thermal Power Engineer');
    expect(w.stand.ai.calls[0].answered).toBe(false);
  });

  it('повторный разбор: профиль нормализован (дубль термина убран) и сразу открывается анкета с целью из резюме', async () => {
    w.stand.ai.reply(RESUME_PROMPT, PROFILE_DOCX);
    await card(w.page, 'Что я понял из резюме').getByRole('button', { name: 'Разобрать снова' }).click();
    await heading(w.page, 'Шесть вопросов').waitFor();
    expect(w.stand.ai.pending()).toBe(0);

    const row = profileRow();
    expect(row.specialty).toBe('инженер-теплоэнергетик');
    expect(row.years).toBe(15);
    expect(JSON.parse(String(row.keywords))).toEqual(['boiler efficiency', 'energy audit', 'heat loss calculation', 'feasibility study']);
    expect(row.onboardedAt).toBeNull();

    const role = w.page.getByLabel('На какую позицию готовитесь');
    expect(await role.inputValue()).toBe('эксперт по оценке ответов ИИ');
    await w.page.getByText('Подставлено из резюме — поправьте, если цель другая.').waitFor();
    await shot(w.page, 'onboarding-questions');
  });
});

describe('анкета', () => {
  it('шесть ответов сохраняются по Ctrl+Enter: главный экран показывает «Подготовку» и профиль', async () => {
    const tz = 'Asia/Almaty';
    const date = addDays(todayIn(tz), 20);
    await w.page.getByLabel('На какую позицию готовитесь').fill('эксперт по оценке ответов ИИ в энергетике');
    await w.page.getByLabel('Дата собеседования').fill(date);
    await w.page.getByText('через 20 дней').waitFor();
    await w.page.getByRole('radio', { name: 'Видеозвонок' }).click();
    await w.page.getByRole('radio', { name: '30', exact: true }).click();
    expect(await w.page.getByRole('radio', { name: '30', exact: true }).getAttribute('aria-checked')).toBe('true');
    expect(await w.page.getByLabel('Часовой пояс').inputValue()).toBe(tz);
    await w.page.getByRole('combobox').nth(1).selectOption('казахский');

    await w.page.getByLabel('На какую позицию готовитесь').focus();
    await w.page.keyboard.press('Control+Enter');
    const answers = card(w.page, 'Подготовка');
    await answers.waitFor();

    const row = profileRow();
    expect(row.targetRole).toBe('эксперт по оценке ответов ИИ в энергетике');
    expect(row.interviewDate).toBe(date);
    expect(row.interviewFormat).toBe('video');
    expect(row.minutesPerDay).toBe(30);
    expect(row.nativeLanguage).toBe('казахский');
    expect(row.onboardedAt).not.toBeNull();
    expect(w.stand.rows('SELECT tz FROM users WHERE id = ?', userId)[0].tz).toBe(tz);

    const a = await text(answers);
    for (const s of ['эксперт по оценке ответов ИИ в энергетике', 'Видеозвонок', '30 минут', 'казахский', 'через 20 дней']) expect(a).toContain(s);
    const p = await text(card(w.page, 'Что я понял из резюме'));
    for (const s of ['инженер-теплоэнергетик', 'энергетика', '15 лет', 'boiler efficiency', 'Вы инженер-теплоэнергетик']) expect(p).toContain(s);
    // анкета больше не открывается сама и не предлагается кнопкой
    expect(await w.page.getByRole('button', { name: 'Дальше — шесть вопросов' }).count()).toBe(0);
    await shot(w.page, 'onboarding-home');
  });

  it('«Изменить ответы» открывает анкету с прежними ответами; Esc закрывает без изменений', async () => {
    await card(w.page, 'Подготовка').getByRole('button', { name: 'Изменить ответы' }).click();
    await heading(w.page, 'Анкета').waitFor();
    expect(await w.page.getByLabel('На какую позицию готовитесь').inputValue()).toBe('эксперт по оценке ответов ИИ в энергетике');
    expect(await w.page.getByRole('radio', { name: 'Видеозвонок' }).getAttribute('aria-checked')).toBe('true');
    await w.page.getByRole('button', { name: 'Сохранить' }).waitFor();
    await w.page.getByLabel('На какую позицию готовитесь').fill('другая цель');
    await w.page.keyboard.press('Escape');
    await card(w.page, 'Подготовка').waitFor();
    expect(profileRow().targetRole).toBe('эксперт по оценке ответов ИИ в энергетике');
  });
});

describe('замена резюме', () => {
  it('вставленный текст: счётчик знаков, новый профиль от модели, ответы анкеты остаются', async () => {
    await card(w.page, 'Что я понял из резюме').getByRole('button', { name: 'Загрузить другое резюме' }).click();
    await heading(w.page, 'Другое резюме').waitFor();
    await w.page.getByRole('button', { name: 'Вставить текст' }).click();
    const area = w.page.getByLabel('Текст резюме — с hh.ru, LinkedIn или из документа');
    await area.fill('Energy auditor.');
    const submit = w.page.getByRole('button', { name: 'Разобрать' });
    expect(await submit.isDisabled()).toBe(true);
    await w.page.getByText(/^Ещё хотя бы \d+ знаков$/).waitFor();

    await area.fill(PASTED);
    await w.page.getByText(`${PASTED.length} знаков`).waitFor();
    w.stand.ai.reply(RESUME_PROMPT, PROFILE_TEXT);
    await submit.click();
    const profileCard = card(w.page, 'Что я понял из резюме');
    await profileCard.getByText('энергоаудитор', { exact: true }).waitFor();
    expect(await text(profileCard)).toContain('вставленный текст');
    expect(await text(profileCard)).toContain('12 лет');

    const row = profileRow();
    expect(row.resumeName).toBe('текст');
    expect(String(row.resumeText)).toContain('Energy auditor, Almaty');
    expect(row.specialty).toBe('энергоаудитор');
    // анкетные поля не сбрасываются новым резюме; цель анкеты не затирается target_role: null от модели
    expect(row.targetRole).toBe('эксперт по оценке ответов ИИ в энергетике');
    expect(row.interviewFormat).toBe('video');
    expect(row.minutesPerDay).toBe(30);
    expect(row.nativeLanguage).toBe('казахский');
    await card(w.page, 'Подготовка').waitFor();
  });

  it('«Оставить текущее резюме» (Esc) возвращает на главный без нового разбора', async () => {
    const calls = w.stand.ai.calls.length;
    await card(w.page, 'Что я понял из резюме').getByRole('button', { name: 'Загрузить другое резюме' }).click();
    await heading(w.page, 'Другое резюме').waitFor();
    await w.page.keyboard.press('Escape');
    await card(w.page, 'Что я понял из резюме').getByText('энергоаудитор', { exact: true }).waitFor();
    expect(w.stand.ai.calls.length).toBe(calls);
  });
});
