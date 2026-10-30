import { deflateRawSync } from 'node:zlib';

/** Минимальный корректный PDF с одним шрифтом Helvetica и текстом построчно (без сжатия). */
export function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[()\\]/g, m => '\\' + m);
  const content = 'BT /F1 12 Tf 50 750 Td 14 TL ' + lines.map(l => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1400 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** ZIP из набора файлов: method 0 (хранение) или 8 (deflate), как пишут Word и LibreOffice. */
export function makeZip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const raw = enc.encode(content);
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(raw.length), ...u16(nameB.length), ...u16(0), ...nameB]);
    parts.push(local, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(raw.length), ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameB]));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/** DOCX из абзацев: по одному <w:p> на строку, с разбивкой на несколько <w:t> как у Word. */
export function makeDocx(paragraphs: string[], method: 0 | 8 = 8): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map(p => {
    const mid = Math.floor(p.length / 2);
    return `<w:p><w:r><w:t xml:space="preserve">${esc(p.slice(0, mid))}</w:t></w:r><w:r><w:t xml:space="preserve">${esc(p.slice(mid))}</w:t></w:r></w:p>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': xml,
  }, method);
}

export const SAMPLE_RESUME = [
  'Yuriy Samussenko - Thermal Power Engineer',
  'Almaty, Kazakhstan. 15 years in power generation: boilers, steam turbines, heat balance calculations.',
  'Led energy audits of district heating plants and industrial sites; prepared technical and economic feasibility studies.',
  'Skills: boiler efficiency, turbine performance testing, energy audit, heat loss calculation, feasibility study, Excel, Python.',
  'Recent: evaluation of AI model answers for technical accuracy, reviewer feedback in English.',
];
