/** Collapse whitespace and strip the non-breaking spaces CMS exports are full of. */
export function clean(input: string | null | undefined): string {
  return (input ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripHtml(input: string | null | undefined): string {
  return clean(
    (input ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function truncate(input: string, max = 320): string {
  const text = clean(input);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pull street addresses out of a title or summary.
 *
 * Land-use notices are legally required to identify the location, so this is
 * high-yield exactly where it matters most. Conservative on purpose: a missed
 * address is better than a wrong one, since these become subject links.
 */
const STREET_TYPES =
  'St|Street|Rd|Road|Ave|Avenue|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Ter|Terrace|Blvd|Boulevard|Cir|Circle|Hwy|Highway|Pkwy|Parkway|Sq|Square|Row|Path';

const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,5}(?:-\d{1,5})?[A-Z]?)\s+((?:[A-Z][\w'’.-]*\s+){0,3}?)(${STREET_TYPES})\b\.?`,
  'g',
);

export function extractAddresses(text: string): string[] {
  const found = new Set<string>();
  for (const match of clean(text).matchAll(ADDRESS_RE)) {
    const [, number, words, type] = match;
    const name = clean(words);
    if (!name) continue;
    found.add(clean(`${number} ${name} ${type}`).replace(/\.$/, ''));
  }
  return [...found];
}

/** Warrant article references, e.g. "Article 12". */
export function extractArticles(text: string): string[] {
  const found = new Set<string>();
  for (const match of clean(text).matchAll(/\bArticle\s+(\d{1,3})\b/gi)) {
    found.add(`Article ${match[1]}`);
  }
  return [...found];
}

export function extractSubjects(text: string): string[] {
  return [...new Set([...extractAddresses(text), ...extractArticles(text)])];
}
