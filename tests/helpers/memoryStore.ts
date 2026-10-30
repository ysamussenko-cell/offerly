import type { AuthStore, LoginCode, Session, User } from '../../functions/_lib/auth';
import type { Profile, ProfileStore } from '../../functions/_lib/profile';
import type { OnboardingStore } from '../../functions/_lib/onboarding';
import type { Item, ItemStore } from '../../functions/_lib/items';
import type { Assessment, AssessmentStore, Attempt } from '../../functions/_lib/assessment';

/** Память вместо D1 — та же семантика, что у SQL в d1Store и d1ProfileStore. */
export function memoryStore() {
  const codes: LoginCode[] = [];
  const users: User[] = [];
  const sessions: Session[] = [];
  const profiles = new Map<string, Profile>();
  const items: Item[] = [];
  const assessments: Assessment[] = [];
  const attempts: Attempt[] = [];
  const blank = (userId: string, now: string): Profile => ({
    userId, specialty: null, industry: null, years: null, targetRole: null, keywords: [], summary: null,
    resumeText: null, resumeName: null, resumeAt: null,
    interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, updatedAt: now,
  });
  const store: AuthStore & ProfileStore & OnboardingStore & ItemStore & AssessmentStore = {
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

    async insertItems(list) { for (const i of list) items.push({ ...i }); },
    async knownFingerprints(fps) { return new Set(items.filter(i => fps.includes(i.fingerprint)).map(i => i.fingerprint)); },
    async listItems(f) {
      return items.filter(i => (!f.level || i.level === f.level) && (!f.topic || i.topic === f.topic) && (!f.kind || i.kind === f.kind) && (!f.status || i.status === f.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(f.limit ?? 50, 1), 200)).map(i => ({ ...i }));
    },
    async bankStats() {
      const m = new Map<string, { level: Item['level']; kind: Item['kind']; status: Item['status']; count: number }>();
      for (const i of items) {
        const k = `${i.level}|${i.kind}|${i.status}`;
        const row = m.get(k) ?? { level: i.level, kind: i.kind, status: i.status, count: 0 };
        row.count++; m.set(k, row);
      }
      return [...m.values()];
    },
    async getItem(id) { const i = items.find(x => x.id === id); return i ? { ...i } : null; },
    async randomItems(kind, level, limit) {
      const list = items.filter(i => i.status === 'verified' && i.kind === kind && i.level === level).map(i => ({ ...i }));
      for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
      return list.slice(0, limit);
    },

    async createAssessment(a) { assessments.push({ ...a }); },
    async updateAssessment(id, patch) { const a = assessments.find(x => x.id === id); if (a) Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); },
    async activeAssessment(userId) { const a = assessments.filter(x => x.userId === userId && x.status === 'active').sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async latestAssessment(userId) { const a = assessments.filter(x => x.userId === userId).sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async insertAttempt(t) { attempts.push({ ...t }); },
    async updateAttempt(id, patch) { const t = attempts.find(x => x.id === id); if (t) Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); },
    async listAttempts(assessmentId) { return attempts.filter(x => x.assessmentId === assessmentId).sort((p, q) => p.position - q.position).map(x => ({ ...x })); },
    async usedItemIds(userId) { return new Set(attempts.filter(x => x.userId === userId).map(x => x.itemId)); },
  };
  return { store, codes, users, sessions, profiles, items, assessments, attempts };
}
