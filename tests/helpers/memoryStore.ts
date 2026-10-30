import type { AuthStore, LoginCode, Session, User } from '../../functions/_lib/auth';
import type { Profile, ProfileStore } from '../../functions/_lib/profile';
import type { OnboardingStore } from '../../functions/_lib/onboarding';

/** Память вместо D1 — та же семантика, что у SQL в d1Store и d1ProfileStore. */
export function memoryStore() {
  const codes: LoginCode[] = [];
  const users: User[] = [];
  const sessions: Session[] = [];
  const profiles = new Map<string, Profile>();
  const blank = (userId: string, now: string): Profile => ({
    userId, specialty: null, industry: null, years: null, targetRole: null, keywords: [], summary: null,
    resumeText: null, resumeName: null, resumeAt: null,
    interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, updatedAt: now,
  });
  const store: AuthStore & ProfileStore & OnboardingStore = {
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

    async getProfile(userId) { const p = profiles.get(userId); return p ? { ...p, keywords: [...p.keywords] } : null; },
    async saveResume(userId, text, name, now) {
      const p = profiles.get(userId) ?? blank(userId, now);
      profiles.set(userId, { ...p, resumeText: text, resumeName: name, resumeAt: now, updatedAt: now, specialty: null, industry: null, years: null, keywords: [], summary: null });
    },
    async saveAnalysis(userId, a, now) {
      const p = profiles.get(userId) ?? blank(userId, now);
      const targetRole = p.onboardedAt ? p.targetRole : a.targetRole; // после анкеты ответ пользователя важнее догадки модели
      profiles.set(userId, { ...p, ...a, targetRole, keywords: [...a.keywords], updatedAt: now });
    },
    async saveAnswers(userId, a, now) {
      const p = profiles.get(userId) ?? blank(userId, now);
      profiles.set(userId, { ...p, targetRole: a.targetRole, interviewDate: a.interviewDate, interviewFormat: a.interviewFormat,
        minutesPerDay: a.minutesPerDay, nativeLanguage: a.nativeLanguage, onboardedAt: now, updatedAt: now });
      const u = users.find(u => u.id === userId); if (u) u.tz = a.tz;
    },
  };
  return { store, codes, users, sessions, profiles };
}
