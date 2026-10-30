/** Вход по почте с одноразовым кодом и cookie-сессия.
 *  Коды и токены хранятся только в виде SHA-256; секретов для этого не требуется. */

export const CODE_LENGTH = 6;
export const CODE_TTL_SEC = 10 * 60;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_WINDOW = 3;        // не больше трёх кодов на адрес…
export const CODE_WINDOW_SEC = 15 * 60;   // …за пятнадцать минут
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
export const SESSION_COOKIE = 'offerly_session';

export interface LoginCode { id: string; email: string; codeHash: string; attempts: number; usedAt: string | null; expiresAt: string; createdAt: string }
export interface Session { id: string; userId: string; expiresAt: string }
export interface User { id: string; email: string; name: string | null; locale: string; tz: string }

/** Хранилище — тонкая прослойка над D1, в тестах заменяется памятью. */
export interface AuthStore {
  countRecentCodes(email: string, sinceIso: string): Promise<number>;
  insertCode(code: LoginCode): Promise<void>;
  latestActiveCode(email: string, nowIso: string): Promise<LoginCode | null>;
  bumpAttempts(id: string): Promise<void>;
  markCodeUsed(id: string, nowIso: string): Promise<void>;
  findUserByEmail(email: string): Promise<User | null>;
  insertUser(user: User): Promise<void>;
  insertSession(s: Session): Promise<void>;
  findSession(id: string, nowIso: string): Promise<{ session: Session; user: User } | null>;
  touchSession(id: string, nowIso: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const code = String(raw).replace(/\D/g, '');
  return code.length === CODE_LENGTH ? code : null;
}

export function randomCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, '0');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Хэш кода привязан к записи (id как соль) и к адресу, чтобы код нельзя было переиспользовать. */
export const hashCode = (id: string, email: string, code: string) => sha256(`${id}:${email}:${code}`);

const iso = (ms: number) => new Date(ms).toISOString();

export type RequestResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; reason: 'bad_email' | 'too_many' };

/** Создаёт код для адреса. Возвращает открытый код — отправить письмом и забыть. */
export async function requestCode(store: AuthStore, rawEmail: unknown, now = Date.now()): Promise<RequestResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: 'bad_email' };
  const recent = await store.countRecentCodes(email, iso(now - CODE_WINDOW_SEC * 1000));
  if (recent >= CODES_PER_WINDOW) return { ok: false, reason: 'too_many' };
  const id = randomToken(16);
  const code = randomCode();
  const expiresAt = iso(now + CODE_TTL_SEC * 1000);
  await store.insertCode({ id, email, codeHash: await hashCode(id, email, code), attempts: 0, usedAt: null, expiresAt, createdAt: iso(now) });
  return { ok: true, code, expiresAt };
}

export type VerifyResult =
  | { ok: true; user: User; token: string; expiresAt: string; isNew: boolean }
  | { ok: false; reason: 'bad_input' | 'no_code' | 'wrong_code' | 'locked' };

/** Проверяет код; при успехе создаёт пользователя (если нового) и сессию. Токен — в cookie, в базе только его хэш. */
export async function verifyCode(store: AuthStore, rawEmail: unknown, rawCode: unknown, now = Date.now()): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const code = normalizeCode(rawCode);
  if (!email || !code) return { ok: false, reason: 'bad_input' };
  const rec = await store.latestActiveCode(email, iso(now));
  if (!rec) return { ok: false, reason: 'no_code' };
  const attemptsBefore = rec.attempts;
  if (attemptsBefore >= CODE_MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (rec.codeHash !== await hashCode(rec.id, email, code)) {
    await store.bumpAttempts(rec.id);
    return { ok: false, reason: attemptsBefore + 1 >= CODE_MAX_ATTEMPTS ? 'locked' : 'wrong_code' };
  }
  await store.markCodeUsed(rec.id, iso(now));

  let user = await store.findUserByEmail(email);
  const isNew = !user;
  if (!user) {
    user = { id: randomToken(16), email, name: null, locale: 'ru', tz: 'Asia/Almaty' };
    await store.insertUser(user);
  }
  const token = randomToken(32);
  const expiresAt = iso(now + SESSION_TTL_SEC * 1000);
  await store.insertSession({ id: await sha256(token), userId: user.id, expiresAt });
  return { ok: true, user, token, expiresAt, isNew };
}

export async function sessionFromToken(store: AuthStore, token: string | undefined, now = Date.now()): Promise<{ session: Session; user: User } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = await sha256(token);
  const found = await store.findSession(id, iso(now));
  if (found) await store.touchSession(id, iso(now));
  return found;
}

export async function logout(store: AuthStore, token: string | undefined): Promise<void> {
  if (!token) return;
  await store.deleteSession(await sha256(token));
}

export function sessionCookie(token: string, expiresAt: string, secure = true): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(expiresAt).toUTCString()}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure = true): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header: string | undefined | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Реализация хранилища на D1. */
export function d1Store(db: D1Database): AuthStore {
  const toCode = (r: any): LoginCode => ({ id: r.id, email: r.email, codeHash: r.code_hash, attempts: r.attempts ?? 0, usedAt: r.used_at ?? null, expiresAt: r.expires_at, createdAt: r.created_at });
  const toUser = (r: any): User => ({ id: r.id, email: r.email, name: r.name ?? null, locale: r.locale ?? 'ru', tz: r.tz ?? 'Asia/Almaty' });
  return {
    async countRecentCodes(email, sinceIso) {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at >= ?').bind(email, sinceIso).first<{ n: number }>();
      return r?.n ?? 0;
    },
    async insertCode(c) {
      await db.prepare('INSERT INTO login_codes (id, email, code_hash, attempts, used_at, expires_at, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?)')
        .bind(c.id, c.email, c.codeHash, c.expiresAt, c.createdAt).run();
    },
    async latestActiveCode(email, nowIso) {
      const r = await db.prepare('SELECT * FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(email, nowIso).first();
      return r ? toCode(r) : null;
    },
    async bumpAttempts(id) { await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(id).run(); },
    async markCodeUsed(id, nowIso) { await db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').bind(nowIso, id).run(); },
    async findUserByEmail(email) {
      const r = await db.prepare('SELECT id, email, name, locale, tz FROM users WHERE email = ?').bind(email).first();
      return r ? toUser(r) : null;
    },
    async insertUser(u) {
      await db.prepare('INSERT INTO users (id, email, name, locale, tz) VALUES (?, ?, ?, ?, ?)').bind(u.id, u.email, u.name, u.locale, u.tz).run();
    },
    async insertSession(s) {
      await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(s.id, s.userId, s.expiresAt).run();
    },
    async findSession(id, nowIso) {
      const r: any = await db.prepare(
        'SELECT s.id AS sid, s.user_id, s.expires_at, u.id, u.email, u.name, u.locale, u.tz FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?'
      ).bind(id, nowIso).first();
      if (!r) return null;
      return { session: { id: r.sid, userId: r.user_id, expiresAt: r.expires_at }, user: toUser(r) };
    },
    async touchSession(id, nowIso) { await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso, id).run(); },
    async deleteSession(id) { await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run(); },
  };
}
