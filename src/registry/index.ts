import { sourceSchema } from '../types.ts';
import type { SourceDef, SourceInput } from '../types.ts';
import type { Db } from '../db/index.ts';
import { upsertSource } from '../db/repo.ts';
import { miltonSources } from './milton-ma.ts';

/** Every jurisdiction the build knows about. Adding a town is adding a file here. */
const REGISTRIES: Record<string, SourceInput[]> = {
  'milton-ma': miltonSources,
};

export function listJurisdictions(): string[] {
  return Object.keys(REGISTRIES);
}

export function loadSources(jurisdiction?: string): SourceDef[] {
  const raw = jurisdiction ? (REGISTRIES[jurisdiction] ?? []) : Object.values(REGISTRIES).flat();
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

/** Materialize the registry into the database so the UI can join against it. */
export function syncSources(db: Db, jurisdiction?: string): SourceDef[] {
  const sources = loadSources(jurisdiction);
  for (const source of sources) upsertSource(db, source);
  return sources;
}

export { miltonSources };
