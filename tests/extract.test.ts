import { describe, it, expect } from 'vitest';
import { extractResumeText, detectKind, normalizeText, docxXmlToText, decodeXmlEntities, readZipDirectory, MAX_FILE_BYTES } from '../functions/_lib/extract';
import { makeDocx, makePdf, makeZip, SAMPLE_RESUME } from './helpers/fixtures';

const enc = (s: string) => new TextEncoder().encode(s);

describe('определение типа файла', () => {
  it('по сигнатуре, а не по имени', () => {
    expect(detectKind('cv.bin', undefined, enc('%PDF-1.7 ...'))).toBe('pdf');
    expect(detectKind('cv.pdf', 'application/pdf', makeDocx(['x']))).toBe('docx');
    expect(detectKind('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', makeDocx(['x']))).toBe('docx');
    expect(detectKind('cv.txt', 'text/plain', enc('Hello'))).toBe('text');
    expect(detectKind('cv', undefined, enc('Просто текст резюме'))).toBe('text');
    expect(detectKind('cv.exe', 'application/octet-stream', new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('нормализация текста', () => {
  it('убирает лишние пробелы и пустые строки', () => {
    expect(normalizeText('a  \t b\r\n\r\n\r\n\r\nc   d  \n')).toBe('a b\n\nc d');
  });
});

describe('DOCX', () => {
  it('читает абзацы из deflate-архива', async () => {
    const r = await extractResumeText('resume.docx', undefined, makeDocx(SAMPLE_RESUME, 8));
    expect(r.kind).toBe('docx');
    expect(r.text.split('\n')).toEqual(SAMPLE_RESUME);
  });
  it('читает абзацы из архива без сжатия', async () => {
    const r = await extractResumeText('resume.docx', undefined, makeDocx(SAMPLE_RESUME, 0));
    expect(r.text.split('\n')).toEqual(SAMPLE_RESUME);
  });
  it('таблицы, табуляции, разрывы и сущности', () => {
    const xml = '<w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Skill</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Level &amp; years</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>&#1057;&#x42;</w:t></w:r></w:p></w:body>';
    expect(docxXmlToText(xml)).toBe('Skill\n\tLevel & years\n\t\nA\tB\nСB\n');
    expect(decodeXmlEntities('&lt;b&gt; &quot;q&quot; &apos;a&apos; &unknown;')).toBe('<b> "q" \'a\' &unknown;');
  });
  it('zip без word/document.xml — неподдерживаемый формат', async () => {
    const zip = makeZip({ 'mimetype': 'application/vnd.oasis.opendocument.text', 'content.xml': '<x/>' });
    await expect(extractResumeText('cv.odt', undefined, zip)).rejects.toMatchObject({ code: 'resume_unsupported' });
  });
  it('оглавление архива читается полностью', () => {
    const entries = readZipDirectory(makeZip({ 'a.txt': 'aaa', 'dir/b.txt': 'bbb' }, 0));
    expect(entries.map(e => e.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(entries[1].size).toBe(3);
  });
});

describe('PDF', () => {
  it('извлекает текст построчно', async () => {
    const r = await extractResumeText('resume.pdf', 'application/pdf', makePdf(SAMPLE_RESUME));
    expect(r.kind).toBe('pdf');
    expect(r.pages).toBe(1);
    for (const line of SAMPLE_RESUME) expect(r.text).toContain(line);
  });
  it('PDF без текстового слоя — resume_no_text', async () => {
    await expect(extractResumeText('scan.pdf', undefined, makePdf([]))).rejects.toMatchObject({ code: 'resume_no_text' });
  });
  it('битый PDF — resume_unreadable', async () => {
    await expect(extractResumeText('x.pdf', undefined, enc('%PDF-1.4 garbage without objects'))).rejects.toMatchObject({ code: 'resume_unreadable' });
  });
});

describe('обычный текст и ограничения', () => {
  it('принимает txt', async () => {
    const r = await extractResumeText('cv.txt', 'text/plain', enc(SAMPLE_RESUME.join('\n')));
    expect(r.kind).toBe('text');
    expect(r.text).toBe(SAMPLE_RESUME.join('\n'));
  });
  it('короткий текст — resume_too_short', async () => {
    await expect(extractResumeText('cv.txt', 'text/plain', enc('Инженер'))).rejects.toMatchObject({ code: 'resume_too_short' });
  });
  it('слишком большой файл — resume_too_large', async () => {
    await expect(extractResumeText('cv.txt', 'text/plain', new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ code: 'resume_too_large' });
  });
  it('двоичный мусор — resume_unsupported', async () => {
    const junk = new Uint8Array(500); for (let i = 0; i < junk.length; i++) junk[i] = i % 7;
    await expect(extractResumeText('cv.dat', undefined, junk)).rejects.toMatchObject({ code: 'resume_unsupported' });
  });
});
