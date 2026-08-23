import { createHash } from 'node:crypto';
import { clean } from '../util/text.ts';

/**
 * What makes two records the same matter.
 *
 * The town publishes no case number. A CivicPlus file id (`_09142026-7480`)
 * identifies a *document*, and Milton's notice template has no docket field, so
 * there is no identifier in the source data that says "these four meetings are
 * about the same house". The only handle is the subject string the extractor
 * already pulls out of the notice — "39 Frothingham Street", "Article 14".
 *
 * So the linking step is a normalization, not a clustering algorithm. That is a
 * deliberate choice, and the same one the rest of the pipeline makes: a
 * canonical key is reproducible, explainable in one sitting, and wrong in ways
 * a person can see. Fuzzy matching would quietly merge "14 Adams Street" with
 * "40 Adams Street" and there would be no way to tell from the output that it
 * had happened.
 *
 * The cost is the opposite failure: two spellings that a human would call the
 * same matter stay apart. That is the failure we want — a missing link is
 * visible as a short timeline, an invented one is invisible.
 */

export const MATTER_KINDS = ['address', 'article', 'bid'] as const;
export type MatterKind = (typeof MATTER_KINDS)[number];

export const MATTER_KIND_LABELS: Record<MatterKind, string> = {
  address: 'Property',
  article: 'Warrant article',
  bid: 'Procurement',
};

/**
 * Street-type abbreviations, expanded so "39 Frothingham St" and
 * "39 Frothingham Street" are one matter. Only unambiguous ones: `Dr` is
 * Drive here, which is safe on a street line and would not be elsewhere.
 */
const STREET_ABBREVIATIONS: Record<string, string> = {
  st: 'street',
  str: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  ln: 'lane',
  dr: 'drive',
  ct: 'court',
  pl: 'place',
  ter: 'terrace',
  terr: 'terrace',
  blvd: 'boulevard',
  cir: 'circle',
  hwy: 'highway',
  pkwy: 'parkway',
  sq: 'square',
};

/**
 * Directionals and unit suffixes are dropped from the key but kept in the
 * label: "39A Frothingham Street" and "39 Frothingham Street" are the same
 * parcel often enough, and splitting them produces two one-record timelines
 * where the town clearly meant one thing.
 */
export function normalizeAddress(input: string): string {
  const words = clean(input).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');

  return words
    .map((word, index) => {
      // The house number keeps only its leading digits: "39a" → "39".
      if (index === 0) return /^\d/.test(word) ? (/^\d+/.exec(word)?.[0] ?? word) : word;
      return STREET_ABBREVIATIONS[word] ?? word;
    })
    .join(' ')
    .trim();
}

/**
 * Warrant articles are numbered per Town Meeting session, so "Article 14" in
 * the fall warrant is a different thing from "Article 14" the following spring.
 * Without a session identifier in the source, the year of the record is the
 * best available scope — it stops a decade of Article 4s collapsing into one
 * timeline. Two Town Meetings inside one year still merge; that is a known
 * limitation, visible as a timeline that changes subject halfway through.
 */
export function normalizeArticle(input: string, year: number | null): string {
  const number = /(\d{1,3})/.exec(input)?.[1] ?? clean(input).toLowerCase();
  return year ? `${year}:${number}` : `unknown:${number}`;
}

/**
 * Bid and RFP numbers as the town prints them.
 *
 * Two shapes, because Milton uses both: a recognisable procurement prefix
 * ("RFP26-14"), and a departmental one that only the "Bid No." label identifies
 * as a bid at all ("Bid No. SB26-9"). Matching bare `XX00-0` without that label
 * would pull in phone extensions, statute cites and dates, so the label is
 * required whenever the prefix is not a known procurement one.
 */
const BID_PATTERNS = [
  /\b(RFP|IFB|BID|ITB)[\s-]?(\d{2})[\s-](\d{1,4})\b/gi,
  /\bBid\s*(?:No|Number)\.?[:\s]*([A-Z]{2,4})[\s-]?(\d{2})[\s-](\d{1,4})\b/gi,
];

/**
 * Bid numbers in `text`.
 *
 * `known` is a vocabulary of numbers already confirmed somewhere that labelled
 * them, and those are additionally matched bare. This is what closes the loop
 * that matters most in procurement: the posting says "Bid No. SB26-9", and
 * months later a Select Board agenda says only "award of contract, SB26-9".
 * Matching bare `XX00-0` unconditionally would sweep in fiscal-year codes and
 * statute cites, but matching a string the town has already published as a bid
 * number is safe, because the town is the one that defined the vocabulary.
 */
export function extractBidNumbers(text: string, known: Iterable<string> = []): string[] {
  const found = new Set<string>();
  const flat = clean(text);

  for (const pattern of BID_PATTERNS) {
    for (const match of flat.matchAll(pattern)) {
      found.add(`${match[1]!.toUpperCase()}${match[2]}-${Number(match[3])}`);
    }
  }

  for (const number of known) {
    // Tolerate the spacing drifting between the posting and the agenda.
    const parts = /^([A-Z]{2,4})(\d{2})-(\d{1,4})$/i.exec(number);
    if (!parts) continue;
    const loose = new RegExp(`\\b${parts[1]}[\\s-]?${parts[2]}[\\s-]${parts[3]}\\b`, 'i');
    if (loose.test(flat)) found.add(number.toUpperCase());
  }

  return [...found];
}

export interface MatterRef {
  kind: MatterKind;
  key: string;
  label: string;
}

/**
 * A bid number that `extractBidNumbers` has already vouched for.
 *
 * Kept separate from `matterRef` because a departmental number like "SB26-9"
 * only reads as a bid in the context that produced it — the "Bid No." label —
 * and by the time it reaches here that context is gone.
 */
export function bidRef(number: string): MatterRef {
  const label = number.toUpperCase();
  return { kind: 'bid', key: label.toLowerCase(), label };
}

/** True when a subject string looks like a street address rather than an article. */
export function isAddressSubject(subject: string): boolean {
  return /^\d/.test(clean(subject));
}

/**
 * Turn one subject string into a matter reference, or null when it is not
 * something we are willing to key on.
 *
 * `year` scopes warrant articles; pass the calendar year of the record.
 */
export function matterRef(subject: string, year: number | null): MatterRef | null {
  const text = clean(subject);
  if (!text) return null;

  if (/^article\b/i.test(text)) {
    const key = normalizeArticle(text, year);
    const number = key.split(':')[1];
    return { kind: 'article', key, label: year ? `Article ${number} (${year})` : `Article ${number}` };
  }

  if (/^[A-Z]{2,4}[\s-]?\d{2}[\s-]\d{1,4}$/i.test(text)) return bidRef(text);

  if (isAddressSubject(text)) {
    const key = normalizeAddress(text);
    // A bare number is not an address.
    return key.includes(' ') ? { kind: 'address', key, label: text } : null;
  }

  return null;
}

export function matterId(jurisdiction: string, kind: MatterKind, key: string): string {
  return createHash('sha256').update(`${jurisdiction}|${kind}|${key}`).digest('hex').slice(0, 32);
}

/**
 * Pick the label to show for a matter seen under several spellings.
 *
 * Prefer the longest, then the one with the most capital letters — "39
 * Frothingham Street" over "39 frothingham st" — because these end up as page
 * headings.
 */
export function bestLabel(labels: string[]): string {
  return [...labels].sort((a, b) => {
    const byLength = b.length - a.length;
    if (byLength !== 0) return byLength;
    const caps = (s: string) => (s.match(/[A-Z]/g) ?? []).length;
    return caps(b) - caps(a);
  })[0]!;
}
