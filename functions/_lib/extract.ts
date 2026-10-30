/** Извлечение текста резюме на Worker: PDF (pdf.js через unpdf), DOCX (zip + word/document.xml), обычный текст.
 *  Никаких внешних сервисов — файл не покидает Worker и не сохраняется в исходном виде. */

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_CHARS = 60_000;
export const MIN_TEXT_CHARS = 200;

export type ResumeKind = 'pdf' | 'docx' | 'text';

export class ExtractError extends Error {
  constructor(public code: 'resume_unsupported' | 'resume_too_large' | 'resume_unreadable' | 'resume_no_text' | 'resume_too_short') { super(code); }
}

/** Определяет тип по имени, MIME и сигнатуре. Сигнатура важнее заголовков браузера. */
export function detectKind(name: string, mime: string | undefined, bytes: Uint8Array): ResumeKind | null {
  const lower = name.toLowerCase();
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head.startsWith('%PDF')) return 'pdf';
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip && (lower.endsWith('.docx') || (mime ?? '').includes('wordprocessingml'))) return 'docx';
  if (isZip) return 'docx'; // другие zip-пакеты отбросит парсер: без word/document.xml
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || (mime ?? '').startsWith('text/')) return 'text';
  if (looksLikeText(bytes)) return 'text';
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 2048);
  if (sample.length === 0) return false;
  let bad = 0;
  for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32)) bad++;
  return bad / sample.length < 0.02;
}

/** Нормализация: единые переводы строк, схлопывание пробелов, не больше двух пустых строк подряд, обрезка. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export interface Extracted { kind: ResumeKind; text: string; pages?: number }

/** Главная точка входа: байты файла → нормализованный текст. Бросает ExtractError с кодом для API. */
export async function extractResumeText(name: string, mime: string | undefined, data: ArrayBuffer | Uint8Array): Promise<Extracted> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtractError('resume_too_large');
  const kind = detectKind(name, mime, bytes);
  if (!kind) throw new ExtractError('resume_unsupported');

  let text = '';
  let pages: number | undefined;
  try {
    if (kind === 'pdf') { const r = await extractPdf(bytes); text = r.text; pages = r.pages; }
    else if (kind === 'docx') text = await extractDocx(bytes);
    else text = new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError('resume_unreadable');
  }
  text = normalizeText(text);
  if (kind !== 'text' && text.replace(/\s/g, '').length < 20) throw new ExtractError('resume_no_text');
  if (text.length < MIN_TEXT_CHARS) throw new ExtractError('resume_too_short');
  return { kind, text, pages };
}

// --- PDF ---

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}

// --- DOCX ---

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** word/document.xml → текст: абзацы и строки таблиц переводами строк, табуляции и разрывы — как есть. */
export function docxXmlToText(xml: string): string {
  const body = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<w:cr\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(body);
}

export async function extractDocx(bytes: Uint8Array): Promise<string> {
  const entries = readZipDirectory(bytes);
  const doc = entries.find(e => e.name === 'word/document.xml');
  if (!doc) throw new ExtractError('resume_unsupported');
  const xml = new TextDecoder('utf-8').decode(await readZipEntry(bytes, doc));
  return docxXmlToText(xml);
}

// --- Минимальный ZIP-читатель (хранение и deflate, без zip64 и шифрования) ---

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number }

export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.length < minEocd) throw new ExtractError('resume_unreadable');
  let eocd = -1;
  for (let i = bytes.length - minEocd; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExtractError('resume_unreadable');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new ExtractError('resume_unreadable');
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(bytes: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e.localOffset + 30 > bytes.length || dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new ExtractError('resume_unreadable');
  const nameLen = dv.getUint16(e.localOffset + 26, true);
  const extraLen = dv.getUint16(e.localOffset + 28, true);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data);
  throw new ExtractError('resume_unreadable');
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
