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

/**
 * Convert a wall-clock time in the town's timezone to a UTC instant.
 *
 * Municipal documents write local time with no offset ("7:00 PM", "02:55 pm"),
 * and the difference between EST and EDT is the difference between a notice
 * being timely and not. Rather than take a dependency for this, the offset is
 * measured for the instant in question: interpret the wall time as if it were
 * UTC, ask what that instant looks like in the zone, and correct by the gap.
 *
 * The second pass matters — the first correction can cross a DST boundary.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  timeZone = TIMEZONE,
): string {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let pass = 0; pass < 2; pass++) {
    guess = target + (guess - zoneWallClock(guess, timeZone));
  }
  return new Date(guess).toISOString();
}

/** What `instant` reads as on a wall clock in `timeZone`, as a UTC-based epoch. */
function zoneWallClock(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl renders midnight as hour 24 in some locales/zones.
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

/** Parse a clock time like "7:00 PM", "7 pm", "08:30". Returns null if absent. */
export function parseClockTime(input: string): { hour: number; minute: number } | null {
  const match = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(input);
  if (match) {
    let hour = Number(match[1]) % 12;
    if (match[3]!.toLowerCase() === 'p') hour += 12;
    return { hour, minute: Number(match[2] ?? 0) };
  }
  const military = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(input);
  if (military) return { hour: Number(military[1]), minute: Number(military[2]) };
  return null;
}

/**
 * Parse a date and an optional separate time into a single instant, both read
 * as town-local. Falls back to the date alone when the time is unusable.
 */
export function parseLocalDateTime(dateText: string, timeText = '', timeZone = TIMEZONE): string | null {
  const dateIso = parseLooseDate(dateText);
  if (!dateIso) return null;

  const clock = parseClockTime(timeText || dateText);
  if (!clock) return dateIso;

  const date = new Date(dateIso);
  return zonedToUtc(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    clock.hour,
    clock.minute,
    timeZone,
  );
}

/** Parse the clerk's posting stamp, e.g. "08/17/2026 02:55 pm". */
export function parsePostingStamp(input: string, timeZone = TIMEZONE): string | null {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(input);
  if (!match) return parseLocalDateTime(input, input, timeZone);
  const clock = parseClockTime(input);
  return zonedToUtc(
    Number(match[3]),
    Number(match[1]),
    Number(match[2]),
    clock?.hour ?? 12,
    clock?.minute ?? 0,
    timeZone,
  );
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

/**
 * Whether a timestamp carries a real clock time or is a date anchored at noon
 * UTC by `dateOnlyToIso`. Lets the UI show "7:00 PM" only when it is known,
 * rather than inventing a meeting time of 8am for every undated listing row.
 */
export function hasRealTime(iso: string | null): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return !(
    date.getUTCHours() === 12 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export function relativeDays(iso: string, now = new Date()): number {
  const then = new Date(iso).getTime();
  return Math.round((then - now.getTime()) / 86_400_000);
}
