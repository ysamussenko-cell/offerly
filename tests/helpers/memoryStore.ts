import type { AuthStore, LoginCode, Session, User } from '../../functions/_lib/auth';
import type { Profile, ProfileStore } from '../../functions/_lib/profile';
import type { OnboardingStore } from '../../functions/_lib/onboarding';
import type { Item, ItemStore } from '../../functions/_lib/items';
import type { Assessment, AssessmentStore, Attempt } from '../../functions/_lib/assessment';
import type { CardStore, ErrorCard } from '../../functions/_lib/cards';
import type { ProgramDay, ProgramStore } from '../../functions/_lib/program';
import type { Lesson, LessonStep, LessonStore } from '../../functions/_lib/lesson';
import type { DashboardStore } from '../../functions/_lib/dashboard';
import type { AchievementRow, AchievementStore, AnswerRecord } from '../../functions/_lib/achievements';
import type { Rehearsal, RehearsalStore, Turn } from '../../functions/_lib/rehearsal';
import type { SpeechStore, SpeechTake } from '../../functions/_lib/voice';
import type { DigestStore } from '../../functions/_lib/digest';

/** Память вместо D1 — та же семантика, что у SQL в d1Store и d1ProfileStore. */
export function memoryStore() {
  const codes: LoginCode[] = [];
  const users: User[] = [];
  const sessions: Session[] = [];
  const profiles = new Map<string, Profile>();
  const items: Item[] = [];
  const assessments: Assessment[] = [];
  const attempts: Attempt[] = [];
  const cards: ErrorCard[] = [];
  const programDays: ProgramDay[] = [];
  const lessons: Lesson[] = [];
  const steps: LessonStep[] = [];
  const achievements: AchievementRow[] = [];
  const rehearsals: Rehearsal[] = [];
  const turns: Turn[] = [];
  const speeches: SpeechTake[] = [];
  const digests: { userId: string; sentOn: string; sentAt: string | null; note: string }[] = [];
  const patchInto = (target: any, patch: object) => Object.assign(target, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  const blank = (userId: string, now: string): Profile => ({
    userId, specialty: null, industry: null, years: null, targetRole: null, keywords: [], summary: null,
    resumeText: null, resumeName: null, resumeAt: null,
    interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, targetLevel: null, weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: now,
  });
  const store: AuthStore & ProfileStore & OnboardingStore & ItemStore & AssessmentStore & CardStore & ProgramStore & LessonStore & DashboardStore & AchievementStore & RehearsalStore & SpeechStore & DigestStore = {
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
      // Без перемешивания: случайность в тестах задаётся rng из opts (pickItem выбирает из кандидатов сам),
      // иначе ход теста зависит от Math.random и тест «14 заданий» падает через раз.
      const list = items.filter(i => i.status === 'verified' && i.kind === kind && i.level === level).map(i => ({ ...i }));
      return list.slice(0, limit);
    },

    async createAssessment(a) { assessments.push({ ...a }); },
    async updateAssessment(id, patch) { const a = assessments.find(x => x.id === id); if (a) Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, k === 'axes' && v ? { ...(v as object) } : v]))); },
    async activeAssessment(userId, kind) { const a = assessments.filter(x => x.userId === userId && x.status === 'active' && (!kind || x.kind === kind)).sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async latestAssessment(userId, kind) { const a = assessments.filter(x => x.userId === userId && (!kind || x.kind === kind)).sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async latestFinishedAssessment(userId) { const a = assessments.filter(x => x.userId === userId && x.status === 'finished').sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async previousFinishedAssessment(userId, before) { const a = assessments.filter(x => x.userId === userId && x.status === 'finished' && x.startedAt < before).sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return a ? { ...a } : null; },
    async insertAttempt(t) { attempts.push({ ...t }); },
    async updateAttempt(id, patch) { const t = attempts.find(x => x.id === id); if (t) Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); },
    async listAttempts(assessmentId) { return attempts.filter(x => x.assessmentId === assessmentId).sort((p, q) => p.position - q.position).map(x => ({ ...x })); },
    async usedItemIds(userId) { return new Set(attempts.filter(x => x.userId === userId).map(x => x.itemId)); },

    async listCards(userId) {
      const key = (c: ErrorCard) => `${c.retired ? 1 : 0}|${c.due == null ? 1 : 0}|${c.due ?? ''}|${c.createdAt}|${c.id}`;
      return cards.filter(c => c.userId === userId).sort((a, b) => key(a).localeCompare(key(b))).map(c => ({ ...c }));
    },
    async getCard(id) { const c = cards.find(x => x.id === id); return c ? { ...c } : null; },
    async updateCard(id, patch) { const c = cards.find(x => x.id === id); if (c) patchInto(c, patch); },
    async insertCards(list) {
      let n = 0;
      for (const c of list) {
        if (cards.some(x => x.id === c.id || (c.origin != null && x.userId === c.userId && x.origin === c.origin))) continue;
        cards.push({ ...c }); n++;
      }
      return n;
    },

    async listProgramDays(userId) {
      return programDays.filter(d => d.userId === userId).sort((a, b) => a.dayDate.localeCompare(b.dayDate) || a.position - b.position || a.id.localeCompare(b.id)).map(d => ({ ...d }));
    },
    async getProgramDay(id) { const d = programDays.find(x => x.id === id); return d ? { ...d } : null; },
    async replacePlannedDays(userId, fromDate, days) {
      for (let i = programDays.length - 1; i >= 0; i--) { const d = programDays[i]; if (d.userId === userId && d.status === 'planned' && d.dayDate >= fromDate) programDays.splice(i, 1); }
      for (const d of days) programDays.push({ ...d });
    },
    async updateProgramDay(id, patch) { const d = programDays.find(x => x.id === id); if (d) patchInto(d, patch); },

    async createLesson(l) { lessons.push({ ...l }); },
    async updateLesson(id, patch) { const l = lessons.find(x => x.id === id); if (l) patchInto(l, patch); },
    async lessonForDay(userId, dayDate) { const l = lessons.filter(x => x.userId === userId && x.dayDate === dayDate).sort((p, q) => q.startedAt.localeCompare(p.startedAt))[0]; return l ? { ...l } : null; },
    async listLessons(userId) { return lessons.filter(x => x.userId === userId).sort((p, q) => p.dayDate.localeCompare(q.dayDate) || p.startedAt.localeCompare(q.startedAt)).map(l => ({ ...l })); },
    async insertStep(s) { steps.push({ ...s }); },
    async updateStep(id, patch) { const s = steps.find(x => x.id === id); if (s) patchInto(s, patch); },
    async listSteps(lessonId) { return steps.filter(s => s.lessonId === lessonId).sort((p, q) => p.position - q.position).map(s => ({ ...s })); },
    async usedLessonItemIds(userId) { return new Set(steps.filter(s => s.userId === userId && s.itemId).map(s => s.itemId as string)); },

    async saveWeeklyGoal(userId, minutes, now) { const p = profiles.get(userId) ?? blank(userId, now); profiles.set(userId, { ...p, weeklyGoalMinutes: minutes, updatedAt: now }); },

    async answerLog(userId) {
      const out: AnswerRecord[] = [];
      for (const a of attempts) {
        const i = items.find(x => x.id === a.itemId);
        if (a.userId !== userId || !a.answeredAt || !i) continue;
        out.push({ at: a.answeredAt, source: 'assessment', lessonId: null, part: null, kind: i.kind, topic: i.topic, level: a.level, lessonLevel: null, writingFormat: i.writingFormat, correct: a.correct, score: a.score, detail: a.detail });
      }
      for (const s of steps) {
        const i = s.itemId ? items.find(x => x.id === s.itemId) : null;
        const l = lessons.find(x => x.id === s.lessonId);
        if (s.userId !== userId || !s.answeredAt || !i || !l) continue;
        out.push({ at: s.answeredAt, source: 'lesson', lessonId: s.lessonId, part: s.part, kind: i.kind, topic: i.topic, level: s.level, lessonLevel: l.level, writingFormat: i.writingFormat, correct: s.correct, score: s.score, detail: s.detail });
      }
      return out.sort((p, q) => p.at.localeCompare(q.at));
    },
    async listAchievements(userId) { return achievements.filter(a => a.userId === userId).sort((p, q) => p.unlockedAt.localeCompare(q.unlockedAt)).map(a => ({ ...a })); },
    async insertAchievements(rows) {
      let n = 0;
      for (const r of rows) { if (achievements.some(a => a.userId === r.userId && a.code === r.code)) continue; achievements.push({ ...r }); n++; }
      return n;
    },
    async markAchievementsSeen(userId, now) { for (const a of achievements) if (a.userId === userId && !a.seenAt) a.seenAt = now; },

    async createRehearsal(r, list) { rehearsals.push({ ...r, axes: r.axes ? { ...r.axes } : null }); for (const t of list) turns.push({ ...t, rubric: [...t.rubric] }); },
    async updateRehearsal(id, patch) { const r = rehearsals.find(x => x.id === id); if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, k === 'axes' && v ? { ...(v as object) } : v]))); },
    async rehearsalForDay(userId, dayDate) {
      const ab = (x: Rehearsal) => x.status === 'abandoned' ? 1 : 0;
      const r = rehearsals.filter(x => x.userId === userId && x.dayDate === dayDate).sort((p, q) => ab(p) - ab(q) || q.startedAt.localeCompare(p.startedAt))[0];
      return r ? { ...r } : null;
    },
    async listRehearsals(userId) { return rehearsals.filter(x => x.userId === userId).sort((p, q) => p.dayDate.localeCompare(q.dayDate) || p.startedAt.localeCompare(q.startedAt)).map(r => ({ ...r })); },
    async updateTurn(id, patch) { const t = turns.find(x => x.id === id); if (t) patchInto(t, patch); },
    async listTurns(rehearsalId) { return turns.filter(t => t.rehearsalId === rehearsalId).sort((p, q) => p.position - q.position).map(t => ({ ...t, rubric: [...t.rubric] })); },

    async insertSpeech(s) { speeches.push({ ...s }); },
    async getSpeech(id, userId) { const s = speeches.find(x => x.id === id && x.userId === userId); return s ? { ...s } : null; },

    async listDigestUsers() {
      const out: { user: User; profile: Profile }[] = [];
      for (const u of [...users].sort((a, b) => a.id.localeCompare(b.id))) {
        const p = profiles.get(u.id);
        if (p?.notifyAt) out.push({ user: { ...u }, profile: { ...p, keywords: [...p.keywords] } });
      }
      return out;
    },
    async saveNotifyAt(userId, notifyAt, sentOn, now) {
      const p = profiles.get(userId) ?? blank(userId, now);
      profiles.set(userId, { ...p, notifyAt, digestSentOn: sentOn ?? p.digestSentOn, updatedAt: now });
    },
    async markDigest(userId, sentOn, sentAt, note, now) {
      const p = profiles.get(userId) ?? blank(userId, now);
      profiles.set(userId, { ...p, digestSentOn: sentOn, updatedAt: now });
      digests.push({ userId, sentOn, sentAt, note });
    },
  };
  return { store, codes, users, sessions, profiles, items, assessments, attempts, cards, programDays, lessons, steps, achievements, rehearsals, turns, speeches, digests };
}
