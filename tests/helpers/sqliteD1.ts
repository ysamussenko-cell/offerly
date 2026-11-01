import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { d1AllStores, type Env } from '../../functions/_lib/app';
import type { Assessment } from '../../functions/_lib/assessment';
import type { Profile } from '../../functions/_lib/profile';

// node:sqlite — встроенный модуль Node 22, но Vite его не знает как builtin; берём напрямую у процесса.
const { DatabaseSync: Sqlite } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** База в памяти с полным набором миграций — как D1 после `wrangler d1 migrations apply`. */
export function freshDb(): DatabaseSync {
  const db: DatabaseSync = new Sqlite(':memory:');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${f}`, 'utf-8'));
  return db;
}

/** Тонкая обёртка node:sqlite под интерфейс D1 (prepare → bind → first | all | run, batch) — проверяет настоящий SQL хранилищ. */
export function d1Of(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []): any => {
    const runNow = () => { const r = db.prepare(sql).run(...(args as any[])); return { success: true, meta: { changes: r.changes } }; };
    return {
      bind: (...a: unknown[]) => stmt(sql, a),
      async first() { return db.prepare(sql).get(...(args as any[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(args as any[])), success: true, meta: {} }; },
      async run() { return runNow(); },
      runNow,
      sql, args,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    // Пакет целиком синхронный: между BEGIN и COMMIT нет await, и параллельные запросы стенда e2e не попадают в чужую транзакцию.
    async batch(list: any[]) { db.exec('BEGIN'); try { const out = list.map(s => s.runNow()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async exec(sql: string) { db.exec(sql); return { count: 1, duration: 0 }; },
    dump: async () => new ArrayBuffer(0),
    withSession: () => { throw new Error('not supported'); },
  } as unknown as D1Database;
}

/** Строка таблицы для проверок: колонки в camelCase (user_id → userId), значения как в SQLite (булевы — 0/1, JSON — строкой). */
export type Row = Record<string, any>;

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Выборка для проверок теста или сценария: rows('SELECT * FROM error_cards WHERE source = ?', 'rehearsal'). */
export const rowsOf = (db: DatabaseSync) => <T = Row>(sql: string, ...params: (string | number | null)[]): T[] =>
  db.prepare(sql).all(...params).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v]))) as T[];

/** Хранилище API-тестов: настоящие хранилища D1 (d1AllStores) поверх SQLite в памяти со всеми миграциями.
 *  env подставляется в createApp/app.fetch как привязка DB; проверки базы — запросами rows. Единственное хранилище API-тестов (memoryStore удалён в 0.25.15). */
export function sqlStore() {
  const db = freshDb();
  const DB = d1Of(db);
  const store = d1AllStores({ DB } as Env);
  /** Пользователь без входа — для тестов модулей, которые получают userId готовым (внешние ключи в D1 соблюдаются). */
  const addUser = (id: string, email = `${id}@example.com`, tz = 'Asia/Almaty') =>
    void db.prepare('INSERT INTO users (id, email, tz) VALUES (?, ?, ?)').run(id, email, tz);
  /** Тест или срез целиком, с осями и баллом: createAssessment пишет только начало, оценку — updateAssessment, как в работе. */
  const putAssessment = async (a: Assessment) => {
    await store.createAssessment(a);
    if (a.scoredAt || a.overall != null) await store.updateAssessment(a.id, { axes: a.axes ?? undefined, overall: a.overall, scoredAt: a.scoredAt, scoringNote: a.scoringNote } as Partial<Assessment>);
  };
  /** Профиль целиком одной строкой (у хранилища профиля только частичные записи — анкета, резюме, разбор): поля → колонки snake_case, keywords — JSON. */
  const putProfile = (p: Profile) => {
    const cols = Object.entries(p).map(([k, v]) => [k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), k === 'keywords' ? JSON.stringify(v) : v] as const);
    db.prepare(`INSERT INTO profiles (${cols.map(c => c[0]).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => c[1] as any));
  };
  return { store, db, DB, rows: rowsOf(db), addUser, putAssessment, putProfile };
}
