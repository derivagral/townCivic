import { clean } from '../util/text.ts';

/**
 * Where one record sits in the life of a matter.
 *
 * This is the `application filed → hearing scheduled → continued → approved
 * 4–1` sequence, read off the words the town used. Like classification, it is a
 * table of regular expressions rather than a model: a surprising stage is
 * reproducible, and every link stores the sentence it was read from, so a wrong
 * answer can be traced to the phrase that caused it.
 */

export const STAGES = [
  'filed',
  'scheduled',
  'heard',
  'continued',
  'decided',
  'withdrawn',
  'mentioned',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  filed: 'Application filed',
  scheduled: 'Hearing scheduled',
  heard: 'Heard',
  continued: 'Continued',
  decided: 'Decided',
  withdrawn: 'Withdrawn',
  mentioned: 'Mentioned',
};

/** Stages that end a matter, so a later `mentioned` does not reopen it. */
const TERMINAL: ReadonlySet<Stage> = new Set(['decided', 'withdrawn']);

/**
 * First match wins, so the order is the meaning.
 *
 * `continued` has to beat `scheduled` — "continued hearing on 271 Pleasant
 * Street" is both, and the useful fact is that it did not resolve. `decided`
 * comes first because minutes describing a vote usually also recite the hearing
 * that produced it.
 */
const STAGE_RULES: { stage: Stage; pattern: RegExp }[] = [
  { stage: 'withdrawn', pattern: /\bwithdraw(n|al|s|ing)?\b/i },
  {
    // `awarded` but not `award`: "the contract was awarded" is a decision,
    // "Award of Contract" as an agenda heading is a thing about to be done.
    stage: 'decided',
    pattern:
      /\b(approved?|denied|granted|adopted|rejected|dismissed|voted|vote of|passed|awarded)\b|\b\d+\s*[-–]\s*\d+\s*(vote|in favou?r)?\b/i,
  },
  { stage: 'continued', pattern: /\bcontinu(ed|ance|ing|e)\b/i },
  {
    stage: 'scheduled',
    pattern: /\b(public hearing|hearing on|hearing:|notice of (a )?public hearing|will be heard)\b/i,
  },
  {
    stage: 'filed',
    pattern:
      /\b(upon the application|application of|notice of intent|petition (of|for)|filed|submitted|received an application)\b/i,
  },
];

/**
 * What the record type implies when nothing in the text says otherwise.
 *
 * An agenda naming a property means the board is taking it up; minutes mean it
 * was taken up. Neither is a claim about the outcome.
 */
const TYPE_DEFAULTS: Record<string, Stage> = {
  meeting_agenda: 'scheduled',
  meeting_notice: 'scheduled',
  hearing_scheduled: 'scheduled',
  meeting_minutes: 'heard',
  bid_posted: 'filed',
};

export interface StageReading {
  stage: Stage;
  /** The sentence the stage was read from, or null when the type decided it. */
  evidence: string | null;
}

/**
 * Where one agenda item ends and the next begins.
 *
 * The negative lookbehind is for initials: "Upon the Application of A. Resident
 * at 271 Pleasant Street …" is one clause, and splitting it at "A." strands the
 * verb — the fragment naming the address would no longer contain the words that
 * say what is happening to it. The lookahead catches numbered items sharing a
 * line, which is how the AcroForm agenda field is often filled in.
 */
const ITEM_BREAK = /(?<=[.;])(?<![A-Z]\.)\s+|(?=\s\d{1,2}[.)]\s)/;

/**
 * Narrow a document to the part that talks about one subject.
 *
 * An agenda covers half a dozen unrelated properties. Applying the stage rules
 * to the whole thing would mark every item on a night's agenda "decided"
 * because one of them was. So the reading is scoped to the sentence or agenda
 * item the subject appears in.
 *
 * Lines are kept whole before sentence-splitting: an agenda field's line breaks
 * are the item boundaries the clerk actually typed, and they are more reliable
 * than punctuation.
 */
export function sentencesMentioning(text: string, subject: string): string[] {
  const needle = clean(subject).toLowerCase();
  if (!needle) return [];
  return text
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(ITEM_BREAK))
    .map((part) => clean(part))
    .filter((part) => part && part.toLowerCase().includes(needle));
}

/**
 * Read the stage for one subject out of one record.
 *
 * `scopedText` should already be narrowed to the subject where possible; the
 * event type is the fallback, and `mentioned` is the fallback to that.
 */
export function readStage(scopedText: string, eventType: string): StageReading {
  for (const rule of STAGE_RULES) {
    const match = rule.pattern.exec(scopedText);
    if (match) {
      return { stage: rule.stage, evidence: excerpt(scopedText, match.index) };
    }
  }
  return { stage: TYPE_DEFAULTS[eventType] ?? 'mentioned', evidence: null };
}

/** A readable window around the phrase that decided the stage. */
function excerpt(text: string, at: number, width = 180): string {
  if (text.length <= width) return text;
  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${slice.trim()}${start + width < text.length ? '…' : ''}`;
}

/**
 * Where a matter stands, given every stage on it in date order (oldest first).
 *
 * The most recent record wins, except that a bare mention never overwrites
 * something more definite, and a decision holds until a later record says
 * something new about the same matter.
 */
export function rollupStatus(stagesOldestFirst: Stage[]): Stage | null {
  if (!stagesOldestFirst.length) return null;

  for (let i = stagesOldestFirst.length - 1; i >= 0; i--) {
    const stage = stagesOldestFirst[i]!;
    if (stage !== 'mentioned') return stage;
  }
  return 'mentioned';
}

export function isTerminal(stage: Stage): boolean {
  return TERMINAL.has(stage);
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}
