/** Засев стенда e2e для вошедшего пользователя: разобранное резюме, анкета, исходный срез B1,
 *  банк принятых заданий (без модели — задания детерминированные: выбор, исправление, чтение, письмо), две карточки
 *  к повтору и день программы на сегодня в поясе пользователя (по умолчанию «занятие»). Данные учебные, помечены source 'e2e'. */
import type { memoryStore } from '../tests/helpers/memoryStore';
import type { Item, Kind, Level } from '../functions/_lib/items';
import type { Assessment } from '../functions/_lib/assessment';
import type { ErrorCard } from '../functions/_lib/cards';
import type { DayFormat, ProgramDay } from '../functions/_lib/program';
import { todayIn } from '../functions/_lib/dates';

export interface SeedOptions {
  email: string;
  /** Тема дня программы; по умолчанию союзы и инверсия. */
  topic?: string;
  /** Часовой пояс анкеты — он же пояс «сегодня» для дня программы. */
  tz?: string;
  /** Формат дня программы на сегодня: занятие (по умолчанию), репетиция или срез. */
  format?: DayFormat;
  /** false — без дня программы: программу ученик составляет сам на экране. */
  program?: boolean;
}

export const SEED_TOPICS = ['conjunctions', 'articles', 'tenses', 'prepositions'] as const;
export const SEED_LEVELS: Level[] = ['A2', 'B1', 'B2', 'C1'];
const MCQ_PER_CELL = 3;
const CORRECTION_PER_CELL = 2;
const READING_PER_LEVEL = 2;
const SAMPLE = Array.from({ length: 8 }, () => 'The boiler efficiency test shows a small loss.').join(' ');

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

const PASSAGE = 'Following the retrofit, the plant reported that boiler efficiency fell from 91 to 88 percent over the winter. The contractor attributes the drop to wet coal, but the operators note that the new burners were never tuned after installation.';

/** Задание с заведомо известным ключом: у выбора варианта верный ответ всегда C, у исправления — глагол в третьем лице,
 *  у чтения — B и C. */
export function seedItem(kind: Kind, level: Level, topic: string, now: string, over: Partial<Item> = {}): Item {
  const n = ++seq;
  const base = {
    id: `e2e-${kind}-${n}`, kind, level, topic, domain: null, rubric: null, explanation: 'Правило одной строкой: проверьте форму по эталону.',
    status: 'verified' as const, checkNote: null, checkedLevel: level, fingerprint: `e2e-fp-${n}`, source: 'e2e', writingFormat: null, createdAt: now, verifiedAt: now,
  };
  if (kind === 'mcq') return { ...base, prompt: `We finished ___ energy audit number ${n} last week.`, options: ['a', 'an', 'the', '—'], answer: 'C', ...over };
  if (kind === 'reading') return { ...base, prompt: `${PASSAGE} (Report ${n}.)`, options: [
    { question: 'What does the report say about efficiency?', options: ['It rose', 'It fell', 'It did not change', 'It was not measured'], answer: 'B' },
    { question: 'What do the operators imply?', options: ['The coal was dry', 'The contractor is right', 'The burners need tuning', 'The retrofit was cancelled'], answer: 'C' },
  ], answer: 'B,C', ...over };
  if (kind === 'correction') return { ...base, prompt: `The turbine have been inspected ${n} times since the overhaul.`, options: null, answer: `The turbine has been inspected ${n} times since the overhaul.`, ...over };
  return { ...base, prompt: `Write a short review of calculation ${n} for its author in 60–80 words.`, options: null, rubric: ['Отвечает прямо', 'Объясняет метод', 'Нейтральный тон'], answer: SAMPLE, writingFormat: 'review', ...over };
}

export function seedBank(now: string): Item[] {
  const out: Item[] = [];
  for (const topic of SEED_TOPICS) for (const level of SEED_LEVELS) {
    for (let i = 0; i < MCQ_PER_CELL; i++) out.push(seedItem('mcq', level, topic, now));
    for (let i = 0; i < CORRECTION_PER_CELL; i++) out.push(seedItem('correction', level, topic, now));
  }
  for (const level of SEED_LEVELS) for (let i = 0; i < READING_PER_LEVEL; i++) out.push(seedItem('reading', level, 'register', now));
  for (const level of SEED_LEVELS) { out.push(seedItem('writing', level, 'register', now)); out.push(seedItem('writing', level, 'register', now, { writingFormat: 'explain' })); }
  return out;
}

export async function seedUser(memory: ReturnType<typeof memoryStore>, opts: SeedOptions) {
  const email = opts.email.trim().toLowerCase();
  const user = memory.users.find(u => u.email === email);
  if (!user) return null;
  const tz = opts.tz ?? 'Asia/Almaty';
  const topic = opts.topic ?? 'conjunctions';
  const now = new Date().toISOString();
  const today = todayIn(tz, new Date(now));
  const yesterday = todayIn(tz, new Date(Date.parse(now) - 86_400_000));
  const { store } = memory;

  await store.saveAnalysis(user.id, {
    specialty: 'Теплоэнергетика', industry: 'Энергетика', years: 15, targetRole: 'Reviewer of AI model answers',
    keywords: ['boiler efficiency', 'steam turbine', 'energy audit', 'heat balance'],
    summary: 'Инженер-теплоэнергетик с опытом энергоаудитов; готовится к собеседованию на позицию рецензента ответов моделей.',
  }, now);
  await store.saveAnswers(user.id, { targetRole: 'Reviewer of AI model answers', interviewDate: null, interviewFormat: 'video', minutesPerDay: 25, tz, nativeLanguage: 'ru' }, now);

  const baseline: Assessment = {
    id: nextId('e2e-baseline'), userId: user.id, kind: 'baseline', status: 'finished', startedAt: '2026-10-29T03:00:00.000Z', finishedAt: '2026-10-29T03:00:00.000Z',
    level: 'B1', currentLevel: 'B1', updatedAt: now, axes: { grammar: 54, vocabulary: 50, coherence: 54, taskResponse: 53, fluency: null }, overall: 53, scoredAt: now, scoringNote: null, adaptiveCount: 12, programDayId: null,
  };
  await store.createAssessment(baseline);

  const items = seedBank(now);
  await store.insertItems(items);

  const cards: ErrorCard[] = [1, 2].map(i => ({
    id: nextId('e2e-card'), userId: user.id, topic: 'tenses', rule: 'Завершённое действие с указанием времени — Past Simple.',
    example: `We have installed ${i} boilers in 2020 at the plant.`, correction: `We installed ${i} boilers in 2020 at the plant.`, source: 'e2e', origin: null,
    stability: 1, difficulty: 5, due: yesterday, reps: 0, lapses: 0, streak: 0, reviewedAt: null, retired: false, createdAt: now,
  }));
  const cardsAdded = await store.insertCards(cards);

  const day: ProgramDay = {
    id: nextId('e2e-day'), userId: user.id, dayDate: today, position: 1, week: 1, format: opts.format ?? 'lesson', topic: opts.format === 'checkpoint' ? 'mixed' : topic, writing: opts.format && opts.format !== 'lesson' ? null : 'review',
    reason: opts.format === 'checkpoint' ? 'укороченный тест стенда e2e' : 'Стартовая тема стенда e2e', status: 'planned', minutes: 25, score: null, completedAt: null, generatedAt: now, updatedAt: null,
  };
  if (opts.program !== false) await store.replacePlannedDays(user.id, today, [day]);

  return { userId: user.id, today, items: items.length, cards: cardsAdded, topic };
}
