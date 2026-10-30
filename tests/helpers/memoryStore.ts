import type { AuthStore, LoginCode, Session, User } from '../../functions/_lib/auth';

/** Память вместо D1 — та же семантика, что у SQL в d1Store. */
export function memoryStore() {
  const codes: LoginCode[] = [];
  const users: User[] = [];
  const sessions: Session[] = [];
  const store: AuthStore = {
    async countRecentCodes(email, since) { return codes.filter(c => c.email === email && c.createdAt >= since).length; },
    async insertCode(c) { codes.push({ ...c }); },
    async latestActiveCode(email, now) {
      const c = codes.filter(c => c.email === email && !c.usedAt && c.expiresAt > now).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return c ? { ...c } : null; // копия, как строка из D1
    },
    async bumpAttempts(id) { const c = codes.find(x => x.id === id)!; c.attempts++; },
    async markCodeUsed(id, now) { codes.find(x => x.id === id)!.usedAt = now; },
    async findUserByEmail(email) { return users.find(u => u.email === email) ?? null; },
    async insertUser(u) { users.push({ ...u }); },
    async insertSession(s) { sessions.push({ ...s }); },
    async findSession(id, now) {
      const s = sessions.find(x => x.id === id && x.expiresAt > now);
      if (!s) return null;
      return { session: s, user: users.find(u => u.id === s.userId)! };
    },
    async touchSession() {},
    async deleteSession(id) { const i = sessions.findIndex(x => x.id === id); if (i >= 0) sessions.splice(i, 1); },
  };
  return { store, codes, users, sessions };
}

