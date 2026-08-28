import { CHANNEL_LABELS } from '../taxonomy.ts';
import type { EventRow } from '../db/repo.ts';
import { distanceMeters } from '../geo/project.ts';
import type { LatLon } from '../geo/project.ts';
import { TIMEZONE, formatDate, parseLooseDate, relativeDays } from '../util/dates.ts';
import { impactKey, impactLabel } from './impacts.ts';
import type { Impact, ImpactDimension, SchoolScope } from './impacts.ts';
import {
  DEFAULT_RADIUS_METERS,
  ORIGIN_AUTHORITY,
  TREATMENT_WEIGHTS,
  findInterest,
  schoolKeys,
  scopeFor,
} from './preferences.ts';
import type { PreferenceOrigin, Preferences } from './preferences.ts';

/**
 * The ranking behind "For you", and the sentence printed under every card.
 *
 * This is content-based ranking and nothing else. A record's score is a sum of
 * matches between the structured impacts extraction found in the document and
 * the preference rows a reader can read in full on one page. There is no
 * collaborative filtering here, and its absence is a decision rather than an
 * unfinished feature: one town publishes a few thousand records a year and has
 * a few hundred readers, which is far too thin for "readers like you" to be
 * anything other than noise — and the price of that noise would be a
 * behavioural profile of a neighbour's reading sitting in a municipal
 * database. A duller ranking that can be argued with beats a cleverer one that
 * cannot.
 *
 * So everything in this file produces a `Reason` before it produces a number.
 * The score is only ever the sum of its reasons; each reason carries the origin
 * of the preference that fired, which is what makes the authority ladder
 * visible rather than implied; and the explanation under the card is built from
 * the same objects the score was, so it cannot drift away from the arithmetic.
 * The failure mode being designed against is the ordinary one — a record
 * appears, nobody can say why, and the reader's only available response is to
 * distrust the entire page.
 *
 * The tradeoff accepted in exchange: this ranker cannot surprise anybody. It
 * will never turn up the record a reader did not know they wanted, because it
 * has no mechanism for guessing. Discovery is left to `/`, which is
 * chronological, complete, and filtered by nothing.
 */

export type ReasonKind =
  | 'interest'
  | 'school'
  | 'geography'
  | 'institution'
  | 'follow'
  | 'deadline'
  | 'stage'
  | 'downrank'
  | 'recency'
  | 'townwide';

export interface Reason {
  kind: ReasonKind;
  /** A clause that reads inside "Shown because …". Lowercase, no trailing period. */
  text: string;
  weight: number;
  origin: PreferenceOrigin;
}

export interface ScoredEvent {
  row: EventRow;
  score: number;
  reasons: Reason[];
  /** One sentence built from the reasons. Never empty for a shown record. */
  explanation: string;
  /** True when a preference muted it: excluded from For You, never from `/`. */
  muted: boolean;
}

export interface RankContext {
  now?: Date;
  /** Coordinates for an event, via its linked matters. */
  pointsByEvent?: Map<string, LatLon[]>;
  /** Matter ids the reader explicitly follows — the highest authority signal. */
  followedMatters?: Map<string, string>;
  /** Bodies and channels the reader explicitly follows (from `subscriptions`). */
  followedBodies?: Set<string>;
  followedChannels?: Set<string>;
  mattersByEvent?: Map<string, string[]>;
}

/**
 * The weight table, exported so it can be shown to the reader on a "why" page.
 *
 * Two rules hold this together. First, every number below is a *base*: what
 * reaches the score is the base multiplied by `ORIGIN_AUTHORITY` for whatever
 * said so, so the same nominal strength counts for less when the system
 * inferred it than when the reader typed it. Second, nothing structural may
 * outweigh something declared — `RECENCY_MAX` at full strength is 0.72 and the
 * weakest useful declared interest is 2.0, so a fresh record can reorder two
 * equally-relevant ones and can never push an interest off the page. That is
 * the whole reason recency is a small number here rather than a decay
 * multiplier applied to the total.
 */
export const SCORING = {
  /** A channel the reader watches townwide: a nudge, not a topic match. */
  TOWNWIDE: 0.4,
  /** At the doorstep. Scaled down towards the edge of the radius, never past it. */
  NEAR_HOME: 2.5,
  /** What a record sitting exactly on the radius keeps. Inside the promise is inside it. */
  NEAR_HOME_EDGE_SHARE: 0.5,
  /** A named school or building the reader picked out by hand. */
  INSTITUTION: 2.5,
  /** A school stage the reader selected in setup — declared, but stored outside `interests`. */
  SCHOOL_STAGE: 2,
  /** Following one matter is the most specific thing a reader can ask for. */
  FOLLOWED_MATTER: 4,
  FOLLOWED_BODY: 1.5,
  FOLLOWED_CHANNEL: 1,
  /** A deadline you can still act on. After it passes the same record is history. */
  DEADLINE_SOON: 2,
  HEARING_SOON: 1.5,
  PAST_DEADLINE: -0.75,
  /** How far ahead a deadline still counts as news. A month out it is not yet actionable. */
  DEADLINE_WINDOW_DAYS: 7,
  /** A vote beats a status update on the same subject. */
  DECISION_STAGE: 0.75,
  RECENCY_MAX: 0.9,
  RECENCY_HALF_LIFE_DAYS: 21,
  /** Below this the decay is not worth a sentence, so no reason is emitted. */
  RECENCY_FLOOR: 0.05,
  /** How many clauses the explanation may carry. Four stops being a sentence. */
  MAX_REASONS: 3,
} as const;

/**
 * Reading order for clauses of equal strength.
 *
 * Subject first, then place, then time — the order a person would say it in.
 * It also makes ties deterministic, which the stable-sort requirement needs.
 */
const KIND_ORDER: ReasonKind[] = [
  'follow',
  'school',
  'institution',
  'interest',
  'geography',
  'deadline',
  'stage',
  'townwide',
  'recency',
  'downrank',
];

/**
 * Mid-sentence nouns for the school stages.
 *
 * `SCHOOL_SCOPE_LABELS` is title-case UI text ("High school") and reads wrong
 * inside a clause, so the wording lives here. If the vocabulary grows a stage
 * this table has to grow with it — the type makes that a compile error.
 */
const STAGE_NOUN: Record<SchoolScope, string> = {
  preschool: 'preschool',
  elementary: 'elementary school',
  middle: 'middle school',
  high: 'high school',
  districtwide: 'district',
};

/* --------------------------------------------------------------- wording */

const METRES_PER_MILE = 1609.344;

/**
 * Fractions of a mile, with the words and the glyph for each.
 *
 * A reader in a Massachusetts town thinks in blocks and fractions of a mile,
 * not in metres, and "805 m" in a sentence about their own street reads like a
 * survey. The prose form goes in explanations, the short form in rule
 * descriptions, and both come from this one table so that a card and the alert
 * that produced it never disagree about the same distance.
 */
const FRACTIONS: { miles: number; prose: string; short: string }[] = [
  { miles: 0.25, prose: 'a quarter of a mile', short: '¼ mile' },
  { miles: 1 / 3, prose: 'a third of a mile', short: '⅓ mile' },
  { miles: 0.5, prose: 'half a mile', short: '½ mile' },
  { miles: 2 / 3, prose: 'two-thirds of a mile', short: '⅔ mile' },
  { miles: 0.75, prose: 'three-quarters of a mile', short: '¾ mile' },
  { miles: 1, prose: 'a mile', short: '1 mile' },
];

function nearestFraction(miles: number, tolerance: number): { prose: string; short: string } | null {
  let best: { miles: number; prose: string; short: string } | null = null;
  for (const fraction of FRACTIONS) {
    if (best === null || Math.abs(miles - fraction.miles) < Math.abs(miles - best.miles)) best = fraction;
  }
  if (!best || Math.abs(miles - best.miles) > tolerance) return null;
  return { prose: best.prose, short: best.short };
}

/** A measured distance, said the way somebody would say it out loud. */
export function humanDistance(meters: number): string {
  const miles = meters / METRES_PER_MILE;
  if (miles < 0.1) {
    // Under a tenth of a mile the fractions stop meaning anything, and rounding
    // to fifty feet is honest about what a rooftop geocode is worth anyway.
    const feet = Math.max(50, Math.round((meters * 3.28084) / 50) * 50);
    return `about ${feet} feet`;
  }
  const fraction = nearestFraction(miles, 0.08);
  return fraction ? `about ${fraction.prose}` : `about ${miles.toFixed(1)} miles`;
}

/** A configured radius, said the way a rule would name it: "½ mile". */
export function radiusPhrase(meters: number): string {
  const miles = meters / METRES_PER_MILE;
  if (miles < 0.1) return `${Math.round(meters)} m`;
  const fraction = nearestFraction(miles, 0.03);
  return fraction ? fraction.short : `${miles.toFixed(1)} miles`;
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' });

/**
 * The day a date falls on, named the way a neighbour would name it.
 *
 * Within the week the weekday is the useful form — "deadline Friday" is
 * something a reader can act on without doing arithmetic — but beyond seven
 * days a bare weekday is ambiguous, so it falls back to the date.
 */
export function dayName(iso: string, now = new Date()): string {
  const days = relativeDays(iso, now);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 7) return WEEKDAY.format(new Date(iso));
  return formatDate(iso);
}

/**
 * The date an impact carries, if it carries one.
 *
 * `detail` is the normalized scalar and is tried first; `evidence` is the
 * phrase it was read out of and is tried second, because an extractor that
 * found "comments due September 4, 2026" but failed to normalize it still knows
 * the date. A bare instant is only trusted when it looks like one — otherwise
 * `new Date('5')` turns a dollar figure into May.
 */
export function impactDate(impact: Impact): string | null {
  for (const text of [impact.detail, impact.evidence]) {
    if (!text) continue;
    const loose = parseLooseDate(text);
    if (loose) return loose;
    const parsed = new Date(text);
    if (text.includes('T') && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/* --------------------------------------------------------------- scoring */

/** Mirrors repo.ts's SORT_DATE, so For You and `/` agree on when a record happened. */
function sortDate(row: EventRow): string {
  return row.occurred_at ?? row.published_at ?? row.first_seen_at;
}

function keyOf(impact: Impact): string {
  return impactKey(impact.dimension, impact.value);
}

/** Institution names arrive as the extractor found them; compare them loosely. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function schoolClause(value: string): string {
  const noun = STAGE_NOUN[value as SchoolScope];
  if (!noun) return `it concerns ${value} schools`;
  if (value === 'districtwide') return 'it concerns the district as a whole';
  return `it concerns your selected ${noun}`;
}

/**
 * The clause an interest match contributes.
 *
 * Wording is per dimension because the labels are nouns of different kinds: a
 * service is something a record affects, a record property is something it
 * does. Nothing here embellishes — "includes a budget vote" would be a nicer
 * sentence than "it involves operating budget" and would also be a claim the
 * extraction never made.
 */
function interestClause(impact: Impact, negative: boolean): string {
  const key = keyOf(impact);
  const label = impactLabel(key);
  if (negative) return `you downranked ${label.toLowerCase()}`;
  switch (impact.dimension) {
    case 'school':
      return schoolClause(impact.value);
    case 'institution':
      return `it concerns ${impact.value}`;
    case 'service':
      return `it affects ${label.toLowerCase()}`;
    case 'finance':
      return `it involves ${label.toLowerCase()}`;
    case 'eligibility':
      return `it has ${label.toLowerCase()}`;
    case 'property':
      return `it ${label.toLowerCase()}`;
  }
}

function interestKind(dimension: ImpactDimension, weight: number): ReasonKind {
  if (weight < 0) return 'downrank';
  if (dimension === 'school') return 'school';
  if (dimension === 'institution') return 'institution';
  return 'interest';
}

/**
 * The first muting preference this record trips, or nothing.
 *
 * Scanned over key-sorted impacts so that two records carrying the same two
 * muted keys in different extraction orders report the same one.
 */
function firstMute(impacts: Impact[], preferences: Preferences): Reason | null {
  for (const impact of impacts) {
    const key = keyOf(impact);
    const interest = findInterest(preferences, key);
    if (interest?.treatment !== 'mute') continue;
    return {
      kind: 'downrank',
      text: `you muted ${impactLabel(key).toLowerCase()}`,
      weight: TREATMENT_WEIGHTS.mute * ORIGIN_AUTHORITY[interest.origin],
      origin: interest.origin,
    };
  }
  return null;
}

function compareReasons(a: Reason, b: Reason): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  const kinds = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kinds !== 0) return kinds;
  return a.text.localeCompare(b.text);
}

export function scoreEvent(
  row: EventRow,
  impacts: Impact[],
  preferences: Preferences,
  context: RankContext = {},
): ScoredEvent {
  const now = context.now ?? new Date();

  // Impacts arrive in whatever order extraction happened to produce them.
  // Sorting by key first means the same record scores the same way, with the
  // reasons in the same order, however they were stored.
  const sorted = [...impacts].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  const muted = firstMute(sorted, preferences);
  if (muted) {
    // Mute short-circuits: nothing else about the record can earn it a place,
    // so nothing else is computed and the score is not meaningful. This reaches
    // For You and alerts only. The chronological record at `/` is never
    // filtered by anybody's profile — the strongest thing a preference can do
    // is decline to recommend, and the record stays published and searchable.
    return {
      row,
      score: Number.NEGATIVE_INFINITY,
      reasons: [muted],
      explanation: explain([muted]),
      muted: true,
    };
  }

  const reasons: Reason[] = [];
  const fired = new Set<string>();

  // Declared interests. The product below is the authority ladder made
  // arithmetic: the treatment says how much the reader cares, the origin says
  // how much the system is entitled to believe it said so. Identical rows at
  // `declared` and `template` differ by exactly ORIGIN_AUTHORITY, so a template
  // can never quietly outvote a row a reader typed.
  for (const impact of sorted) {
    const key = keyOf(impact);
    const interest = findInterest(preferences, key);
    if (!interest) continue;
    const weight = TREATMENT_WEIGHTS[interest.treatment] * ORIGIN_AUTHORITY[interest.origin];
    // `normal` and `ask` weigh nothing on purpose — an undecided row must not
    // move a record, and a reason with no contribution would be a sentence
    // about nothing.
    if (weight === 0) continue;
    fired.add(key);
    reasons.push({
      kind: interestKind(impact.dimension, weight),
      text: interestClause(impact, weight < 0),
      weight,
      origin: interest.origin,
    });
  }

  // School stages live outside `interests` (they are answered once, in setup)
  // but the reader still typed them, so they enter at declared authority.
  const stages = new Set(schoolKeys(preferences));
  for (const impact of sorted) {
    if (impact.dimension !== 'school') continue;
    const key = keyOf(impact);
    if (fired.has(key) || !stages.has(key)) continue;
    fired.add(key);
    reasons.push({
      kind: 'school',
      text: schoolClause(impact.value),
      weight: SCORING.SCHOOL_STAGE * ORIGIN_AUTHORITY.declared,
      origin: 'declared',
    });
  }

  scoreGeography(row, sorted, preferences, context, fired, reasons);
  scoreFollows(row, context, reasons);
  scoreTimeliness(row, sorted, now, reasons);

  // A record with nothing to say for itself still has to say something true.
  // "This week" is a claim, so it is only made when it is one.
  if (!reasons.length) {
    const days = Math.abs(relativeDays(sortDate(row), now));
    reasons.push({
      kind: 'townwide',
      text: days <= 7 ? "it is in your town's record this week" : "it is in your town's public record",
      weight: 0,
      origin: 'deterministic',
    });
  }

  reasons.sort(compareReasons);
  const score = reasons.reduce((total, reason) => total + reason.weight, 0);
  return { row, score, reasons, explanation: explain(reasons), muted: false };
}

/**
 * Geography, read per channel from the reader's own scope setting.
 *
 * Geographic and institutional matches enter at `deterministic` authority
 * rather than `declared`: the reader declared the home address and the school
 * list, but the match itself is something the system worked out, and it can be
 * wrong in ways a typed preference cannot — a geocoder puts a parcel on the
 * wrong side of a street, an extractor reads a school name out of a boilerplate
 * footer.
 */
function scoreGeography(
  row: EventRow,
  impacts: Impact[],
  preferences: Preferences,
  context: RankContext,
  fired: Set<string>,
  reasons: Reason[],
): void {
  const scope = scopeFor(preferences, row.channel);

  if (scope === 'near_home') {
    const home = preferences.home;
    const points = context.pointsByEvent?.get(row.id) ?? [];
    // No home set and no geocoded point are both "we do not know where this
    // is", and the honest answer to not knowing is to contribute nothing. A
    // near-home scope that matched everything when the address was missing
    // would silently become a townwide scope, and the reader would be told
    // "near home" about a record on the other side of town.
    if (!home || !points.length) return;
    const radius = home.radiusMeters > 0 ? home.radiusMeters : DEFAULT_RADIUS_METERS;
    const distance = Math.min(...points.map((point) => distanceMeters(point, home)));
    if (distance > radius) return;
    // Closer is worth more, but a record on the boundary is still inside the
    // radius the reader chose, so it keeps a defined share rather than trailing
    // off to nothing at the edge.
    const share = 1 - SCORING.NEAR_HOME_EDGE_SHARE * (distance / radius);
    reasons.push({
      kind: 'geography',
      text: `it is ${humanDistance(distance)} from home`,
      weight: SCORING.NEAR_HOME * share * ORIGIN_AUTHORITY.deterministic,
      origin: 'deterministic',
    });
    return;
  }

  if (scope === 'selected_institutions') {
    for (const impact of impacts) {
      if (impact.dimension !== 'institution') continue;
      const key = keyOf(impact);
      if (fired.has(key)) continue;
      if (!preferences.schools.institutions.some((name) => sameName(name, impact.value))) continue;
      fired.add(key);
      reasons.push({
        kind: 'institution',
        text: `it concerns ${impact.value}`,
        weight: SCORING.INSTITUTION * ORIGIN_AUTHORITY.deterministic,
        origin: 'deterministic',
      });
    }
    return;
  }

  if (scope === 'townwide') {
    reasons.push({
      kind: 'townwide',
      text: `you follow ${CHANNEL_LABELS[row.channel].toLowerCase()} townwide`,
      weight: SCORING.TOWNWIDE * ORIGIN_AUTHORITY.deterministic,
      origin: 'deterministic',
    });
  }

  // `off` contributes nothing and says nothing. A scope the reader switched off
  // should be silent rather than explained back to them on every card.
}

/**
 * Follows, which are the strongest thing in the file.
 *
 * A subscription is an explicit act, so it enters at `declared` — the
 * `suggested` tier is for preferences *derived* from a subscription ("you
 * follow the Planning Board, shall we turn on land use?"), which is a question
 * for the setup page and never a silent ranking input.
 */
function scoreFollows(row: EventRow, context: RankContext, reasons: Reason[]): void {
  const matterIds = [...(context.mattersByEvent?.get(row.id) ?? [])].sort();
  for (const id of matterIds) {
    const label = context.followedMatters?.get(id);
    if (!label) continue;
    reasons.push({
      kind: 'follow',
      text: `you follow ${label}`,
      weight: SCORING.FOLLOWED_MATTER * ORIGIN_AUTHORITY.declared,
      origin: 'declared',
    });
  }

  if (row.body && context.followedBodies?.has(row.body)) {
    reasons.push({
      kind: 'follow',
      text: `you follow the ${row.body}`,
      weight: SCORING.FOLLOWED_BODY * ORIGIN_AUTHORITY.declared,
      origin: 'declared',
    });
  }

  if (context.followedChannels?.has(row.channel)) {
    reasons.push({
      kind: 'follow',
      text: `you subscribe to ${CHANNEL_LABELS[row.channel].toLowerCase()}`,
      weight: SCORING.FOLLOWED_CHANNEL * ORIGIN_AUTHORITY.declared,
      origin: 'declared',
    });
  }
}

/**
 * Time, which is the difference between a notice and a record.
 *
 * A hearing a reader can still attend and the minutes of the same hearing are
 * the same subject and not the same thing, so the deadline reasons are positive
 * before the date and negative after it. Recency itself decays gently and stays
 * deliberately small: it exists to order two otherwise equal records, not to
 * push a declared interest below a fresh piece of routine administration.
 */
function scoreTimeliness(row: EventRow, impacts: Impact[], now: Date, reasons: Reason[]): void {
  const takesComment = impacts.some((i) => i.dimension === 'property' && i.value === 'public_comment');

  for (const impact of impacts) {
    if (impact.dimension !== 'property') continue;
    if (impact.value !== 'deadline' && impact.value !== 'hearing_date') continue;
    const date = impactDate(impact);
    if (!date) continue;

    const isDeadline = impact.value === 'deadline';
    const days = relativeDays(date, now);
    if (days < 0) {
      reasons.push({
        kind: 'recency',
        text: isDeadline ? 'its deadline has passed' : 'its hearing has already happened',
        weight: SCORING.PAST_DEADLINE * ORIGIN_AUTHORITY.deterministic,
        origin: 'deterministic',
      });
      continue;
    }
    // A deadline two months out is real and not yet news. It will earn this
    // reason on its own when the week arrives, which is when it is actionable.
    if (days > SCORING.DEADLINE_WINDOW_DAYS) continue;

    const word = dayName(date, now);
    reasons.push({
      kind: 'deadline',
      text: isDeadline
        ? `it has a ${takesComment ? 'public-comment ' : ''}deadline ${word}`
        : `its hearing is ${word}`,
      weight: (isDeadline ? SCORING.DEADLINE_SOON : SCORING.HEARING_SOON) * ORIGIN_AUTHORITY.deterministic,
      origin: 'deterministic',
    });
  }

  if (impacts.some((i) => i.dimension === 'property' && i.value === 'decision_stage')) {
    reasons.push({
      kind: 'stage',
      text: 'it reaches a decision rather than reporting on one',
      weight: SCORING.DECISION_STAGE * ORIGIN_AUTHORITY.deterministic,
      origin: 'deterministic',
    });
  }

  const iso = sortDate(row);
  const ageDays = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 86_400_000);
  const decay =
    SCORING.RECENCY_MAX * ORIGIN_AUTHORITY.deterministic * 0.5 ** (ageDays / SCORING.RECENCY_HALF_LIFE_DAYS);
  if (decay < SCORING.RECENCY_FLOOR) return;

  let text: string;
  if (new Date(iso).getTime() > now.getTime()) text = 'it has not happened yet';
  else if (ageDays < 3) text = 'it was posted in the last few days';
  else if (ageDays < 14) text = 'it is from the past two weeks';
  else text = `it is from ${formatDate(iso)}`;
  reasons.push({ kind: 'recency', text, weight: decay, origin: 'deterministic' });
}

/* ------------------------------------------------------------- explaining */

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/**
 * The sentence shown under a card. Exported so views and feeds share wording.
 *
 * Built from the three strongest reasons by absolute weight, which means a
 * downrank can appear in it. That is deliberate: a record the reader pushed
 * down is still being shown to them, and a sentence that listed only the
 * flattering half of the arithmetic would be a lie by omission. The clauses are
 * then re-ordered by signed weight so the sentence reads subject-first.
 */
/**
 * Drop a clause another clause already contains.
 *
 * Two rules can be right about the same fact at different resolutions: an
 * interest in `property:deadline` says "it has a deadline", and the timeliness
 * pass says "it has a deadline Friday". Both are true and both earn their
 * score, but read together they are a stutter — and the vaguer one wastes one
 * of the three clauses the sentence gets. The specific one has already been
 * sorted first by weight, so keeping the first of any containing pair keeps the
 * more informative wording.
 */
function subsuming(reasons: Reason[]): Reason[] {
  const kept: Reason[] = [];
  for (const reason of reasons) {
    if (kept.some((other) => other.text.includes(reason.text) || reason.text.includes(other.text))) {
      continue;
    }
    kept.push(reason);
  }
  return kept;
}

export function explain(reasons: Reason[]): string {
  if (!reasons.length) return "Shown because it is in your town's public record.";

  const muted = reasons.filter((reason) => reason.weight === Number.NEGATIVE_INFINITY);
  if (muted.length) return `Not recommended because ${muted[0]!.text}.`;

  const ranked = [...reasons].sort((a, b) => {
    const magnitude = Math.abs(b.weight) - Math.abs(a.weight);
    if (magnitude !== 0) return magnitude;
    const kinds = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return kinds !== 0 ? kinds : a.text.localeCompare(b.text);
  });

  const strongest = subsuming(ranked).slice(0, SCORING.MAX_REASONS).sort(compareReasons);

  return `Shown because ${joinClauses(strongest.map((reason) => reason.text))}.`;
}

/* ----------------------------------------------------------------- ranking */

/**
 * Order for the page.
 *
 * Ties fall through to the record's own sort date and then its title, so two
 * equally-relevant records come back in the same order on every reload; the id
 * is the last resort, because a total order is worth more here than an elegant
 * one. Nothing consults the clock except through `context.now`, which keeps the
 * whole thing pure and testable.
 */
function compareScored(a: ScoredEvent, b: ScoredEvent): number {
  if (a.score !== b.score) return b.score - a.score;
  const dates = sortDate(b.row).localeCompare(sortDate(a.row));
  if (dates !== 0) return dates;
  const titles = a.row.title.localeCompare(b.row.title);
  return titles !== 0 ? titles : a.row.id.localeCompare(b.row.id);
}

export function rankEvents(
  rows: EventRow[],
  impactsByEvent: Map<string, Impact[]>,
  preferences: Preferences,
  context: RankContext = {},
): ScoredEvent[] {
  return (
    rows
      .map((row) => scoreEvent(row, impactsByEvent.get(row.id) ?? [], preferences, context))
      // Muted records leave For You here, and only here. `/`, search and the
      // feeds run off `queryEvents` and never see a profile at all.
      .filter((scored) => !scored.muted)
      .sort(compareScored)
  );
}
