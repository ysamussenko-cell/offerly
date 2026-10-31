/** Учётная запись первого пользователя (Юрий) — начальные данные из концепта (docs/concept.md, §9):
 *  профиль, исходный срез 29.10.2026 и стартовые карточки журнала ошибок. Модуль порождает идемпотентный SQL
 *  (seed/first_user.sql, применяется шагом workflow после миграций): пользователь и профиль создаются, если их нет,
 *  в существующем профиле заполняются только пустые поля; срез и карточки вставляются по фиксированным id один раз.
 *  Ничего существующего seed не перезаписывает и не удаляет.
 *  Оси среза считаются теми же правилами, что и тест уровня (scoring.ts): результаты уроков переводятся
 *  в синтетические попытки, письмо B1–B2 — в оценку на границе ступеней, затем computeAxes. */
import { computeAxes, type Scored, type WritingEval } from './scoring';
import type { Attempt } from './types';
import type { Item, Kind, Level } from './items';
import { cardTopicById } from './cards';

export const SEED_DATE = '2026-10-30';
export const SEED_SOURCE = 'seed';

export const FIRST_USER = {
  email: 'ysamussenko@gmail.com',
  name: 'Юрий Самусенко',
  locale: 'ru',
  tz: 'Asia/Almaty',
  /** Id пользователя — только если учётной записи с этой почтой ещё нет; иначе данные привязываются к существующей. */
  id: 'u-first-yuriy',
  profile: {
    specialty: 'инженер-теплоэнергетик',
    industry: 'энергетика',
    years: 15,
    targetRole: 'Отбор на OpenTrain AI: письменный разбор ответов ИИ и ИИ-интервью на английском',
    keywords: ['thermal power engineering', 'boilers', 'steam turbines', 'energy audit', 'evaluation of AI answers', 'reviewer feedback'],
    summary: 'Вы инженер-теплоэнергетик с пятнадцатилетним стажем: котлы и турбины, энергоаудит. Цель — отбор на OpenTrain AI: письменный разбор ответов ИИ и ИИ-интервью на английском. Целевой уровень — C1.',
    interviewDate: null as string | null,
    interviewFormat: 'ai',
    minutesPerDay: 25,
    nativeLanguage: 'русский',
    targetLevel: 'C1' as Level,
    notifyAt: '07:41',
  },
};

/** Исходный срез 29.10.2026 — проведён вне приложения, в ежедневных уроках (концепт §9). */
export const BASELINE = {
  id: 'seed-baseline-2026-10-29',
  date: '2026-10-29',
  startedAt: '2026-10-29T03:00:00.000Z',
  /** Уровень заданий уроков: программа ведёт от B1–B2 к C1, задания давались ступенью выше текущего уровня. */
  taskLevel: 'B2' as Level,
  /** Грамматика в контексте. */
  grammar: { correct: 3, total: 10 },
  /** Исправление ошибок. */
  correction: { correct: 0, total: 5 },
  /** Чтение B2, подтекст частично — один вопрос из двух. */
  reading: { level: 'B2' as Level, score: 50 },
  /** Письмо B1–B2 — граница ступеней по всем четырём осям письма. */
  writing: { level: 'B1' as Level, score: 50 },
  note: 'Исходный срез 29.10.2026 проведён вне приложения, в ежедневных уроках: грамматика в контексте 3 из 10, исправление ошибок 0 из 5, чтение B2 — подтекст частично, письмо B1–B2 (точность B1+). Оси посчитаны по правилам теста уровня.',
};

/** Оси и уровень среза по правилам теста: синтетические попытки на уровне заданий уроков, чтение долей ступени,
 *  письмо — оценка на границе B1/B2. */
export function baselineScore(): Scored {
  const items = new Map<string, Item>();
  const attempts: Attempt[] = [];
  const stub = (id: string, kind: Kind, level: Level): Item => ({
    id, kind, level, topic: 'tenses', domain: null, prompt: '', options: null, answer: '', rubric: null, explanation: null,
    status: 'verified', checkNote: null, checkedLevel: null, fingerprint: id, source: SEED_SOURCE, writingFormat: null, createdAt: BASELINE.startedAt, verifiedAt: null,
  });
  const push = (kind: Kind, level: Level, correct: number | null, score: number | null) => {
    const position = attempts.length + 1, id = `baseline-${position}`;
    items.set(id, stub(id, kind, level));
    attempts.push({ id, userId: FIRST_USER.id, assessmentId: BASELINE.id, itemId: id, position, level, answer: null, correct, score, feedback: null, detail: null, createdAt: BASELINE.startedAt, answeredAt: BASELINE.startedAt });
  };
  for (let i = 0; i < BASELINE.grammar.total; i++) push('mcq', BASELINE.taskLevel, i < BASELINE.grammar.correct ? 1 : 0, i < BASELINE.grammar.correct ? 100 : 0);
  for (let i = 0; i < BASELINE.correction.total; i++) push('correction', BASELINE.taskLevel, i < BASELINE.correction.correct ? 1 : 0, i < BASELINE.correction.correct ? 100 : 0);
  const adaptive = attempts.length;
  push('reading', BASELINE.reading.level, BASELINE.reading.score === 100 ? 1 : 0, BASELINE.reading.score);
  const s = BASELINE.writing.score;
  const writing: WritingEval = { axes: { grammar: s, vocabulary: s, coherence: s, taskResponse: s }, level: BASELINE.writing.level, summary: '', errors: [], rewrite: null, model: SEED_SOURCE, evaluatedAt: BASELINE.startedAt };
  return computeAxes(attempts, items, writing, adaptive);
}

export interface SeedCard { topic: string; rule: string; example: string; correction: string }

/** Стартовые карточки журнала ошибок — список из концепта §9; примеры в домене пользователя. */
export const CARDS: SeedCard[] = [
  { topic: 'conjunctions', rule: 'Инверсия после not until, rarely, only then: вспомогательный глагол перед подлежащим.', example: 'Not until the boiler was shut down we found the leak.', correction: 'Not until the boiler was shut down did we find the leak.' },
  { topic: 'conjunctions', rule: 'Despite + существительное или герундий, не придаточное: despite the delay / despite being late, а с придаточным — although.', example: 'Despite the audit was short, we found the main losses.', correction: 'Despite the short audit, we found the main losses.' },
  { topic: 'quantifiers', rule: 'Neither of / none of + существительное во множественном числе — глагол в единственном (формальный регистр).', example: 'Neither of the two pumps were working, and none of the valves were replaced.', correction: 'Neither of the two pumps was working, and none of the valves was replaced.' },
  { topic: 'relative', rule: 'Whose — принадлежность, в том числе у предметов и организаций: the plant whose boiler…', example: 'The plant, which boiler was replaced in 2019, still loses heat.', correction: 'The plant, whose boiler was replaced in 2019, still loses heat.' },
  { topic: 'vocabulary', rule: 'Устойчивое сочетание make a case for — обосновать, привести доводы.', example: 'The report does a case for insulating the pipeline.', correction: 'The report makes a case for insulating the pipeline.' },
  { topic: 'register', rule: 'Степень ошибки в отзыве называть точно: subtly wrong — ошибка тонкая, не «a little bit wrong».', example: 'The answer is a little bit wrong about the efficiency.', correction: 'The answer is subtly wrong about the efficiency.' },
  { topic: 'quantifiers', rule: 'Fewer — с исчисляемыми (fewer boilers), less — с неисчисляемыми (less steam).', example: 'Less boilers were inspected this year.', correction: 'Fewer boilers were inspected this year.' },
  { topic: 'verb-patterns', rule: 'Suggest + герундий или that-clause, не инфинитив: suggest replacing / suggest that we replace.', example: 'I suggest to replace the burner before winter.', correction: 'I suggest replacing the burner before winter.' },
  { topic: 'conditionals', rule: 'Третий кондиционал о прошлом: if + had + V3, would have + V3.', example: 'If we checked the insulation in spring, we would avoid the loss.', correction: 'If we had checked the insulation in spring, we would have avoided the loss.' },
  { topic: 'articles', rule: 'Определённый артикль с конкретным, уже названным объектом: the efficiency of the boiler.', example: 'Efficiency of boiler was 89 percent after the overhaul.', correction: 'The efficiency of the boiler was 89 percent after the overhaul.' },
  { topic: 'tenses', rule: 'С указанием прошедшего момента (yesterday, in 2019) — past simple, не present perfect.', example: 'We have measured the flue gas temperature yesterday.', correction: 'We measured the flue gas temperature yesterday.' },
  { topic: 'register', rule: 'Формальный регистр отзыва: назвать недостаток и его место, без оценок-эмоций.', example: 'The model got it totally wrong, big time.', correction: 'The answer is incorrect in two respects: the stated efficiency exceeds the theoretical limit, and the fuel flow is not given.' },
  { topic: 'spelling', rule: 'Орфография терминов: insulation, warm, kW·h.', example: 'The insolation keeps the water worm, and the losses are 120 kwh a day.', correction: 'The insulation keeps the water warm, and the losses are 120 kW·h a day.' },
  { topic: 'task-response', rule: 'Сначала ответить ровно на поставленный вопрос, потом добавлять контекст.', example: 'Asked for two causes of the efficiency drop: "The drop is a serious problem for the whole plant."', correction: 'The two causes are fouling of the heating surfaces and excess combustion air.' },
];

// ---------- SQL ----------

const q = (v: string | number | null | undefined) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;
const stamp = (d: string) => `${d}T00:00:00.000Z`;

/** Идемпотентные SQL-операторы seed. Пользователь ищется по почте, поэтому данные ложатся и на уже созданную
 *  при входе учётную запись. В профиле заполняются только пустые поля (COALESCE); срез и карточки — INSERT OR IGNORE по id. */
export function seedStatements(date = SEED_DATE): string[] {
  const u = FIRST_USER, p = u.profile, now = stamp(date);
  const byEmail = `FROM users WHERE email = ${q(u.email)}`;
  const s = baselineScore();
  const axes = s.axes;
  const out: string[] = [];
  out.push(`INSERT OR IGNORE INTO users (id, email, name, locale, tz, created_at) VALUES (${q(u.id)}, ${q(u.email)}, ${q(u.name)}, ${q(u.locale)}, ${q(u.tz)}, ${q(now)})`);
  out.push(`UPDATE users SET name = COALESCE(name, ${q(u.name)}) WHERE email = ${q(u.email)}`);
  const cols: [string, string | number | null][] = [
    ['specialty', p.specialty], ['industry', p.industry], ['years', p.years], ['target_role', p.targetRole], ['interview_date', p.interviewDate],
    ['interview_format', p.interviewFormat], ['minutes_per_day', p.minutesPerDay], ['keywords', JSON.stringify(p.keywords)], ['summary', p.summary],
    ['native_language', p.nativeLanguage], ['onboarded_at', now], ['target_level', p.targetLevel], ['notify_at', p.notifyAt],
  ];
  const fill = (c: string) => c === 'keywords'
    ? `keywords = CASE WHEN profiles.keywords IS NULL OR profiles.keywords IN ('', '[]') THEN excluded.keywords ELSE profiles.keywords END`
    : `${c} = COALESCE(profiles.${c}, excluded.${c})`;
  out.push(
    `INSERT INTO profiles (user_id, ${cols.map(c => c[0]).join(', ')}, updated_at)\n` +
    `SELECT id, ${cols.map(c => q(c[1])).join(', ')}, ${q(now)} ${byEmail}\n` +
    `ON CONFLICT(user_id) DO UPDATE SET ${cols.map(c => fill(c[0])).join(', ')}, ` +
    `updated_at = CASE WHEN profiles.updated_at > excluded.updated_at THEN profiles.updated_at ELSE excluded.updated_at END`,
  );
  out.push(
    `INSERT OR IGNORE INTO assessments (id, user_id, kind, status, started_at, finished_at, level, current_level, updated_at, grammar, vocabulary, coherence, task_response, fluency, overall, scored_at, scoring_note)\n` +
    `SELECT ${q(BASELINE.id)}, id, 'baseline', 'finished', ${q(BASELINE.startedAt)}, ${q(BASELINE.startedAt)}, ${q(s.level)}, ${q(s.level)}, ${q(BASELINE.startedAt)}, ` +
    `${q(axes.grammar)}, ${q(axes.vocabulary)}, ${q(axes.coherence)}, ${q(axes.taskResponse)}, ${q(axes.fluency)}, ${q(s.overall)}, ${q(BASELINE.startedAt)}, ${q(BASELINE.note)} ${byEmail}`,
  );
  CARDS.forEach((c, i) => {
    const id = `seed-card-${String(i + 1).padStart(2, '0')}`;
    out.push(
      `INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)\n` +
      `SELECT ${q(id)}, id, ${q(c.topic)}, ${q(c.rule)}, ${q(c.example)}, ${q(c.correction)}, ${q(SEED_SOURCE)}, 1, 5, ${q(date)}, 0, 0, 0, ${q(now)} ${byEmail}`,
    );
  });
  return out;
}

/** Текст seed/first_user.sql — проверяется тестом на совпадение с модулем (vitest -u перезаписывает). */
export function renderSeedSql(date = SEED_DATE): string {
  const s = baselineScore();
  const head = [
    '-- Offerly: учётная запись первого пользователя — профиль, исходный срез 29.10.2026, стартовые карточки ошибок.',
    '-- Файл порождён functions/_lib/seed.ts (npx vitest run tests/seed.test.ts -u); править руками не нужно.',
    '-- Идемпотентно: существующие данные не перезаписываются, применяется шагом workflow после миграций.',
    `-- Срез: уровень ${s.level}, сводный балл ${s.overall}; оси — грамматика ${s.axes.grammar}, словарь ${s.axes.vocabulary}, связность ${s.axes.coherence}, ответ на вопрос ${s.axes.taskResponse}, беглость речи не оценивалась.`,
  ];
  return head.join('\n') + '\n\n' + seedStatements(date).join(';\n\n') + ';\n';
}

/** Проверка данных seed: темы карточек известны, примеры отличаются от исправлений. Возвращает список проблем. */
export function validateSeed(): string[] {
  const problems: string[] = [];
  CARDS.forEach((c, i) => {
    if (!cardTopicById(c.topic)) problems.push(`карточка ${i + 1}: неизвестная тема ${c.topic}`);
    if (!c.rule.trim() || !c.example.trim() || !c.correction.trim()) problems.push(`карточка ${i + 1}: пустое поле`);
    if (c.example.trim() === c.correction.trim()) problems.push(`карточка ${i + 1}: пример совпадает с исправлением`);
    if (/;/.test(c.rule + c.example + c.correction)) problems.push(`карточка ${i + 1}: точка с запятой в тексте мешает разбору SQL-файла`);
  });
  return problems;
}
