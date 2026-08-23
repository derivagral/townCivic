export const TIMEZONE = 'America/New_York';

/**
 * Turn a calendar date with no time into an ISO instant.
 *
 * Municipal listings give dates like "09/09/2025" with no clock time. We anchor
 * them at noon UTC so the calendar day is the same whether it is rendered in
 * UTC or Eastern — midnight would slide a meeting to the previous day.
 */
export function dateOnlyToIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
}

/** Parse the MMDDYYYY stamp CivicPlus embeds in agenda and minutes file URLs. */
export function parseCivicPlusStamp(stamp: string): string | null {
  const match = /^(\d{2})(\d{2})(\d{4})$/.exec(stamp);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return dateOnlyToIso(year, month, day);
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Best-effort date extraction from listing text.
 *
 * Handles "September 9, 2025", "Sep 9 2025", "9/9/2025" and "2025-09-09".
 * Returns the first hit, or null — callers treat a miss as "no date", never as
 * a guess.
 */
export function parseLooseDate(text: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return dateOnlyToIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const named = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    if (month) return dateOnlyToIso(Number(named[3]), month, Number(named[2]));
  }

  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (numeric) return dateOnlyToIso(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]));

  return null;
}

/** Parse an RSS/Atom date, tolerating the malformed stamps CMSes emit. */
export function parseFeedDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value.trim());
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return parseLooseDate(value);
}

export function formatDate(iso: string | null, options: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(date);
}

/** The `YYYY-MM-DD` bucket an instant belongs to, in town-local time. */
export function dayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return parts;
}

export function formatDayHeading(dayKeyValue: string): string {
  const [y, m, d] = dayKeyValue.split('-').map(Number);
  const iso = dateOnlyToIso(y!, m!, d!);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

export function relativeDays(iso: string, now = new Date()): number {
  const then = new Date(iso).getTime();
  return Math.round((then - now.getTime()) / 86_400_000);
}
