/**
 * Generate the synthetic AcroForm meeting notice used by the extraction tests.
 *
 * Milton's real notices are fillable PDFs produced by the Town Clerk, so the
 * parser has to read AcroForm field values rather than page text. Rather than
 * commit a real public record as a test fixture, this writes a minimal PDF with
 * the same field names and shapes — small, obviously synthetic, and regenerable.
 *
 *   node fixtures/tools/make-meeting-notice.mjs
 *
 * The field names below mirror the live template exactly; if the town changes
 * its template, update these and the adapter together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'milton-ma',
  'meeting-notice.pdf',
);

/** Fields exactly as the clerk's template names them. */
const FIELDS = [
  ['BOARDCOMMITTEE', 'Milton Board of Appeals'],
  ['DATE', 'September 14, 2026'],
  ['TIME', '7:30 PM'],
  ['BUILDING', 'Milton Town Hall'],
  ['ROOM', 'Carol Blute Conference Room'],
  ['ZOOM LINK', 'https://example.invalid/j/00000000000'],
  [
    'AGENDA',
    '1. Call to Order\r\r2. Upon the Application of A. Resident at 271 Pleasant Street dated August 3, 2026, seeking a Variance to reduce the rear setback from 20 feet to 11 feet for a proposed addition. The property is in a Residence C Zoning District.\r\r3. Continued hearing, 14 Adams Street\r* site plan review\r\r4. Adjournment',
  ],
  ['PostTime', '09/04/2026 02:15 pm'],
  ['Posting Authority', 'A. Clerk'],
];

/** Escape a PDF literal string. */
const lit = (value) =>
  `(${value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r')})`;

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length; // object numbers are 1-based
};

// Reserve numbers so objects can reference each other before being written.
const catalogNum = 1;
const pagesNum = 2;
const pageNum = 3;
const fontNum = 4;
const contentNum = 5;
const fieldNums = FIELDS.map((_, index) => 6 + index);

objects.length = 5;
objects[catalogNum - 1] =
  `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm << /Fields [${fieldNums
    .map((n) => `${n} 0 R`)
    .join(' ')}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${fontNum} 0 R >> >> >> >>`;
objects[pagesNum - 1] = `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`;
objects[pageNum - 1] =
  `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ` +
  `/Resources << /Font << /Helv ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R ` +
  `/Annots [${fieldNums.map((n) => `${n} 0 R`).join(' ')}] >>`;
objects[fontNum - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

// Static page text, standing in for the printed template boilerplate.
const stream =
  'BT /Helv 12 Tf 72 720 Td (PUBLIC MEETING NOTICE - SYNTHETIC FIXTURE) Tj ' +
  'T* (OFFICE OF THE MILTON TOWN CLERK, 525 Canton Avenue) Tj ET';
objects[contentNum - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

FIELDS.forEach(([name, value], index) => {
  const y = 600 - index * 30;
  objects[fieldNums[index] - 1] =
    `<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 0 /T ${lit(name)} /V ${lit(value)} ` +
    `/Rect [72 ${y} 540 ${y + 20}] /P ${pageNum} 0 R /DA (/Helv 10 Tf 0 g) >>`;
});

let pdf = '%PDF-1.7\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets[index] = pdf.length;
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefOffset = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pdf, 'latin1');
console.log(`wrote ${OUT} (${pdf.length} bytes, ${FIELDS.length} form fields)`);
