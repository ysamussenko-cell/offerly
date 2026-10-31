// Собирает latest.json для релиза GitHub — формат обновлений Tauri, его же читает страница установки (functions/_lib/release.ts):
//   { "version": "0.23.0", "notes": "…", "pub_date": "2026-11-01T10:00:00Z",
//     "platforms": { "windows-x86_64": { "signature": "…", "url": "https://github.com/<repo>/releases/download/v0.23.0/Offerly_0.23.0_x64-setup.exe" } } }
// Чистые функции экспортируются для тестов (tests/desktop.test.ts); запуск из workflow:
//   node desktop/scripts/latest.mjs <каталог bundle/nsis> <куда записать latest.json> [тег]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'ysamussenko-cell/offerly';
/** Имя установщика NSIS, которое даёт Tauri при productName «Offerly»: Offerly_<версия>_x64-setup.exe. */
export const SETUP_RE = /^Offerly_(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)_x64-setup\.exe$/;
const MAX_NOTES = 2000;

/** Раздел CHANGELOG для версии: текст после заголовка «## <версия>» до следующего «## », без markdown-маркеров списка; пусто — null. */
export function changelogNotes(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^##\\s+${version.replace(/[.+-]/g, '\\$&')}(\\s|$)`).test(l));
  if (start < 0) return null;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    body.push(l.replace(/^\s*[-*]\s+/, '').replace(/`/g, ''));
  }
  const text = body.join('\n').trim();
  if (!text) return null;
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES - 1).trimEnd()}…` : text;
}

/** Файл установщика среди файлов каталога бандла и его подпись (<имя>.sig рядом, если сборка подписана). */
export function pickSetup(files) {
  const names = files.map(f => (typeof f === 'string' ? f : f.name));
  const setup = names.find(n => SETUP_RE.test(n));
  if (!setup) return null;
  const sigName = `${setup}.sig`;
  return { name: setup, version: setup.match(SETUP_RE)[1], sigName: names.includes(sigName) ? sigName : null };
}

/** Сам latest.json. tag — тег релиза (по умолчанию v<версия>); signature — содержимое .sig или пустая строка (неподписанная сборка). */
export function buildLatest({ version, notes, pubDate, setupName, signature, tag = `v${version}`, repo = REPO }) {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`версия не похожа на semver: ${version}`);
  if (!SETUP_RE.test(setupName)) throw new Error(`имя установщика не по шаблону Offerly_<версия>_x64-setup.exe: ${setupName}`);
  const fileVersion = setupName.match(SETUP_RE)[1];
  if (fileVersion !== version) throw new Error(`версия установщика ${fileVersion} не равна версии проекта ${version}`);
  return {
    version,
    notes: notes ?? `Offerly ${version} для Windows.`,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': { signature: signature ?? '', url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(setupName)}` },
    },
  };
}

/** Строка для аннотации workflow. */
export const describe = (latest) => `latest.json: версия ${latest.version}, ${latest.platforms['windows-x86_64'].signature ? 'подписан' : 'без подписи'}, ${latest.platforms['windows-x86_64'].url}`;

function main(argv) {
  const [bundleDir, outFile, tagArg] = argv;
  if (!bundleDir || !outFile) { console.error('использование: node latest.mjs <каталог nsis> <latest.json> [тег]'); process.exit(2); }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const conf = JSON.parse(readFileSync(join(root, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const files = readdirSync(bundleDir);
  const setup = pickSetup(files);
  if (!setup) { console.error(`::error title=desktop::в ${bundleDir} нет Offerly_<версия>_x64-setup.exe, есть: ${files.join(', ') || 'ничего'}`); process.exit(1); }
  const changelog = existsSync(join(root, 'CHANGELOG.md')) ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8') : '';
  const latest = buildLatest({
    version: conf.version,
    notes: changelogNotes(changelog, conf.version),
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    setupName: setup.name,
    signature: setup.sigName ? readFileSync(join(bundleDir, setup.sigName), 'utf8').trim() : '',
    tag: tagArg || `v${conf.version}`,
  });
  writeFileSync(outFile, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`::notice title=latest.json::${describe(latest)}`);
  console.log(`setup=${setup.name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
