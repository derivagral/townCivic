import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * PDF text and form extraction, built on Mozilla's pdf.js (Apache-2.0).
 *
 * Pure JavaScript, no native dependency and no external service. That is not
 * just a licensing preference — a survey of Milton's Agenda Center covering
 * 2017 to 2026 found no scanned documents at all, so every file has a real text
 * layer and OCR never enters the picture.
 *
 * Three document shapes turn up, and all three are handled here:
 *
 *   1. AcroForm meeting notices (agendas since roughly 2021). The town clerk
 *      files a fillable template, so the board, date, time, location, posting
 *      timestamp and the agenda itself arrive as *named form fields*. This is
 *      structured data, not prose — no model required to read it.
 *   2. Plain-text PDFs (minutes, and agendas before the template). Text stream
 *      only; the structure has to be inferred from the text.
 *   3. Some older Agenda Center links serve HTML rather than a PDF.
 */

export interface PdfExtraction {
  pages: number;
  /** Page text, joined with blank lines between pages. */
  text: string;
  /** AcroForm field values, keyed by field name. Empty for a plain PDF. */
  fields: Record<string, string>;
  /**
   * True when the text layer is so thin the document is probably images.
   * Nothing in Milton's archive currently trips this, but a town that scans
   * its minutes would, and silently returning empty text would be worse.
   */
  likelyScanned: boolean;
  charsPerPage: number;
  /** Page-level evidence used to decide where an OCR fallback is worthwhile. */
  pageStats: PdfPageStat[];
}

export interface PdfPageStat {
  page: number;
  chars: number;
  images: number;
  /** Thin text plus at least one raster image: likely an image of a page. */
  needsOcr: boolean;
}

/** Below this, a page is not carrying real text. */
const SCANNED_CHARS_PER_PAGE = 100;

const IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
]);

/**
 * Where pdf.js should find the Foxit substitutes for the 14 standard PDF fonts,
 * and the character maps for non-Latin encodings.
 *
 * Both ship inside `pdfjs-dist`. Without them every notice logs a wall of
 * "Ensure that the `standardFontDataUrl` API parameter is provided" — one line
 * per font per document, which buried the actual progress output — and text set
 * in a standard font can extract with the wrong glyph widths.
 *
 * Resolved from the installed package rather than hard-coded, so it keeps
 * working under npm, pnpm and a hoisted or nested `node_modules`.
 */
function assetUrls(): { standardFontDataUrl: string; cMapUrl: string } {
  const packageJson = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
  const root = path.dirname(packageJson);
  // pdf.js joins these with a filename, so each needs its trailing separator.
  return {
    standardFontDataUrl: `${pathToFileURL(path.join(root, 'standard_fonts')).href}/`,
    cMapUrl: `${pathToFileURL(path.join(root, 'cmaps')).href}/`,
  };
}

const ASSETS = assetUrls();

/**
 * pdf.js verbosity: 0 = errors only, 1 = warnings (its default), 5 = info.
 *
 * Municipal PDFs are produced by whatever the clerk had to hand, so they
 * routinely trip cosmetic complaints — "TT: undefined function", an unsupported
 * "Hide" action — that say nothing about whether extraction worked. Real
 * failures still throw and are reported per document by the extract stage.
 */
const VERBOSITY_ERRORS = 0;

function fieldValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  const doc = await getDocument({
    // pdf.js takes ownership of the buffer it is handed and detaches it, which
    // silently turns the caller's bytes into a zero-length array. Hand it a copy
    // so callers can still hash, store or re-read the original afterwards.
    data: new Uint8Array(bytes),
    // Node has no DOM; keep pdf.js from reaching for one or eval'ing anything.
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    standardFontDataUrl: ASSETS.standardFontDataUrl,
    cMapUrl: ASSETS.cMapUrl,
    cMapPacked: true,
    verbosity: VERBOSITY_ERRORS,
  }).promise;

  try {
    const pageTexts: string[] = [];
    const pageStats: PdfPageStat[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const [content, operators] = await Promise.all([pdfPage.getTextContent(), pdfPage.getOperatorList()]);
      // `hasEOL` is pdf.js's own line-break signal and reconstructs lines far
      // better than guessing from item coordinates.
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      pageTexts.push(text);
      const chars = text.replace(/\s/g, '').length;
      const images = operators.fnArray.filter((operator) => IMAGE_OPERATORS.has(operator)).length;
      pageStats.push({
        page,
        chars,
        images,
        needsOcr: chars < SCANNED_CHARS_PER_PAGE && images > 0,
      });
    }

    const fields: Record<string, string> = {};
    const fieldObjects = await doc.getFieldObjects();
    for (const [name, objects] of Object.entries(fieldObjects ?? {})) {
      for (const object of objects as { value?: unknown; type?: string }[]) {
        // Unchecked buttons report "Off"; that is not content.
        const value = fieldValue(object.value).trim();
        if (!value || (object.type === 'button' && value === 'Off')) continue;
        fields[name] = value;
        break;
      }
    }

    const text = pageTexts.join('\n\n');
    const totalChars = pageStats.reduce((sum, page) => sum + page.chars, 0);
    const density = totalChars / Math.max(1, doc.numPages);

    return {
      pages: doc.numPages,
      text,
      fields,
      // Unlike a document-wide average, this catches a scanned body behind a
      // digital cover page. Blank pages do not trip it because they have no
      // raster image to OCR.
      likelyScanned: pageStats.some((page) => page.needsOcr),
      charsPerPage: Math.round(density),
      pageStats,
    };
  } finally {
    await doc.destroy();
  }
}

/** Cheap sniff so a mislabeled response is not handed to the PDF parser. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
