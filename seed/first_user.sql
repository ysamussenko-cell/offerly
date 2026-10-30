-- Offerly: учётная запись первого пользователя — профиль, исходный срез 29.10.2026, стартовые карточки ошибок.
-- Файл порождён functions/_lib/seed.ts (npx vitest run tests/seed.test.ts -u); править руками не нужно.
-- Идемпотентно: существующие данные не перезаписываются, применяется шагом workflow после миграций.
-- Срез: уровень B1, сводный балл 53; оси — грамматика 54, словарь 50, связность 54, ответ на вопрос 53, беглость речи не оценивалась.

INSERT OR IGNORE INTO users (id, email, name, locale, tz, created_at) VALUES ('u-first-yuriy', 'ysamussenko@gmail.com', 'Юрий Самусенко', 'ru', 'Asia/Almaty', '2026-10-30T00:00:00.000Z');

UPDATE users SET name = COALESCE(name, 'Юрий Самусенко') WHERE email = 'ysamussenko@gmail.com';

INSERT INTO profiles (user_id, specialty, industry, years, target_role, interview_date, interview_format, minutes_per_day, keywords, summary, native_language, onboarded_at, target_level, notify_at, updated_at)
SELECT id, 'инженер-теплоэнергетик', 'энергетика', 15, 'Отбор на OpenTrain AI: письменный разбор ответов ИИ и ИИ-интервью на английском', NULL, 'ai', 25, '["thermal power engineering","boilers","steam turbines","energy audit","evaluation of AI answers","reviewer feedback"]', 'Вы инженер-теплоэнергетик с пятнадцатилетним стажем: котлы и турбины, энергоаудит. Цель — отбор на OpenTrain AI: письменный разбор ответов ИИ и ИИ-интервью на английском. Целевой уровень — C1.', 'русский', '2026-10-30T00:00:00.000Z', 'C1', '07:41', '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com'
ON CONFLICT(user_id) DO UPDATE SET specialty = COALESCE(profiles.specialty, excluded.specialty), industry = COALESCE(profiles.industry, excluded.industry), years = COALESCE(profiles.years, excluded.years), target_role = COALESCE(profiles.target_role, excluded.target_role), interview_date = COALESCE(profiles.interview_date, excluded.interview_date), interview_format = COALESCE(profiles.interview_format, excluded.interview_format), minutes_per_day = COALESCE(profiles.minutes_per_day, excluded.minutes_per_day), keywords = CASE WHEN profiles.keywords IS NULL OR profiles.keywords IN ('', '[]') THEN excluded.keywords ELSE profiles.keywords END, summary = COALESCE(profiles.summary, excluded.summary), native_language = COALESCE(profiles.native_language, excluded.native_language), onboarded_at = COALESCE(profiles.onboarded_at, excluded.onboarded_at), target_level = COALESCE(profiles.target_level, excluded.target_level), notify_at = COALESCE(profiles.notify_at, excluded.notify_at), updated_at = CASE WHEN profiles.updated_at > excluded.updated_at THEN profiles.updated_at ELSE excluded.updated_at END;

INSERT OR IGNORE INTO assessments (id, user_id, kind, status, started_at, finished_at, level, current_level, updated_at, grammar, vocabulary, coherence, task_response, fluency, overall, scored_at, scoring_note)
SELECT 'seed-baseline-2026-10-29', id, 'baseline', 'finished', '2026-10-29T03:00:00.000Z', '2026-10-29T03:00:00.000Z', 'B1', 'B1', '2026-10-29T03:00:00.000Z', 54, 50, 54, 53, NULL, 53, '2026-10-29T03:00:00.000Z', 'Исходный срез 29.10.2026 проведён вне приложения, в ежедневных уроках: грамматика в контексте 3 из 10, исправление ошибок 0 из 5, чтение B2 — подтекст частично, письмо B1–B2 (точность B1+). Оси посчитаны по правилам теста уровня.' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-01', id, 'conjunctions', 'Инверсия после not until, rarely, only then: вспомогательный глагол перед подлежащим.', 'Not until the boiler was shut down we found the leak.', 'Not until the boiler was shut down did we find the leak.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-02', id, 'conjunctions', 'Despite + существительное или герундий, не придаточное: despite the delay / despite being late, а с придаточным — although.', 'Despite the audit was short, we found the main losses.', 'Despite the short audit, we found the main losses.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-03', id, 'quantifiers', 'Neither of / none of + существительное во множественном числе — глагол в единственном (формальный регистр).', 'Neither of the two pumps were working, and none of the valves were replaced.', 'Neither of the two pumps was working, and none of the valves was replaced.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-04', id, 'relative', 'Whose — принадлежность, в том числе у предметов и организаций: the plant whose boiler…', 'The plant, which boiler was replaced in 2019, still loses heat.', 'The plant, whose boiler was replaced in 2019, still loses heat.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-05', id, 'vocabulary', 'Устойчивое сочетание make a case for — обосновать, привести доводы.', 'The report does a case for insulating the pipeline.', 'The report makes a case for insulating the pipeline.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-06', id, 'register', 'Степень ошибки в отзыве называть точно: subtly wrong — ошибка тонкая, не «a little bit wrong».', 'The answer is a little bit wrong about the efficiency.', 'The answer is subtly wrong about the efficiency.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-07', id, 'quantifiers', 'Fewer — с исчисляемыми (fewer boilers), less — с неисчисляемыми (less steam).', 'Less boilers were inspected this year.', 'Fewer boilers were inspected this year.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-08', id, 'verb-patterns', 'Suggest + герундий или that-clause, не инфинитив: suggest replacing / suggest that we replace.', 'I suggest to replace the burner before winter.', 'I suggest replacing the burner before winter.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-09', id, 'conditionals', 'Третий кондиционал о прошлом: if + had + V3, would have + V3.', 'If we checked the insulation in spring, we would avoid the loss.', 'If we had checked the insulation in spring, we would have avoided the loss.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-10', id, 'articles', 'Определённый артикль с конкретным, уже названным объектом: the efficiency of the boiler.', 'Efficiency of boiler was 89 percent after the overhaul.', 'The efficiency of the boiler was 89 percent after the overhaul.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-11', id, 'tenses', 'С указанием прошедшего момента (yesterday, in 2019) — past simple, не present perfect.', 'We have measured the flue gas temperature yesterday.', 'We measured the flue gas temperature yesterday.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-12', id, 'register', 'Формальный регистр отзыва: назвать недостаток и его место, без оценок-эмоций.', 'The model got it totally wrong, big time.', 'The answer is incorrect in two respects: the stated efficiency exceeds the theoretical limit, and the fuel flow is not given.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-13', id, 'spelling', 'Орфография терминов: insulation, warm, kW·h.', 'The insolation keeps the water worm, and the losses are 120 kwh a day.', 'The insulation keeps the water warm, and the losses are 120 kW·h a day.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';

INSERT OR IGNORE INTO error_cards (id, user_id, topic, rule, example, correction, source, stability, difficulty, due, reps, lapses, retired, created_at)
SELECT 'seed-card-14', id, 'task-response', 'Сначала ответить ровно на поставленный вопрос, потом добавлять контекст.', 'Asked for two causes of the efficiency drop: "The drop is a serious problem for the whole plant."', 'The two causes are fouling of the heating surfaces and excess combustion air.', 'seed', 1, 5, '2026-10-30', 0, 0, 0, '2026-10-30T00:00:00.000Z' FROM users WHERE email = 'ysamussenko@gmail.com';
