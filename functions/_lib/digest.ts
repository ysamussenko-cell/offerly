/** Ежедневное письмо (концепт §5, таблица «Почта»): одно письмо в день с заданием дня и прогрессом, через Resend.
 *
 *  Время — profiles.notify_at (HH:MM в поясе пользователя, users.tz); NULL — письмо выключено. Pages Functions
 *  не умеют расписание, поэтому письма рассылает отдельный Worker (workers/digest) по cron раз в CRON_STEP_MINUTES минут:
 *  он перебирает пользователей с включённым письмом и шлёт тем, у кого в их поясе уже наступило назначенное время,
 *  но не прошло больше SEND_WINDOW_MINUTES — письмо «доброе утро» в десять вечера не нужно. День отмечается
 *  в profiles.digest_sent_on (дата в поясе пользователя), поэтому за день уходит не больше одного письма, даже если
 *  Worker запускается чаще или перезапускается; пропущенный день (Worker не работал) помечается skipped:late и
 *  не досылается.
 *
 *  Содержимое считается теми же модулями, что и экраны: день программы (program.ts), карточки к повтору (cards.ts),
 *  готовность, серия и минуты недели (dashboard.ts). Ничего не выдумывается: в письме только то, что есть в базе.
 *  Тот же текст отдаёт GET /api/digest (предпросмотр) и шлёт POST /api/digest/send (сразу, вне расписания). */
import type { User } from './auth';
import type { Profile, ProfileStore } from './profile';
import { dashboard, type Store as DashboardDeps, type View as DashboardView } from './dashboard';
import { dueForReview, type CardStore } from './cards';
import { publicDay, type ProgramStore, type PublicDay } from './program';
import { sendMail, type MailEnv, type SendResult } from './mail';
import { addDays, daysBetween, longDateRu, weekdayOf } from './dates';

/** Время по умолчанию, когда письмо включают без указания времени. */
export const DEFAULT_NOTIFY_AT = '07:30';
/** Письмо уходит в первые столько минут после назначенного времени; дальше день считается пропущенным. */
export const SEND_WINDOW_MINUTES = 180;
/** Шаг расписания Worker — письмо приходит не позже чем через столько минут после назначенного времени. */
export const CRON_STEP_MINUTES = 15;
export const CRON = `*/${CRON_STEP_MINUTES} * * * *`;
export const DEFAULT_APP_URL = 'https://offerly-c8b.pages.dev';

export type DigestState = 'off' | 'sent' | 'early' | 'due' | 'late';

export interface DigestEnv extends MailEnv { APP_URL?: string }

export interface DigestStore {
  /** Пользователи с включённым письмом вместе с профилями. */
  listDigestUsers(): Promise<{ user: User; profile: Profile }[]>;
  /** Время письма: HH:MM или null (выключить). sentOn — отметить сегодняшний день отправленным, чтобы первое письмо пришло завтра. */
  saveNotifyAt(userId: string, notifyAt: string | null, sentOn: string | null, nowIso: string): Promise<void>;
  /** Итог попытки за день: дата (в поясе пользователя), момент отправки (null — не отправлялось) и заметка sent | skipped:… | error:…. */
  markDigest(userId: string, sentOn: string, sentAt: string | null, note: string, nowIso: string): Promise<void>;
}

/** Что нужно, чтобы собрать содержимое письма (его же использует напоминание push.ts). */
export type ContentStore = DashboardDeps & Pick<CardStore, 'listCards'> & Pick<ProgramStore, 'listProgramDays'> & Pick<ProfileStore, 'getProfile'>;
export type Store = DigestStore & ContentStore;

// ---------- время ----------

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** HH:MM из формы: null или пусто — выключить; «7:41» → «07:41». */
export function parseNotifyAt(raw: unknown): { ok: true; value: string | null } | { ok: false; reason: 'format' } {
  if (raw == null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'format' };
  const m = TIME_RE.exec(raw.trim());
  if (!m) return { ok: false, reason: 'format' };
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return { ok: false, reason: 'format' };
  return { ok: true, value: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

export const minutesOf = (hhmm: string): number => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Дата и минуты с полуночи в поясе пользователя. */
export function localClock(tz: string, now: Date): { date: string; minutes: number; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const g = (t: Intl.DateTimeFormatPart['type']) => parts.find(p => p.type === t)?.value ?? '00';
  const hour = g('hour') === '24' ? '00' : g('hour');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(hour) * 60 + Number(g('minute')), time: `${hour}:${g('minute')}` };
}

/** Состояние письма на сейчас: выключено, за сегодня уже отмечено, ещё рано, пора (в окне) или поздно (окно прошло). */
export function digestState(p: Pick<Profile, 'notifyAt' | 'digestSentOn'>, tz: string, now: Date): { state: DigestState; date: string; time: string } {
  const clock = localClock(tz, now);
  const at = p.notifyAt ? parseNotifyAt(p.notifyAt) : null;
  if (!at || !at.ok || !at.value) return { state: 'off', date: clock.date, time: clock.time };
  if (p.digestSentOn === clock.date) return { state: 'sent', date: clock.date, time: clock.time };
  const target = minutesOf(at.value);
  if (clock.minutes < target) return { state: 'early', date: clock.date, time: clock.time };
  if (clock.minutes < target + SEND_WINDOW_MINUTES) return { state: 'due', date: clock.date, time: clock.time };
  return { state: 'late', date: clock.date, time: clock.time };
}

/** Когда придёт следующее письмо: сегодня, если время ещё не наступило, иначе завтра; null — выключено. */
export function nextDigest(p: Pick<Profile, 'notifyAt' | 'digestSentOn'>, tz: string, now: Date): { date: string; time: string } | null {
  const s = digestState(p, tz, now);
  if (s.state === 'off') return null;
  return { date: s.state === 'early' ? s.date : addDays(s.date, 1), time: p.notifyAt as string };
}

// ---------- текст ----------

const WEEKDAYS_LONG_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const plural = (n: number, one: string, few: string, many: string) => {
  const abs = Math.abs(n), m10 = abs % 10, m100 = abs % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
export const daysText = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const minutesText = (n: number) => `${n} ${plural(n, 'минута', 'минуты', 'минут')}`;
const cardsText = (n: number) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;
export const weekdayRu = (iso: string) => WEEKDAYS_LONG_RU[weekdayOf(iso)];

const firstName = (u: User) => (u.name ?? '').trim().split(/\s+/)[0] || null;

export interface DigestData {
  today: string;
  day: PublicDay | null;
  programExists: boolean;
  /** Сегодняшний день уже пройден (занятие, репетиция или срез). */
  todayDone: boolean;
  dueCards: number;
  view: DashboardView;
}

export interface DigestMail { subject: string; text: string; html: string; headline: string }

/** Заголовок задания дня — он же тема письма. */
export function headlineOf(d: DigestData): string {
  if (!d.programExists) return 'программы ещё нет';
  if (!d.day) return 'день без занятия по программе';
  if (d.day.format === 'lesson') return `занятие · ${d.day.topicLabel}`;
  return d.day.formatLabel;
}

/** Строки блока «Задание дня». */
export function taskLines(d: DigestData): string[] {
  const out: string[] = [];
  if (!d.programExists) {
    out.push('Программа ещё не составлена: откройте карточку «Программа» и нажмите «Составить программу» — план на четыре недели по вашим слабым темам.');
  } else if (!d.day) {
    out.push('На сегодня в программе ничего не назначено. Если хочется позаниматься — повторите карточки или пройдите срез вне плана.');
  } else {
    const parts = [d.day.formatLabel];
    if (d.day.format === 'lesson') parts.push(`тема «${d.day.topicLabel}»`);
    if (d.day.writingLabel) parts.push(`письмо — ${d.day.writingLabel}`);
    if (d.day.minutes) parts.push(minutesText(d.day.minutes));
    out.push(parts.join(', ') + '.');
    if (d.day.reason) out.push(`Почему: ${d.day.reason}`);
    if (d.todayDone) out.push(`Сегодняшний день уже пройден${d.day.score != null ? ` — ${d.day.score} из 100` : ''}.`);
  }
  out.push(d.dueCards > 0 ? `К повтору в журнале ошибок: ${cardsText(d.dueCards)}.` : 'Карточек к повтору сегодня нет.');
  return out;
}

/** Строки блока «Прогресс». */
export function progressLines(d: DigestData): string[] {
  const v = d.view, r = v.readiness, out: string[] = [];
  if (r.value == null) out.push('Готовность: появится после теста уровня.');
  else out.push(`Готовность: ${r.value} из 100, уровень ${r.level}${r.forecast.target.reached ? ` — целевой ${r.forecast.target.level} взят` : ` (цель ${r.forecast.target.level} — от ${r.forecast.target.points})`}.`);
  out.push(`Серия: ${daysText(v.streak.current)}${v.streak.todayDone ? ', сегодня засчитано' : ''}${v.streak.freezeAvailable ? '; заморозка этой недели есть' : '; заморозка недели потрачена'}.`);
  out.push(`Неделя: ${v.goal.done} из ${v.goal.minutes} минут${v.goal.left > 0 ? `, осталось ${minutesText(v.goal.left)}` : ' — цель выполнена'}.`);
  if (v.countdown.interviewDate && v.countdown.daysLeft != null) {
    const n = v.countdown.daysLeft;
    out.push(`Собеседование: ${n < 0 ? 'дата прошла' : n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${daysText(n)}`} (${longDateRu(v.countdown.interviewDate)}).`);
  }
  if (v.program.exists && v.program.endDate) out.push(`Программа: пройдено ${v.program.done} из ${v.program.total} дней, до ${longDateRu(v.program.endDate)}${daysBetween(d.today, v.program.endDate) < 0 ? ' — срок вышел, соберите новую' : ''}.`);
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Письмо целиком: тема, текст и HTML в цветах дизайн-проекта (графит, бумага, янтарь). */
export function renderDigest(d: DigestData, user: User, profile: Profile, env: Pick<DigestEnv, 'APP_NAME' | 'APP_URL'>): DigestMail {
  const appName = env.APP_NAME || 'Offerly';
  const url = env.APP_URL || DEFAULT_APP_URL;
  const headline = headlineOf(d);
  const dateLine = `${weekdayRu(d.today)}, ${longDateRu(d.today, false)}`;
  const name = firstName(user);
  const greeting = name ? `Здравствуйте, ${name}.` : 'Здравствуйте.';
  const task = taskLines(d), progress = progressLines(d);
  const footer = `Письмо приходит раз в день в ${profile.notifyAt ?? DEFAULT_NOTIFY_AT} (${user.tz}). Изменить время или отключить — карточка «Ежедневное письмо» на главном экране.`;
  const subject = `${appName}, ${longDateRu(d.today, false)}: ${headline}`;
  const text = [
    greeting, '',
    `Задание дня — ${dateLine}`, ...task, '',
    'Прогресс', ...progress, '',
    `Открыть ${appName}: ${url}`, '',
    footer,
  ].join('\n');
  const r = d.view.readiness;
  const bar = r.value == null ? '' : `
    <div style="height:6px;border-radius:999px;background:#E6E1D8;margin:10px 0 4px;overflow:hidden"><div style="width:${r.value}%;height:100%;background:#F2A541"></div></div>`;
  const li = (lines: string[]) => lines.map(l => `<p style="margin:0 0 8px;line-height:1.5">${esc(l)}</p>`).join('\n    ');
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#F6F3EE;font-family:Inter,Arial,sans-serif;color:#1C2433">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-family:Manrope,Inter,Arial,sans-serif;font-weight:800;font-size:20px;color:#141C2B;margin-bottom:24px">${esc(appName)}</div>
  <div style="background:#FFFFFF;border:1px solid #E6E1D8;border-radius:16px;padding:24px">
    <p style="margin:0 0 16px">${esc(greeting)}</p>
    <p style="margin:0 0 4px;color:#6B7280;font-size:13px">Задание дня · ${esc(dateLine)}</p>
    <p style="margin:0 0 12px;font-family:Manrope,Inter,Arial,sans-serif;font-weight:700;font-size:18px;color:#141C2B">${esc(headline[0].toUpperCase() + headline.slice(1))}</p>
    ${li(task)}
    <p style="margin:20px 0 4px;color:#6B7280;font-size:13px">Прогресс</p>${bar}
    ${li(progress)}
    <p style="margin:20px 0 0"><a href="${esc(url)}" style="display:inline-block;background:#F2A541;color:#141C2B;font-weight:600;border-radius:12px;padding:12px 20px;text-decoration:none">Открыть ${esc(appName)}</a></p>
  </div>
  <p style="margin:16px 0 0;color:#6B7280;font-size:13px;line-height:1.5">${esc(footer)}</p>
</div></body></html>`;
  return { subject, text, html, headline };
}

// ---------- сборка ----------

export interface RunOpts { now?: () => string; fetchFn?: typeof fetch }

/** Данные письма на сегодня — из тех же модулей, что и экраны. */
export async function collectDigest(store: ContentStore, user: User, profile: Profile | null, opts: RunOpts = {}): Promise<DigestData> {
  const now = opts.now ?? (() => new Date().toISOString());
  const view = await dashboard(store, user.id, user.tz, profile, { now });
  const today = view.today;
  const days = await store.listProgramDays(user.id);
  const d = days.filter(x => x.dayDate === today).sort((a, b) => (a.status === 'planned' ? 1 : 0) - (b.status === 'planned' ? 1 : 0))[0] ?? null;
  const cards = await store.listCards(user.id);
  const todayCell = view.week.find(w => w.today);
  return {
    today, day: d ? publicDay(d, today) : null, programExists: days.length > 0,
    todayDone: todayCell?.status === 'done', dueCards: cards.filter(c => dueForReview(c, today)).length, view,
  };
}

const blankProfile = (userId: string, now: string): Profile => ({
  userId, specialty: null, industry: null, years: null, targetRole: null, keywords: [], summary: null, resumeText: null, resumeName: null, resumeAt: null,
  interviewDate: null, interviewFormat: null, minutesPerDay: null, nativeLanguage: null, onboardedAt: null, targetLevel: null, weeklyGoalMinutes: null, notifyAt: null, digestSentOn: null, updatedAt: now,
});

/** Собрать письмо для пользователя (предпросмотр и отправка). */
export async function buildDigest(env: Pick<DigestEnv, 'APP_NAME' | 'APP_URL'>, store: ContentStore, user: User, profile: Profile | null, opts: RunOpts = {}): Promise<{ mail: DigestMail; data: DigestData }> {
  const now = opts.now ?? (() => new Date().toISOString());
  const p = profile ?? blankProfile(user.id, now());
  const data = await collectDigest(store, user, p, opts);
  return { mail: renderDigest(data, user, p, env), data };
}

export interface SendOutcome { result: SendResult; subject: string; sentOn: string }

/** Отправить письмо сейчас, вне расписания (кнопка «Прислать сейчас»): день отмечается, если письмо ушло. */
export async function sendDigestNow(env: DigestEnv, store: Store, user: User, profile: Profile | null, opts: RunOpts = {}): Promise<SendOutcome> {
  const now = opts.now ?? (() => new Date().toISOString());
  const { mail } = await buildDigest(env, store, user, profile, opts);
  const result = await sendMail(env, user.email, mail, opts.fetchFn);
  const sentOn = localClock(user.tz, new Date(now())).date;
  if (result.sent) await store.markDigest(user.id, sentOn, now(), 'sent:manual', now());
  return { result, subject: mail.subject, sentOn };
}

export interface RunReport {
  at: string;
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
  /** По пользователям — без адресов, только id и исход. */
  users: { userId: string; state: DigestState; note: string | null }[];
}

/** Один проход расписания: кому пора — отправить и отметить день; кому поздно — отметить пропуск; остальных не трогать. */
export async function runDigest(env: DigestEnv, store: Store, opts: RunOpts = {}): Promise<RunReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const at = now();
  const report: RunReport = { at, checked: 0, sent: 0, skipped: 0, failed: 0, users: [] };
  for (const { user, profile } of await store.listDigestUsers()) {
    report.checked++;
    const s = digestState(profile, user.tz, new Date(at));
    let note: string | null = null;
    if (s.state === 'due') {
      try {
        const { mail } = await buildDigest(env, store, user, profile, { ...opts, now });
        const r = await sendMail(env, user.email, mail, opts.fetchFn);
        if (r.sent) { note = 'sent'; report.sent++; await store.markDigest(user.id, s.date, now(), note, now()); }
        else if (r.reason === 'not_configured') { note = 'skipped:mail_not_configured'; report.skipped++; await store.markDigest(user.id, s.date, null, note, now()); }
        else { note = `error:${(r.detail ?? r.reason).slice(0, 200)}`; report.failed++; await store.markDigest(user.id, s.date, null, note, now()).catch(() => {}); }
      } catch (e) {
        note = `error:${String(e instanceof Error ? e.message : e).slice(0, 200)}`; report.failed++;
        await store.markDigest(user.id, s.date, null, note, now()).catch(() => {});
      }
    } else if (s.state === 'late') {
      note = 'skipped:late'; report.skipped++;
      await store.markDigest(user.id, s.date, null, note, now());
    }
    report.users.push({ userId: user.id, state: s.state, note });
  }
  return report;
}

// ---------- хранилище D1 ----------

export function d1DigestStore(db: D1Database): DigestStore {
  return {
    async listDigestUsers() {
      const rows = await db.prepare(
        `SELECT u.id AS u_id, u.email AS u_email, u.name AS u_name, u.locale AS u_locale, u.tz AS u_tz, p.*
         FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.notify_at IS NOT NULL AND p.notify_at <> '' ORDER BY u.id`,
      ).all();
      return (rows.results ?? []).map((r: any) => {
        let keywords: string[] = [];
        try { const k = JSON.parse(r.keywords ?? '[]'); if (Array.isArray(k)) keywords = k.filter((x: unknown) => typeof x === 'string'); } catch { /* пусто */ }
        const user: User = { id: r.u_id, email: r.u_email, name: r.u_name ?? null, locale: r.u_locale ?? 'ru', tz: r.u_tz ?? 'UTC' };
        const profile: Profile = {
          userId: r.user_id, specialty: r.specialty ?? null, industry: r.industry ?? null, years: r.years ?? null, targetRole: r.target_role ?? null, keywords,
          summary: r.summary ?? null, resumeText: r.resume_text ?? null, resumeName: r.resume_name ?? null, resumeAt: r.resume_at ?? null,
          interviewDate: r.interview_date ?? null, interviewFormat: r.interview_format ?? null, minutesPerDay: r.minutes_per_day ?? null,
          nativeLanguage: r.native_language ?? null, onboardedAt: r.onboarded_at ?? null, targetLevel: r.target_level ?? null,
          weeklyGoalMinutes: r.weekly_goal_minutes == null ? null : Number(r.weekly_goal_minutes),
          notifyAt: r.notify_at ?? null, digestSentOn: r.digest_sent_on ?? null, updatedAt: r.updated_at,
        };
        return { user, profile };
      });
    },
    async saveNotifyAt(userId, notifyAt, sentOn, nowIso) {
      await db.prepare(
        `INSERT INTO profiles (user_id, notify_at, digest_sent_on, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET notify_at = excluded.notify_at,
         digest_sent_on = CASE WHEN excluded.digest_sent_on IS NULL THEN profiles.digest_sent_on ELSE excluded.digest_sent_on END,
         updated_at = excluded.updated_at`,
      ).bind(userId, notifyAt, sentOn, nowIso).run();
    },
    async markDigest(userId, sentOn, sentAt, note, nowIso) {
      await db.prepare(
        `INSERT INTO profiles (user_id, digest_sent_on, digest_sent_at, digest_note, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET digest_sent_on = excluded.digest_sent_on, digest_sent_at = COALESCE(excluded.digest_sent_at, profiles.digest_sent_at),
         digest_note = excluded.digest_note, updated_at = excluded.updated_at`,
      ).bind(userId, sentOn, sentAt, note, nowIso).run();
    },
  };
}
