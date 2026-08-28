import { CHANNELS, CHANNEL_LABELS, isChannel } from '../taxonomy.ts';
import type { EventRow } from '../db/repo.ts';
import { distanceMeters } from '../geo/project.ts';
import { isBlockedKey } from './blocked.ts';
import { SCHOOL_SCOPES, SCHOOL_SCOPE_LABELS, impactKey, impactLabel, parseImpactKey } from './impacts.ts';
import type { Impact, SchoolScope } from './impacts.ts';
import { DEFAULT_RADIUS_METERS, scopeFor } from './preferences.ts';
import type { Preferences } from './preferences.ts';
import { dayName, humanDistance, impactDate, radiusPhrase } from './score.ts';
import type { RankContext } from './score.ts';

/**
 * The rule engine behind "Alerts", which is deliberately not a model.
 *
 * Ranking can afford to be approximately right: a record in the wrong order is
 * a mild annoyance a reader scrolls past. An alert cannot. It is the one place
 * townCivic asserts something unprompted — "this is about your street", "your
 * child's school may close" — and a wrong assertion of that kind costs more
 * trust than fifty good ones earn. So the bar here is higher than anywhere else
 * in the codebase: a rule must be a sentence a person would agree to out loud,
 * and it must evaluate against structure that extraction actually found, never
 * against a similarity score or a phrase that merely suggests something.
 *
 * The consequence is that every rule fails closed. No home address, no
 * geocoded point, no stages in the parameters, parameters that did not survive
 * a round-trip through the database — each of those produces silence rather
 * than a guess, because an alert that fires on absent data is worse than no
 * alert at all: it teaches the reader that the alerts mean nothing, and there
 * is no way back from that.
 *
 * What this costs is recall. A closure discussed only in the body of a
 * two-hundred-page appendix will not fire, and that is the direction the error
 * is allowed to run in.
 */

export const ALERT_KINDS = [
  'near_home',
  'institution',
  'school_stage',
  'impact',
  'matter',
  'deadline',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Parameters, by kind. All of them are stored as JSON and read back defensively.
 *
 *   near_home     `{ channels?: string[], impactKeys?: string[], radiusMeters?: number }`
 *                 Channels and impact keys narrow what counts; the radius
 *                 defaults to the reader's own `home.radiusMeters`. Wholly
 *                 empty parameters never fire — see `fireNearHome`.
 *   institution   `{ names: string[] }` — matched against `institution:` impacts.
 *   school_stage  `{ stages: SchoolScope[], onlyClosures?: boolean }`
 *   impact        `{ keys: string[] }` — any extracted `dimension:value` key.
 *   matter        `{ matterIds: string[] }` — the timelines the reader follows.
 *   deadline      `{ withinDays: number, impactKeys?: string[] }` — matches both
 *                 `property:deadline` and `property:hearing_date`, because a
 *                 hearing is the deadline for turning up.
 */
export interface AlertRule {
  id: string;
  kind: AlertKind;
  label: string;
  params: Record<string, unknown>;
  enabled: boolean;
}

export interface AlertHit {
  rule: AlertRule;
  row: EventRow;
  /** Why this fired, in the rule's own terms. Shown next to the record. */
  reason: string;
  /** The extracted evidence that satisfied it, when there is one. */
  evidence: string | null;
}

/** A radius below this is inside the geocoder's own error; above it, it is the town. */
const MIN_RADIUS_METERS = 50;
const MAX_RADIUS_METERS = 8_000;
/** Beyond three months a "deadline" alert is a calendar, not an alert. */
const MAX_WITHIN_DAYS = 90;

/* ----------------------------------------------------------- reading params */

/**
 * Parameters come back from SQLite as parsed JSON of unknown shape.
 *
 * `validateRule` guards the front door, but a row written by an older version
 * of that function is still in the table, so every read here re-checks rather
 * than trusting. A parameter that cannot be read counts as absent, and absent
 * parameters make a rule silent rather than permissive.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((s) => s.trim());
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinOr(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, or ${parts.at(-1)}`;
}

/** Mid-sentence nouns, as in score.ts — the labels are title-case UI text. */
const STAGE_NOUN: Record<SchoolScope, string> = {
  preschool: 'preschool',
  elementary: 'elementary school',
  middle: 'middle school',
  high: 'high school',
  districtwide: 'districtwide',
};

/* -------------------------------------------------------- closure phrasing */

/**
 * Closures are the one rule that reads phrasing, and the only one that has to.
 *
 * There is no `closure` impact in the vocabulary — the axes describe which
 * services and stages a record touches, not what it proposes to do to them —
 * and "elementary-school closures" is nonetheless the second alert every parent
 * asks for. So this reads the extracted evidence and the record's own title and
 * summary, all of which are text the reader can see on the card and check.
 *
 * The failure mode being defended against is the school that is "closed Monday
 * for the holiday". A temporary marker in the same sentence disqualifies the
 * match outright, which loses the occasional real closure vote scheduled for a
 * named weekday. Telling a parent their school may be closing when it is shut
 * for Presidents' Day is the more expensive of the two mistakes.
 */
const CLOSURE_PATTERNS = [
  /\bclos(?:ure|ing)s?\s+of\b/i,
  /\b(?:permanent\w*|proposed|potential|possible)\s+clos\w+/i,
  /\bconsolidat\w+/i,
  /\bredistrict\w+/i,
  /\brepurpos\w+/i,
  /\bschool\s+clos\w+/i,
  // "close Glover Elementary School" — the natural phrasing, which needs to
  // step over the building's name and its tier to reach the word `school`. The
  // lookahead is what keeps "closed session of the school committee" out: a
  // board going into executive session is not a school closing.
  /\bclos(?:e|es|ed|ing|ure)\b(?!\s+session)\s+(?:the\s+)?(?:[\w'-]+\s+){0,3}school\b/i,
];

const TEMPORARY =
  /\b(holiday|vacation|recess|snow|inclement|weather|early release|delayed opening|for the day|reopens?|half[- ]day)\b/i;

/** The sentence a match sits in, so the evidence shown is readable on its own. */
function sentenceAround(text: string, index: number): string {
  const before = text.slice(0, index);
  const start =
    Math.max(
      before.lastIndexOf('. '),
      before.lastIndexOf('\n'),
      before.lastIndexOf('; '),
      before.lastIndexOf('— '),
    ) + 1;
  const rest = text.slice(index);
  const boundary = /[.;\n]/.exec(rest);
  const end = boundary ? index + boundary.index + 1 : text.length;
  return text.slice(start, end).trim();
}

function closurePhrase(candidates: (string | null)[]): string | null {
  for (const text of candidates) {
    if (!text) continue;
    for (const pattern of CLOSURE_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const sentence = sentenceAround(text, match.index);
      if (TEMPORARY.test(sentence)) continue;
      return sentence;
    }
  }
  return null;
}

/* ------------------------------------------------------------- evaluation */

function fireNearHome(
  rule: AlertRule,
  row: EventRow,
  impacts: Impact[],
  preferences: Preferences,
  context: RankContext,
): AlertHit | null {
  // Two refusals that are the whole reason this rule is trustworthy. Without a
  // home there is nothing to measure from, and without a geocoded point there
  // is nothing to measure to — in both cases "within half a mile" is not false,
  // it is unknown, and an alert that fires on unknown data is the failure this
  // module exists to avoid.
  const home = preferences.home;
  if (!home) return null;
  const points = context.pointsByEvent?.get(row.id) ?? [];
  if (!points.length) return null;

  const channels = stringList(rule.params['channels']);
  const keys = stringList(rule.params['impactKeys']);
  const configuredRadius = finiteNumber(rule.params['radiusMeters']);
  // An empty parameter set is "no", not "everything": a rule whose parameters
  // were lost on the way out of the database must not become a subscription to
  // every record in the neighbourhood.
  if (!channels.length && !keys.length && configuredRadius === null) return null;

  if (channels.length && !channels.includes(row.channel)) return null;
  const matched = keys.length
    ? impacts.find((i) => keys.includes(impactKey(i.dimension, i.value)))
    : undefined;
  if (keys.length && !matched) return null;

  const radius = configuredRadius ?? (home.radiusMeters > 0 ? home.radiusMeters : DEFAULT_RADIUS_METERS);
  const distance = Math.min(...points.map((point) => distanceMeters(point, home)));
  if (distance > radius) return null;

  return {
    rule,
    row,
    reason: `${capitalize(humanDistance(distance))} from home, inside the ${radiusPhrase(radius)} this rule watches.`,
    evidence: matched?.evidence ?? null,
  };
}

function fireInstitution(rule: AlertRule, row: EventRow, impacts: Impact[]): AlertHit | null {
  const names = stringList(rule.params['names']);
  if (!names.length) return null;
  const matched = impacts.find(
    (impact) => impact.dimension === 'institution' && names.some((name) => sameName(name, impact.value)),
  );
  if (!matched) return null;
  return { rule, row, reason: `This record names ${matched.value}.`, evidence: matched.evidence };
}

function fireSchoolStage(rule: AlertRule, row: EventRow, impacts: Impact[]): AlertHit | null {
  const stages = stringList(rule.params['stages']).filter((stage): stage is SchoolScope =>
    (SCHOOL_SCOPES as readonly string[]).includes(stage),
  );
  if (!stages.length) return null;
  const matched = impacts.find(
    (impact) => impact.dimension === 'school' && stages.includes(impact.value as SchoolScope),
  );
  if (!matched) return null;

  const noun = STAGE_NOUN[matched.value as SchoolScope] ?? matched.value;
  if (rule.params['onlyClosures'] === true) {
    const phrase = closurePhrase([matched.evidence, row.title, row.summary]);
    if (!phrase) return null;
    return {
      rule,
      row,
      reason: `Concerns ${noun}, and names a closure or consolidation.`,
      evidence: phrase,
    };
  }
  return { rule, row, reason: `Concerns ${noun}.`, evidence: matched.evidence };
}

function fireImpact(rule: AlertRule, row: EventRow, impacts: Impact[]): AlertHit | null {
  const keys = stringList(rule.params['keys']);
  if (!keys.length) return null;
  const matched = impacts.find((impact) => keys.includes(impactKey(impact.dimension, impact.value)));
  if (!matched) return null;
  return {
    rule,
    row,
    reason: `Extraction found ${impactLabel(impactKey(matched.dimension, matched.value))} in this record.`,
    evidence: matched.evidence,
  };
}

function fireMatter(rule: AlertRule, row: EventRow, context: RankContext): AlertHit | null {
  const wanted = stringList(rule.params['matterIds']);
  if (!wanted.length) return null;
  const linked = context.mattersByEvent?.get(row.id) ?? [];
  const matched = [...linked].sort().find((id) => wanted.includes(id));
  if (!matched) return null;
  const label = context.followedMatters?.get(matched) ?? matched;
  return { rule, row, reason: `A new record on ${label}.`, evidence: null };
}

function fireDeadline(rule: AlertRule, row: EventRow, impacts: Impact[], now: Date): AlertHit | null {
  const withinDays = finiteNumber(rule.params['withinDays']);
  if (withinDays === null || withinDays <= 0) return null;
  const keys = stringList(rule.params['impactKeys']);
  if (keys.length && !impacts.some((i) => keys.includes(impactKey(i.dimension, i.value)))) return null;

  // Earliest first, so a record carrying both a comment deadline and a hearing
  // reports the one the reader has to act on first.
  const dated = impacts
    .filter((i) => i.dimension === 'property' && (i.value === 'deadline' || i.value === 'hearing_date'))
    .map((impact) => ({ impact, date: impactDate(impact) }))
    .filter((entry): entry is { impact: Impact; date: string } => entry.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const entry of dated) {
    const days = Math.round((new Date(entry.date).getTime() - now.getTime()) / 86_400_000);
    if (days < 0 || days > withinDays) continue;
    const noun = entry.impact.value === 'deadline' ? 'deadline' : 'hearing';
    return {
      rule,
      row,
      reason: `Its ${noun} is ${dayName(entry.date, now)}, inside the ${withinDays}-day window.`,
      evidence: entry.impact.evidence,
    };
  }
  return null;
}

/**
 * Run a reader's rules over one record.
 *
 * Rules are evaluated in the order given and each may contribute at most one
 * hit, so a rule that could match three impacts on the same record produces one
 * line rather than three. Disabled rules are skipped here rather than filtered
 * by the caller, because "paused" has to mean paused everywhere.
 */
export function evaluateAlerts(
  rules: AlertRule[],
  row: EventRow,
  impacts: Impact[],
  preferences: Preferences,
  context: RankContext = {},
): AlertHit[] {
  const now = context.now ?? new Date();
  const hits: AlertHit[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    let hit: AlertHit | null = null;
    switch (rule.kind) {
      case 'near_home':
        hit = fireNearHome(rule, row, impacts, preferences, context);
        break;
      case 'institution':
        hit = fireInstitution(rule, row, impacts);
        break;
      case 'school_stage':
        hit = fireSchoolStage(rule, row, impacts);
        break;
      case 'impact':
        hit = fireImpact(rule, row, impacts);
        break;
      case 'matter':
        hit = fireMatter(rule, row, context);
        break;
      case 'deadline':
        hit = fireDeadline(rule, row, impacts, now);
        break;
      default:
        // The kind is a string in the database and this union in the type
        // system. A row written by a newer version of the app, or by hand,
        // lands here and is ignored rather than misinterpreted.
        hit = null;
    }
    if (hit) hits.push(hit);
  }
  return hits;
}

/* ------------------------------------------------------------- describing */

/**
 * The rule as one line of English, for the list on the alerts page.
 *
 * The reader's own label is the subject where a rule has one — "Zoning within
 * ½ mile of home" is what they wrote plus what they configured — and the
 * parameters supply it where they did not. A rule whose parameters are missing
 * says so, because a description that reads as configured when nothing is
 * configured is how a silent rule goes unnoticed for a month.
 */
export function describeRule(rule: AlertRule): string {
  const label = rule.label.trim();
  switch (rule.kind) {
    case 'near_home': {
      const keys = stringList(rule.params['impactKeys']);
      const channels = stringList(rule.params['channels']).filter(isChannel);
      const subject =
        label ||
        (keys.length
          ? joinOr(keys.map(impactLabel))
          : channels.length
            ? joinOr(channels.map((channel) => CHANNEL_LABELS[channel]))
            : 'Anything');
      const radius = finiteNumber(rule.params['radiusMeters']);
      // Without its own radius the rule follows whatever the reader's home
      // radius currently is, so the description must not name a number.
      return `${subject} within ${radius === null ? 'your home radius' : radiusPhrase(radius)} of home`;
    }
    case 'institution': {
      const names = stringList(rule.params['names']);
      return names.length ? `Records naming ${joinOr(names)}` : 'A named-institution rule with no names set';
    }
    case 'school_stage': {
      const stages = stringList(rule.params['stages']).filter((stage): stage is SchoolScope =>
        (SCHOOL_SCOPES as readonly string[]).includes(stage),
      );
      if (!stages.length) return 'A school-stage rule with no stages set';
      const nouns = joinOr(stages.map((stage) => STAGE_NOUN[stage]));
      return capitalize(
        `${nouns} ${rule.params['onlyClosures'] === true ? 'closures and consolidations' : 'records'}`,
      );
    }
    case 'impact': {
      const keys = stringList(rule.params['keys']);
      return keys.length
        ? `Records involving ${joinOr(keys.map(impactLabel))}`
        : 'An impact rule with no keys set';
    }
    case 'matter': {
      const ids = stringList(rule.params['matterIds']);
      if (label) return `Updates on ${label}`;
      return ids.length
        ? `Updates on ${ids.length} followed matter${ids.length === 1 ? '' : 's'}`
        : 'A matter rule with no matters set';
    }
    case 'deadline': {
      const withinDays = finiteNumber(rule.params['withinDays']);
      if (withinDays === null) return 'A deadline rule with no window set';
      const keys = stringList(rule.params['impactKeys']);
      const scope = keys.length ? ` for ${joinOr(keys.map(impactLabel))}` : '';
      return `Deadlines and hearings within ${withinDays} day${withinDays === 1 ? '' : 's'}${scope}`;
    }
    default:
      return label || 'Unrecognised alert rule';
  }
}

/**
 * Rules a profile implies but has not been asked about yet.
 *
 * Suggestions, not saves. Every one of these comes back disabled and without an
 * id, so it cannot be mistaken for something stored: the alerts page renders
 * them next to an "Add" button and nothing exists until the reader presses it.
 * That is the difference between a system that says "you follow Tucker
 * Elementary, shall I alert you about closures?" and one that decides.
 */
export function suggestedRules(preferences: Preferences): Omit<AlertRule, 'id'>[] {
  const suggestions: Omit<AlertRule, 'id'>[] = [];
  const home = preferences.home;

  if (home && scopeFor(preferences, 'land-use') === 'near_home') {
    suggestions.push({
      kind: 'near_home',
      label: 'Zoning and land use',
      params: {
        channels: ['land-use'],
        radiusMeters: home.radiusMeters > 0 ? home.radiusMeters : DEFAULT_RADIUS_METERS,
      },
      enabled: false,
    });
  }

  for (const stage of [...preferences.schools.stages].sort()) {
    suggestions.push({
      kind: 'school_stage',
      label: `${SCHOOL_SCOPE_LABELS[stage]} closures`,
      params: { stages: [stage], onlyClosures: true },
      enabled: false,
    });
  }

  for (const name of [...preferences.schools.institutions].sort()) {
    suggestions.push({
      kind: 'institution',
      label: name,
      params: { names: [name] },
      enabled: false,
    });
  }

  // Only `immediate` earns an alert suggestion. `digest` means the reader
  // already said they did not want to be interrupted about it.
  const immediate = preferences.interests
    .filter((interest) => interest.treatment === 'immediate')
    .map((interest) => interest.key)
    .sort();

  for (const key of immediate) {
    suggestions.push({ kind: 'impact', label: impactLabel(key), params: { keys: [key] }, enabled: false });
  }

  if (immediate.length) {
    suggestions.push({
      kind: 'deadline',
      label: 'Deadlines on what you follow closely',
      params: { withinDays: 7, impactKeys: immediate },
      enabled: false,
    });
  }

  return suggestions;
}

/* -------------------------------------------------------------- validation */

type Validation = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

function fail(error: string): Validation {
  return { ok: false, error };
}

/** An array of non-empty strings, or null when it is anything else. */
function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    if (!cleaned.includes(item.trim())) cleaned.push(item.trim());
  }
  return cleaned;
}

function checkImpactKeys(value: unknown, field: string): { keys: string[] } | { error: string } {
  const keys = asStrings(value);
  if (!keys)
    return { error: `\`${field}\` must be a non-empty list of impact keys, e.g. ["service:schools"].` };
  for (const key of keys) {
    if (isBlockedKey(key)) return { error: `"${key}" is not something townCivic will alert on, or store.` };
    if (!parseImpactKey(key)) return { error: `"${key}" is not an impact key. Expected "dimension:value".` };
  }
  return { keys };
}

/**
 * The guard behind the HTTP form, and the reason a saved rule can be trusted.
 *
 * Validation happens before storage rather than at firing time on purpose: a
 * rule that is stored but can never match looks configured on the page and is
 * silently useless, which is indistinguishable from an alert system that does
 * not work. Errors are written to be read by the person who typed the JSON.
 */
export function validateRule(kind: string, params: Record<string, unknown>): Validation {
  if (!(ALERT_KINDS as readonly string[]).includes(kind)) {
    return fail(`"${kind}" is not an alert kind. Expected one of: ${ALERT_KINDS.join(', ')}.`);
  }

  switch (kind as AlertKind) {
    case 'near_home': {
      const clean: Record<string, unknown> = {};
      if (params['channels'] !== undefined) {
        const channels = asStrings(params['channels']);
        if (!channels) return fail('`channels` must be a non-empty list of channel names.');
        const unknown = channels.find((channel) => !isChannel(channel));
        if (unknown) return fail(`"${unknown}" is not a channel. Expected one of: ${CHANNELS.join(', ')}.`);
        clean['channels'] = channels;
      }
      if (params['impactKeys'] !== undefined) {
        const checked = checkImpactKeys(params['impactKeys'], 'impactKeys');
        if ('error' in checked) return fail(checked.error);
        clean['impactKeys'] = checked.keys;
      }
      if (params['radiusMeters'] !== undefined) {
        const radius = finiteNumber(params['radiusMeters']);
        if (radius === null)
          return fail('`radiusMeters` must be a number of metres, e.g. 805 for half a mile.');
        if (radius < MIN_RADIUS_METERS || radius > MAX_RADIUS_METERS) {
          return fail(
            `\`radiusMeters\` must be between ${MIN_RADIUS_METERS} and ${MAX_RADIUS_METERS} — below that is inside the geocoder's own error, above it is the whole town.`,
          );
        }
        clean['radiusMeters'] = radius;
      }
      // Matches `fireNearHome`: a rule with nothing set would be "alert me
      // about every record near my house", which nobody asked for by accident.
      if (!Object.keys(clean).length) {
        return fail('A near-home rule needs at least a radius, a channel, or an impact key.');
      }
      return { ok: true, params: clean };
    }

    case 'institution': {
      const names = asStrings(params['names']);
      if (!names) return fail('`names` must be a non-empty list of institution names.');
      return { ok: true, params: { names } };
    }

    case 'school_stage': {
      const stages = asStrings(params['stages']);
      if (!stages) return fail(`\`stages\` must be a non-empty list, from: ${SCHOOL_SCOPES.join(', ')}.`);
      const unknown = stages.find((stage) => !(SCHOOL_SCOPES as readonly string[]).includes(stage));
      if (unknown)
        return fail(`"${unknown}" is not a school stage. Expected one of: ${SCHOOL_SCOPES.join(', ')}.`);
      if (params['onlyClosures'] !== undefined && typeof params['onlyClosures'] !== 'boolean') {
        return fail('`onlyClosures` must be true or false.');
      }
      return {
        ok: true,
        params: { stages, ...(params['onlyClosures'] === true ? { onlyClosures: true } : {}) },
      };
    }

    case 'impact': {
      const checked = checkImpactKeys(params['keys'], 'keys');
      if ('error' in checked) return fail(checked.error);
      return { ok: true, params: { keys: checked.keys } };
    }

    case 'matter': {
      const matterIds = asStrings(params['matterIds']);
      if (!matterIds) return fail('`matterIds` must be a non-empty list of matter ids.');
      return { ok: true, params: { matterIds } };
    }

    case 'deadline': {
      const withinDays = finiteNumber(params['withinDays']);
      if (withinDays === null || !Number.isInteger(withinDays)) {
        return fail('`withinDays` must be a whole number of days, e.g. 7.');
      }
      if (withinDays < 1 || withinDays > MAX_WITHIN_DAYS) {
        return fail(`\`withinDays\` must be between 1 and ${MAX_WITHIN_DAYS}.`);
      }
      const clean: Record<string, unknown> = { withinDays };
      if (params['impactKeys'] !== undefined) {
        const checked = checkImpactKeys(params['impactKeys'], 'impactKeys');
        if ('error' in checked) return fail(checked.error);
        clean['impactKeys'] = checked.keys;
      }
      return { ok: true, params: clean };
    }
  }
}
