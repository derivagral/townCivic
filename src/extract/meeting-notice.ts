import type { PdfExtraction } from './pdf.ts';
import { parseLocalDateTime, parsePostingStamp } from '../util/dates.ts';
import { clean, extractSubjects } from '../util/text.ts';
import { canonicalBody, isVenueAddress } from '../registry/profile.ts';
import type { JurisdictionProfile } from '../registry/profile.ts';

/**
 * Read a public meeting notice.
 *
 * The town clerk files these on a fillable template, so a modern notice is
 * genuinely structured: `BOARDCOMMITTEE`, `DATE`, `TIME`, `BUILDING`, `ROOM`,
 * `AGENDA`, `PostTime` and `Posting Authority` are named AcroForm fields. Every
 * fact below therefore comes from a labelled field, not from guessing at prose.
 *
 * Older notices and all minutes are plain PDFs. For those the same facts are
 * recovered from the template's printed labels where possible, and the body
 * text is kept either way so search still reaches the content.
 *
 * The field names come from the Commonwealth's own Open Meeting Law posting
 * template, so they are the same in every town that uses it — which is why this
 * parser is not town-specific. What *is* town-specific is which addresses are
 * municipal buildings and what a board is really called, and both of those
 * arrive on the profile rather than being imported from one town's module.
 */

export interface MeetingNotice {
  board: string | null;
  /** Meeting start, town-local time resolved to an instant. */
  meetingAt: string | null;
  /** As printed, e.g. "7:00 PM" — worth showing verbatim. */
  timeText: string | null;
  location: string | null;
  /** Agenda items, sub-bullets folded into their parent. */
  agendaItems: string[];
  /** When the clerk posted it. The Open Meeting Law 48-hour clock starts here. */
  postedAt: string | null;
  postingAuthority: string | null;
  remoteLink: string | null;
  /** Addresses and article numbers found anywhere in the notice. */
  subjects: string[];
  /** True when the facts came from form fields rather than from text. */
  structured: boolean;
}

/**
 * Field names as the template spells them, matched loosely — the clerk's
 * template has drifted over the years ("ZOOM LINK" became "MEETING LINK",
 * "PINPASSCODE" appeared alongside "PASSCODE").
 */
const FIELD_KEYS = {
  board: /^board.?committee$/i,
  date: /^date$/i,
  time: /^time$/i,
  building: /^building$/i,
  room: /^room$/i,
  postTime: /^post.?time$/i,
  authority: /^posting.?authority$/i,
  link: /^(zoom|meeting).?link$/i,
} as const;

/** A town name goes into a pattern, so anything with punctuation in it is escaped. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pick(fields: Record<string, string>, pattern: RegExp): string | null {
  for (const [key, value] of Object.entries(fields)) {
    if (pattern.test(key.trim()) && value.trim()) return clean(value);
  }
  return null;
}

/**
 * "1.", "2)" — what the clerk uses to number a top-level agenda item.
 *
 * Arabic digits only, deliberately. Roman numerals are ambiguous with the
 * lettered sub-list they usually follow: a Select Board agenda runs
 * "a. … h. … i. … j. … k.", where `i.` is the letter after `h`, not one. Since
 * Roman numerals here are always sub-items anyway, excluding them resolves the
 * ambiguity in the direction the documents actually use.
 */
const ITEM_NUMBER = /^\d{1,2}[.)]\s+/;

/** "*", "•", "-" — a bullet, whose marker is noise and gets stripped. */
const BULLET_MARKER = /^[*•\-–]\s+/;

/**
 * Split an agenda field into items.
 *
 * The template stores the whole agenda as one string of carriage returns, so
 * the only structure available is how each line begins. A line starts a new
 * item **only** when it opens with a number; everything else — lettered
 * sub-items, bullets, and the wrapped remainder of a long line — folds into the
 * item above it.
 *
 * Without that rule a four-page Select Board agenda reported 86 items, because
 * every "a. Select Board Finance Committee" and every parenthetical
 * continuation counted as an agenda item of its own.
 *
 * Some boards number nothing at all. Rather than fold such an agenda into a
 * single blob, fall back to one item per line when no line is numbered.
 */
export function splitAgenda(raw: string): string[] {
  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => clean(line))
    .filter(Boolean);

  const numbered = lines.some((line) => ITEM_NUMBER.test(line));

  const items: string[] = [];
  for (const line of lines) {
    // A lettered or Roman marker is kept — "a. Forbes House Museum" reads
    // better than "Forbes House Museum" once folded into the item above.
    const text = line.replace(BULLET_MARKER, '');
    if (!text) continue;

    // With no numbering to go on, every line is its own item — the alternative
    // is one unreadable paragraph.
    const startsItem = numbered ? ITEM_NUMBER.test(line) : true;

    if (!startsItem && items.length) {
      items[items.length - 1] = `${items.at(-1)} — ${text}`;
    } else {
      items.push(text);
    }
  }
  return items;
}

/** Agenda content can be split over `AGENDA`, `AGENDA P1`, `AGENDA P2`, … */
function agendaText(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([key]) => /^agenda/i.test(key.trim()))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([, value]) => value)
    .join('\n');
}

export function parseMeetingNotice(extraction: PdfExtraction, profile: JurisdictionProfile): MeetingNotice {
  const { fields, text } = extraction;
  const structured = Object.keys(fields).length > 0;

  const board = pick(fields, FIELD_KEYS.board);
  const dateText = pick(fields, FIELD_KEYS.date) ?? '';
  const timeText = pick(fields, FIELD_KEYS.time);
  const building = pick(fields, FIELD_KEYS.building);
  const room = pick(fields, FIELD_KEYS.room);
  const postTime = pick(fields, FIELD_KEYS.postTime);

  const agenda = agendaText(fields);
  const agendaItems = agenda ? splitAgenda(agenda) : [];

  // Subjects come from the agenda when there is one. The rest of the notice is
  // a template — statutory boilerplate and the clerk's own address — so mining
  // it for addresses produces the town hall, not the property under discussion.
  const location = [building, room].filter(Boolean).join(', ');
  const subjects = extractSubjects(agenda || text).filter(
    (subject) => !isVenueAddress(profile, subject) && !location.includes(subject),
  );

  // "Milton Planning Board" on a Milton notice is the Planning Board. Stripping
  // the town's own name is what keeps it from becoming a body of its own — and
  // it has to be *this* town's name, or Hull's notices grow a Milton prefix
  // rule that never fires.
  const townPrefix = new RegExp(`^${escapeRegExp(profile.name)}\\s+`, 'i');

  return {
    board: board ? canonicalBody(profile, board.replace(townPrefix, '')) : null,
    meetingAt: dateText ? parseLocalDateTime(dateText, timeText ?? '', profile.timeZone) : null,
    timeText,
    location: location || null,
    agendaItems,
    postedAt: postTime ? parsePostingStamp(postTime, profile.timeZone) : null,
    postingAuthority: pick(fields, FIELD_KEYS.authority),
    remoteLink: pick(fields, FIELD_KEYS.link),
    subjects,
    structured,
  };
}

/**
 * A one-line description of what a meeting is actually about.
 *
 * Boilerplate items appear on every agenda and say nothing, so they are skipped
 * unless they are all there is.
 */
const BOILERPLATE =
  /^(call to order|roll call|adjourn|adjournment|public comment|new business|old business|administrative items?|announcements?|approval of minutes|meeting minutes|executive session|for the \d+)/i;

export function summarizeAgenda(items: string[], max = 3): string {
  // Items are numbered ("1. Call to Order"), so the numbering has to come off
  // before the boilerplate test — otherwise every agenda summarizes to
  // "Call to Order · Administrative Items · Public Comment".
  const substantive = items.filter((item) => !BOILERPLATE.test(item.replace(/^\d+[.)]\s*/, '')));
  const chosen = (substantive.length ? substantive : items).slice(0, max);
  return chosen.join(' · ');
}
