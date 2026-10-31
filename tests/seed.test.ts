import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { BASELINE, CARDS, FIRST_USER, baselineScore, renderSeedSql, seedStatements, validateSeed } from '../functions/_lib/seed';
import { scoreToLevel, LEVEL_THRESHOLD, BAND } from '../functions/_lib/scoring';
import { cardTopicById } from '../functions/_lib/cards';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';

// node:sqlite — встроенный модуль Node 22, но Vite его не знает как builtin; берём напрямую у процесса.
const { DatabaseSync: Sqlite } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** База в памяти с полным набором миграций — как D1 после `wrangler d1 migrations apply`. */
function freshDb(): DatabaseSync {
  const db: DatabaseSync = new Sqlite(':memory:');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${f}`, 'utf-8'));
  return db;
}
const applySeed = (db: DatabaseSync) => { for (const s of seedStatements()) db.exec(s); };
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as any).n);

describe('seed первого пользователя — данные', () => {
  it('карточки: темы известны, поля заполнены, пример отличается от исправления', () => {
    expect(validateSeed()).toEqual([]);
    expect(CARDS.length).toBeGreaterThanOrEqual(13);
    for (const c of CARDS) expect(cardTopicById(c.topic)?.label).toBeTruthy();
    // список концепта §9 покрыт
    for (const must of ['Инверсия', 'Despite', 'Neither of', 'Whose', 'make a case', 'subtly wrong', 'Fewer', 'Suggest', 'Третий кондиционал', 'артикль', 'past simple', 'регистр', 'insulation', 'на поставленный вопрос']) {
      expect(CARDS.some(c => c.rule.toLowerCase().includes(must.toLowerCase())), must).toBe(true);
    }
  });

  it('срез 29.10.2026 считается правилами теста: уровень B1, балл в полосе B1–B2, беглость речи не оценена', () => {
    const s = baselineScore();
    expect(s.level).toBe('B1');
    expect(scoreToLevel(s.overall)).toBe('B1');
    // «письмо B1–B2, точность B1+»: сводный балл выше низа B1, но ниже порога B2
    expect(s.overall).toBeGreaterThan(BAND + LEVEL_THRESHOLD);
    expect(s.overall).toBeLessThan(2 * BAND + LEVEL_THRESHOLD);
    expect(s.axes.fluency).toBeNull();
    expect(s.axes.grammar).toBeGreaterThan(BAND); // точность выше A2
    expect(s.axes.coherence).toBeGreaterThanOrEqual(2 * BAND); // чтение B2 тянет связность к границе B2
    expect(baselineScore()).toEqual(s); // детерминированно
  });

  it('SQL-файл seed/first_user.sql совпадает с модулем (обновление: npx vitest run tests/seed.test.ts -u)', async () => {
    await expect(renderSeedSql()).toMatchFileSnapshot('../seed/first_user.sql');
    const sql = renderSeedSql();
    expect(sql).not.toMatch(/__D1_ID__|undefined/);
    expect(sql.split(';\n').length).toBe(seedStatements().length + 1);
  });
});

describe('seed первого пользователя — применение к базе', () => {
  it('на пустой базе создаёт пользователя, профиль, срез и карточки; повторный прогон ничего не добавляет', () => {
    const db = freshDb();
    applySeed(db);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(FIRST_USER.email) as any;
    expect(u.id).toBe(FIRST_USER.id);
    expect(u.name).toBe(FIRST_USER.name);
    expect(u.tz).toBe('Asia/Almaty');
    const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(u.id) as any;
    expect(p.specialty).toBe('инженер-теплоэнергетик');
    expect(p.years).toBe(15);
    expect(JSON.parse(p.keywords)).toContain('energy audit');
    expect(p.onboarded_at).toBeTruthy();
    expect(p.target_level).toBe('C1');
    expect(p.notify_at).toBe('07:41');
    const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(BASELINE.id) as any;
    expect(a.user_id).toBe(u.id);
    expect(a.kind).toBe('baseline');
    expect(a.status).toBe('finished');
    expect(a.level).toBe('B1');
    expect(a.fluency).toBeNull();
    expect(a.scored_at).toBeTruthy();
    expect(a.scoring_note).toContain('29.10.2026');
    expect(count(db, "SELECT count(*) AS n FROM error_cards WHERE source = 'seed'")).toBe(CARDS.length);
    expect(count(db, `SELECT count(*) AS n FROM error_cards WHERE due = '${'2026-10-30'}' AND reps = 0 AND retired = 0`)).toBe(CARDS.length);

    applySeed(db);
    expect(count(db, 'SELECT count(*) AS n FROM users')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM profiles')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM assessments')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM error_cards')).toBe(CARDS.length);
  });

  it('у уже вошедшего пользователя данные привязываются к его id, заполненные поля профиля не трогаются', () => {
    const db = freshDb();
    db.prepare('INSERT INTO users (id, email, name, locale, tz) VALUES (?, ?, ?, ?, ?)').run('real-id', FIRST_USER.email, null, 'ru', 'Europe/Moscow');
    db.prepare("INSERT INTO profiles (user_id, specialty, keywords, target_role, minutes_per_day, onboarded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('real-id', 'энергоаудитор', '["boiler efficiency"]', 'Reviewer', 40, '2026-10-29T10:00:00.000Z', '2026-11-05T00:00:00.000Z');
    applySeed(db);
    expect(count(db, 'SELECT count(*) AS n FROM users')).toBe(1);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(FIRST_USER.email) as any;
    expect(u.id).toBe('real-id');
    expect(u.tz).toBe('Europe/Moscow'); // пояс пользователя не меняется
    expect(u.name).toBe(FIRST_USER.name); // пустое имя заполнено
    const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get('real-id') as any;
    expect(p.specialty).toBe('энергоаудитор');
    expect(p.keywords).toBe('["boiler efficiency"]');
    expect(p.target_role).toBe('Reviewer');
    expect(p.minutes_per_day).toBe(40);
    expect(p.onboarded_at).toBe('2026-10-29T10:00:00.000Z');
    expect(p.updated_at).toBe('2026-11-05T00:00:00.000Z'); // более новая отметка остаётся
    expect(p.industry).toBe('энергетика'); // пустое — заполнено
    expect(p.years).toBe(15);
    expect(p.summary).toContain('OpenTrain AI');
    expect((db.prepare('SELECT user_id FROM assessments WHERE id = ?').get(BASELINE.id) as any).user_id).toBe('real-id');
    expect(count(db, "SELECT count(*) AS n FROM error_cards WHERE user_id = 'real-id'")).toBe(CARDS.length);
  });

  it('пустой список ключевых слов считается незаполненным', () => {
    const db = freshDb();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('real-id', FIRST_USER.email);
    db.prepare('INSERT INTO profiles (user_id, keywords, updated_at) VALUES (?, ?, ?)').run('real-id', '[]', '2026-10-01T00:00:00.000Z');
    applySeed(db);
    const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get('real-id') as any;
    expect(JSON.parse(p.keywords).length).toBeGreaterThan(3);
    expect(p.updated_at).toBe('2026-10-30T00:00:00.000Z'); // seed новее — отметка обновлена
  });

  it('тест уровня, пройденный позже среза, становится последним; срез не мешает активному тесту', () => {
    const db = freshDb();
    applySeed(db);
    expect((db.prepare("SELECT count(*) AS n FROM assessments WHERE status = 'active'").get() as any).n).toBe(0);
    db.prepare("INSERT INTO assessments (id, user_id, kind, status, started_at, current_level, updated_at) VALUES ('t1', ?, 'placement', 'finished', '2026-11-02T08:00:00.000Z', 'B2', '2026-11-02T08:00:00.000Z')").run(FIRST_USER.id);
    const latest = db.prepare('SELECT id FROM assessments WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').get(FIRST_USER.id) as any;
    expect(latest.id).toBe('t1');
  });
});

describe('исходный срез и журнал в API', () => {
  async function loggedIn() {
    const mem = memoryStore();
    const env = { DB: null, AI: { run: async () => ({ response: 'hi' }) }, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env;
    const app = createApp('test', () => mem.store);
    const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const j1: any = await (await post('/auth/request', { email: FIRST_USER.email })).json();
    const r2 = await post('/auth/verify', { email: FIRST_USER.email, code: j1.code });
    const cookie = r2.headers.get('set-cookie')!.split(';')[0];
    const h = { cookie };
    const user = mem.users[0];
    return { mem, user, get: (p: string) => call(p, { headers: h }), post: (p: string, b: unknown) => post(p, b, h) };
  }

  it('GET /api/assessment отдаёт срез как завершённый с осями, без сводки попыток; пересчёт среза отклоняется', async () => {
    const { mem, user, get, post } = await loggedIn();
    const s = baselineScore();
    mem.assessments.push({ id: BASELINE.id, userId: user.id, kind: 'baseline', status: 'finished', startedAt: BASELINE.startedAt, finishedAt: BASELINE.startedAt, level: s.level, currentLevel: s.level, updatedAt: BASELINE.startedAt, axes: s.axes, overall: s.overall, scoredAt: BASELINE.startedAt, scoringNote: BASELINE.note, adaptiveCount: 12, programDayId: null });
    const j: any = await (await get('/assessment')).json();
    expect(j.assessment.kind).toBe('baseline');
    expect(j.assessment.status).toBe('finished');
    expect(j.assessment.level).toBe('B1');
    expect(j.assessment.summary).toBeNull();
    expect(j.assessment.result.overall).toBe(s.overall);
    expect(j.assessment.result.axes.find((a: any) => a.id === 'fluency').score).toBeNull();
    expect(j.assessment.result.examples).toEqual([]);
    expect(j.assessment.result.scoringNote).toContain('вне приложения');
    const r = await post('/assessment/score', {});
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).detail).toContain('не пересчитывается');
    expect(mem.assessments[0].overall).toBe(s.overall); // срез не тронут
  });

  it('GET /api/cards: без cookie 401; с cookie — карточки с подписью темы, к повтору первыми', async () => {
    const { mem, user, get } = await loggedIn();
    expect((await get('/cards').then(r => r.status))).toBe(200);
    const base = { userId: user.id, rule: 'r', example: 'e', correction: 'c', source: 'seed', origin: null, stability: 1, difficulty: 5, reps: 0, lapses: 0, streak: 0, reviewedAt: null, createdAt: '2026-10-30T00:00:00.000Z' };
    mem.cards.push({ ...base, id: 'c2', topic: 'task-response', due: '2026-11-02', retired: false });
    mem.cards.push({ ...base, id: 'c3', topic: 'articles', due: '2026-10-30', retired: true });
    mem.cards.push({ ...base, id: 'c1', topic: 'conjunctions', due: '2026-10-30', retired: false });
    const j: any = await (await get('/cards')).json();
    expect(j.cards.map((c: any) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(j.cards[1].topicLabel).toBe('Ответ на вопрос задания');
    expect(j.cards[0].topicLabel).toBe('Союзы и инверсия');
    expect(j.topics.some((t: any) => t.id === 'task-response')).toBe(true);
    const app = createApp('test', () => mem.store);
    expect((await app.request('https://offerly.test/api/cards', {}, { DB: null } as unknown as Env)).status).toBe(401);
  });
});
