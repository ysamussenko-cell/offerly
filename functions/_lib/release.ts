/**
 * Релиз десктопной сборки (5.1 «Страница установки»): где лежит установщик для Windows.
 *
 * Источник один — файл latest.json последнего релиза GitHub (его же читает автообновление Tauri в 5.2):
 *   { "version": "0.22.0", "notes": "…", "pub_date": "2026-11-01T10:00:00Z",
 *     "platforms": { "windows-x86_64": { "signature": "…", "url": "https://github.com/…/Offerly_0.22.0_x64-setup.exe" } } }
 * Пока релизов нет, GitHub отвечает 404 — страница честно говорит, что установщик готовится, и предлагает PWA.
 * Ответ GitHub кэшируется на краю Cloudflare (cf.cacheTtl), чтобы страница установки не ходила на GitHub каждый раз.
 */

export const REPO = 'ysamussenko-cell/offerly';
export const LATEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** Сколько секунд держать ответ GitHub в кэше края и в кэше браузера. */
export const CACHE_SECONDS = 600;
/** Предел размера latest.json — защита от неожиданного тела. */
const MAX_BODY = 64 * 1024;

export interface ReleaseEnv {
  /** Переопределение адреса latest.json (тесты, свой канал раздачи). */
  RELEASE_URL?: string;
}

export type WindowsAsset = { url: string; name: string; signed: boolean };

/** Разобранный latest.json: версия, дата, заметки и установщик для Windows. */
export type ParsedRelease = { version: string; publishedAt: string | null; notes: string | null; windows: WindowsAsset | null };

export type Release =
  | { available: true; version: string; publishedAt: string | null; notes: string | null; windows: WindowsAsset; releasesUrl: string; source: string }
  | { available: false; reason: 'none' | 'no_windows' | 'error'; detail: string | null; releasesUrl: string; source: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Имя файла из адреса: последний сегмент пути, раскодированный; пустой — null. */
export function fileNameOf(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const name = decodeURIComponent(last);
    return name || null;
  } catch { return null; }
}

/** Ключи platforms Tauri для Windows: windows-x86_64, windows-x86_64-nsis, windows-aarch64 … — x86_64 предпочтительнее. */
function pickWindows(platforms: Record<string, unknown>): { key: string; entry: Record<string, unknown> } | null {
  const keys = Object.keys(platforms).filter(k => k.startsWith('windows-') && isObj(platforms[k]) && typeof (platforms[k] as Record<string, unknown>).url === 'string');
  if (keys.length === 0) return null;
  const order = (k: string) => (k.includes('x86_64') ? 0 : k.includes('x64') ? 1 : 2) * 10 + (k.includes('nsis') ? 0 : k.includes('msi') ? 1 : 2);
  keys.sort((a, b) => order(a) - order(b));
  return { key: keys[0], entry: platforms[keys[0]] as Record<string, unknown> };
}

/** Разбирает latest.json. Мусор, не-объект, пустая версия → null. Без сборки для Windows — windows: null (релиз есть, установщика нет). */
export function parseLatest(json: unknown): ParsedRelease | null {
  if (!isObj(json)) return null;
  const rawVersion = typeof json.version === 'string' ? json.version.trim() : '';
  if (!VERSION_RE.test(rawVersion)) return null;
  const version = rawVersion.replace(/^v/, '');
  const pub = typeof json.pub_date === 'string' ? json.pub_date : typeof json.publishedAt === 'string' ? json.publishedAt : null;
  const publishedAt = pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
  const notesRaw = typeof json.notes === 'string' ? json.notes.trim() : '';
  const notes = notesRaw ? notesRaw.slice(0, 2000) : null;
  let windows: WindowsAsset | null = null;
  if (isObj(json.platforms)) {
    const w = pickWindows(json.platforms);
    if (w) {
      const url = String(w.entry.url);
      if (/^https:\/\//.test(url)) windows = { url, name: fileNameOf(url) ?? `Offerly_${version}_x64-setup.exe`, signed: typeof w.entry.signature === 'string' && w.entry.signature.length > 0 };
    }
  }
  return { version, publishedAt, notes, windows };
}

/** Адрес latest.json: из окружения или GitHub Releases. */
export const latestUrl = (env: Pick<ReleaseEnv, 'RELEASE_URL'>) => (env.RELEASE_URL && /^https?:\/\//.test(env.RELEASE_URL) ? env.RELEASE_URL : LATEST_URL);

/**
 * Читает latest.json и собирает ответ для страницы установки. Никогда не бросает: сбой сети и странный ответ — available:false, reason:'error'.
 * 404 — релизов ещё нет (reason 'none'); релиз без сборки для Windows — 'no_windows'.
 */
export async function fetchRelease(env: Pick<ReleaseEnv, 'RELEASE_URL'>, fetcher: typeof fetch = fetch): Promise<Release> {
  const source = latestUrl(env);
  const base = { releasesUrl: RELEASES_URL, source };
  let r: Response;
  try {
    r = await fetcher(source, {
      headers: { accept: 'application/json', 'user-agent': 'Offerly install page' },
      redirect: 'follow',
      // Кэш на краю Cloudflare: GitHub не дёргается чаще, чем раз в CACHE_SECONDS, даже при частых открытиях страницы.
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    } as RequestInit);
  } catch (e) {
    return { available: false, reason: 'error', detail: `network: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`, ...base };
  }
  if (r.status === 404) return { available: false, reason: 'none', detail: null, ...base };
  if (!r.ok) return { available: false, reason: 'error', detail: `HTTP ${r.status}`, ...base };
  let parsed: ParsedRelease | null;
  try {
    const text = await r.text();
    if (text.length > MAX_BODY) return { available: false, reason: 'error', detail: 'latest.json слишком большой', ...base };
    parsed = parseLatest(JSON.parse(text));
  } catch (e) {
    return { available: false, reason: 'error', detail: `latest.json не разобран: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`, ...base };
  }
  if (!parsed) return { available: false, reason: 'error', detail: 'latest.json без версии', ...base };
  if (!parsed.windows) return { available: false, reason: 'no_windows', detail: `версия ${parsed.version} без сборки для Windows`, ...base };
  return { available: true, version: parsed.version, publishedAt: parsed.publishedAt, notes: parsed.notes, windows: parsed.windows, ...base };
}
