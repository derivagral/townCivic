import { CHANNELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { isBlockedKey } from './blocked.ts';
import { impactKey, parseImpactKey } from './impacts.ts';
import type { SchoolScope } from './impacts.ts';

/**
 * What a reader has told townCivic they want, and where each part came from.
 *
 * A profile here is a document of *preferences*, not a persona. There is no
 * cluster id, no segment, no "similar readers" vector — the whole thing is a
 * list of impact keys with a treatment attached, plus geography, plus the
 * schools they picked. It is meant to be read in full on one page and edited
 * line by line, because a preference a reader cannot see is a preference they
 * cannot correct.
 *
 * Templates ("parent", "retiree") produce exactly these rows and then stop
 * existing. `origin` remembers which template proposed a row, so the editor can
 * say "this came from the parent template" and the reader can throw it out —
 * but nothing downstream ever reads the template name to decide anything. Two
 * readers who accepted different templates and edited to the same rows have
 * identical feeds, which is the property that keeps a template a shortcut
 * rather than an identity.
 */

/**
 * What to do with records carrying a preference's key.
 *
 * `mute` is the strongest and it is still not censorship: it applies to *For
 * You* and to alerts. The chronological record at `/` is never filtered by a
 * profile, so the strongest thing a preference can do is decline to recommend.
 */
export const TREATMENTS = ['immediate', 'digest', 'normal', 'ask', 'downrank', 'mute'] as const;
export type Treatment = (typeof TREATMENTS)[number];

export const TREATMENT_LABELS: Record<Treatment, string> = {
  immediate: 'Immediate',
  digest: 'Digest',
  normal: 'Normal',
  ask: 'Ask',
  downrank: 'Downrank',
  mute: 'Mute',
};

export const TREATMENT_DESCRIPTIONS: Record<Treatment, string> = {
  immediate: 'Alert-eligible, and first in For You.',
  digest: 'Ranked up in For You; gathered into a digest rather than interrupting.',
  normal: 'No adjustment either way.',
  ask: 'Undecided — the setup page will ask once, and does nothing until you answer.',
  downrank: 'Kept, ranked below everything else. Not hidden.',
  mute: 'Never recommended. Still in the full record at /, and still searchable.',
};

/** The score multiplier each treatment contributes. `ask` is deliberately inert. */
export const TREATMENT_WEIGHTS: Record<Treatment, number> = {
  immediate: 3,
  digest: 2,
  normal: 0,
  ask: 0,
  downrank: -1.5,
  mute: Number.NEGATIVE_INFINITY,
};

/**
 * Where a preference came from, and therefore how much authority it carries.
 *
 * This is the table the whole personalization argument rests on. Something a
 * reader typed outranks something a template proposed, which outranks something
 * the system noticed about their behaviour — and the bottom row, "readers like
 * you", is absent rather than small. One town does not produce enough events,
 * readers or interactions for collaborative filtering to be anything but noise
 * with a privacy cost, so there is no code path for it to arrive through later
 * by accident.
 */
export const ORIGINS = ['declared', 'template', 'deterministic', 'suggested'] as const;
export type PreferenceOrigin = (typeof ORIGINS)[number];

export const ORIGIN_AUTHORITY: Record<PreferenceOrigin, number> = {
  /** The reader followed, muted, or edited this themselves. */
  declared: 1,
  /** The reader accepted a template that proposed it, and can see it. */
  template: 0.8,
  /** Geography or an institutional match — a fact, not a guess. */
  deterministic: 0.8,
  /**
   * Derived from what the reader has explicitly done (subscriptions, saved
   * searches), never applied on its own. It exists to raise a question.
   */
  suggested: 0.15,
};

export const ORIGIN_LABELS: Record<PreferenceOrigin, string> = {
  declared: 'You set this',
  template: 'From a template you accepted',
  deterministic: 'Matched by geography or institution',
  suggested: 'Suggested — not applied',
};

/** How wide a topic's geography is drawn. */
export const GEO_SCOPES = ['near_home', 'selected_institutions', 'townwide', 'off'] as const;
export type GeoScope = (typeof GEO_SCOPES)[number];

export const GEO_SCOPE_LABELS: Record<GeoScope, string> = {
  near_home: 'Near home',
  selected_institutions: 'Selected schools / institutions',
  townwide: 'Townwide',
  off: 'Not followed',
};

export interface InterestPreference {
  /** `dimension:value` from the impact vocabulary. */
  key: string;
  treatment: Treatment;
  origin: PreferenceOrigin;
  /** Template that proposed it, for the "where did this come from" column. */
  template?: string;
  /** One sentence the editor shows under the row. */
  note?: string;
}

export interface GeographyPreference {
  channel: Channel;
  scope: GeoScope;
}

export interface HomeLocation {
  /** What the reader typed. Kept so the row is legible without a map. */
  label: string;
  lat: number;
  lon: number;
  /** How far "near home" reaches. Half a mile by default; the reader sets it. */
  radiusMeters: number;
}

export interface Preferences {
  /** Bumped when the document's shape changes, so old profiles stay readable. */
  version: number;
  interests: InterestPreference[];
  geography: GeographyPreference[];
  home: HomeLocation | null;
  /** The stages a reader follows, and the specific schools they picked. */
  schools: { stages: SchoolScope[]; institutions: string[] };
  /** Templates accepted, for provenance only. Nothing reads these to rank. */
  templates: { id: string; version: string; acceptedAt: string }[];
  updatedAt: string;
}

export const PREFERENCES_VERSION = 1;

/** Roughly half a mile, the radius the zoning-notice statutes tend to use. */
export const DEFAULT_RADIUS_METERS = 805;

/**
 * The profile a reader has before they touch anything.
 *
 * Not empty, and not a persona either: townwide geography on the things that
 * reach everyone, and nothing else. A brand-new reader's For You is close to
 * the chronological record, which is the honest starting point — the system has
 * been told nothing, so it should not be pretending to know anything.
 */
export function defaultPreferences(now = new Date()): Preferences {
  const townwide: Channel[] = ['meetings', 'law', 'elections', 'money'];
  return {
    version: PREFERENCES_VERSION,
    interests: [],
    geography: CHANNELS.map((channel) => ({
      channel,
      scope: townwide.includes(channel) ? 'townwide' : 'near_home',
    })),
    home: null,
    schools: { stages: [], institutions: [] },
    templates: [],
    updatedAt: now.toISOString(),
  };
}

export function findInterest(preferences: Preferences, key: string): InterestPreference | undefined {
  return preferences.interests.find((interest) => interest.key === key);
}

export function treatmentFor(preferences: Preferences, key: string): Treatment {
  return findInterest(preferences, key)?.treatment ?? 'normal';
}

export function scopeFor(preferences: Preferences, channel: Channel): GeoScope {
  return preferences.geography.find((row) => row.channel === channel)?.scope ?? 'townwide';
}

/**
 * Apply one preference row, with the authority ladder deciding who wins.
 *
 * A row a reader set themselves is never overwritten by a template — accepting
 * "retiree" after having muted school budgets must not un-mute them. Equal
 * authority is last-write-wins, which is what makes accepting two templates
 * compose rather than conflict.
 */
export function upsertInterest(preferences: Preferences, next: InterestPreference): Preferences {
  if (isBlockedKey(next.key) || !parseImpactKey(next.key)) return preferences;

  const existing = findInterest(preferences, next.key);
  if (existing && ORIGIN_AUTHORITY[existing.origin] > ORIGIN_AUTHORITY[next.origin]) return preferences;

  const interests = preferences.interests.filter((interest) => interest.key !== next.key);
  interests.push(next);
  interests.sort((a, b) => a.key.localeCompare(b.key));
  return { ...preferences, interests };
}

export function removeInterest(preferences: Preferences, key: string): Preferences {
  return { ...preferences, interests: preferences.interests.filter((i) => i.key !== key) };
}

export function setScope(preferences: Preferences, channel: Channel, scope: GeoScope): Preferences {
  const geography = preferences.geography.filter((row) => row.channel !== channel);
  geography.push({ channel, scope });
  geography.sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
  return { ...preferences, geography };
}

/** The impact keys a reader's selected school stages imply. */
export function schoolKeys(preferences: Preferences): string[] {
  return preferences.schools.stages.map((stage) => impactKey('school', stage));
}

/**
 * Parse a stored profile document, falling back rather than throwing.
 *
 * A profile is the one thing in the database that is not derived from a
 * document, so a malformed one must degrade to "this reader has told us
 * nothing" instead of taking a page down.
 */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return defaultPreferences();
  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const base = defaultPreferences();
    return {
      version: typeof parsed.version === 'number' ? parsed.version : base.version,
      interests: Array.isArray(parsed.interests)
        ? parsed.interests.filter(
            (i): i is InterestPreference =>
              Boolean(i && typeof i.key === 'string') &&
              !isBlockedKey(i.key) &&
              Boolean(parseImpactKey(i.key)) &&
              (TREATMENTS as readonly string[]).includes(i.treatment),
          )
        : [],
      geography: Array.isArray(parsed.geography)
        ? base.geography.map((row) => parsed.geography!.find((saved) => saved.channel === row.channel) ?? row)
        : base.geography,
      home: parsed.home && typeof parsed.home.lat === 'number' ? parsed.home : null,
      schools: {
        stages: Array.isArray(parsed.schools?.stages) ? parsed.schools!.stages : [],
        institutions: Array.isArray(parsed.schools?.institutions) ? parsed.schools!.institutions : [],
      },
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : base.updatedAt,
    };
  } catch {
    return defaultPreferences();
  }
}

export function serializePreferences(preferences: Preferences): string {
  return JSON.stringify({ ...preferences, updatedAt: new Date().toISOString() });
}
