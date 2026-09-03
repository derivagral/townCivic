import { sourceSchema } from '../types.ts';
import type { SourceDef, SourceInput } from '../types.ts';
import type { Db } from '../db/index.ts';
import { upsertJurisdiction, upsertSource } from '../db/repo.ts';
import { unknownJurisdiction } from './profile.ts';
import type { JurisdictionProfile } from './profile.ts';
import { miltonProfile } from './milton-ma.ts';
import { weymouthProfile } from './weymouth-ma.ts';
import { hullProfile } from './hull-ma.ts';
import { scituateProfile } from './scituate-ma.ts';
import { braintreeProfile } from './braintree-ma.ts';
import { rocklandProfile } from './rockland-ma.ts';
import { walthamProfile } from './waltham-ma.ts';

/**
 * Every jurisdiction the build knows about. Adding a town is a file plus a line
 * here — nothing else in the codebase names a town.
 *
 * Order is display order: the towns with real data first, then the ones waiting
 * on a `discover` run. Braintree, Rockland and Waltham are in that second group
 * — every one of their sources is registered and off, so they cost the schedule
 * nothing until someone has verified them.
 */
const REGISTRY: JurisdictionProfile[] = [
  miltonProfile,
  weymouthProfile,
  hullProfile,
  scituateProfile,
  braintreeProfile,
  rocklandProfile,
  walthamProfile,
];

const BY_ID = new Map(REGISTRY.map((profile) => [profile.id, profile]));

export function listJurisdictions(): string[] {
  return REGISTRY.map((profile) => profile.id);
}

export function listProfiles(): JurisdictionProfile[] {
  return [...REGISTRY];
}

export function hasJurisdiction(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * The profile for a jurisdiction id.
 *
 * Never throws. Rows outlive registries — a database restored from an older
 * build, or a town taken back out of `REGISTRY` — and the pipeline reading such
 * a row should degrade to statewide defaults rather than crash. `status`
 * reports those rows as orphans, and `clear --orphans` removes them.
 */
export function getProfile(id: string): JurisdictionProfile {
  return BY_ID.get(id) ?? unknownJurisdiction(id);
}

/** How the UI says a town's name, without loading the whole profile. */
export function jurisdictionLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function loadSources(jurisdiction?: string): SourceDef[] {
  const raw: SourceInput[] = jurisdiction
    ? (BY_ID.get(jurisdiction)?.sources ?? [])
    : REGISTRY.flatMap((profile) => profile.sources);

  const parsed = raw.map((s, i) => {
    const result = sourceSchema.safeParse(s);
    if (!result.success) {
      throw new Error(
        `Invalid source at index ${i} (${s.id ?? 'unknown id'}): ${result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  });

  const seen = new Set<string>();
  for (const source of parsed) {
    if (seen.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    seen.add(source.id);
  }
  return parsed;
}

/**
 * Materialize the registry into the database so the UI can join against it.
 *
 * Towns are written first: `sources.jurisdiction` points at them, and the town
 * switcher is a query against `jurisdictions` rather than a constant in the
 * web layer.
 */
export function syncSources(db: Db, jurisdiction?: string): SourceDef[] {
  syncJurisdictions(db, jurisdiction);
  const sources = loadSources(jurisdiction);
  for (const source of sources) upsertSource(db, source);
  return sources;
}

export function syncJurisdictions(db: Db, jurisdiction?: string): JurisdictionProfile[] {
  const profiles = jurisdiction ? REGISTRY.filter((profile) => profile.id === jurisdiction) : [...REGISTRY];
  for (const profile of profiles) upsertJurisdiction(db, profile);
  return profiles;
}

/**
 * Jurisdictions with rows in the database that the registry no longer knows.
 *
 * The one thing a multi-town database can accumulate that a single-town one
 * could not: a town that was ingested, then removed from the build. Its records
 * are still real records, so nothing deletes them automatically — but an
 * operator should be told they are there.
 */
export function orphanJurisdictions(db: Db): { jurisdiction: string; events: number }[] {
  const rows = db
    .prepare(
      `SELECT jurisdiction, count(*) AS events FROM events GROUP BY jurisdiction
        UNION
       SELECT id AS jurisdiction, 0 AS events FROM jurisdictions
        WHERE id NOT IN (SELECT jurisdiction FROM events)`,
    )
    .all() as unknown as { jurisdiction: string; events: number }[];

  const merged = new Map<string, number>();
  for (const row of rows)
    merged.set(row.jurisdiction, Math.max(merged.get(row.jurisdiction) ?? 0, row.events));

  return [...merged.entries()]
    .filter(([id]) => !BY_ID.has(id))
    .map(([jurisdiction, events]) => ({ jurisdiction, events }))
    .sort((a, b) => b.events - a.events);
}

export {
  miltonProfile,
  weymouthProfile,
  hullProfile,
  scituateProfile,
  braintreeProfile,
  rocklandProfile,
  walthamProfile,
};
export type { JurisdictionProfile };
