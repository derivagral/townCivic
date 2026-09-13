import type { Db } from '../db/index.ts';
import { upsertEvent, type UpsertOutcome } from '../db/repo.ts';
import type { NormalizedEvent } from '../types.ts';

/** Both live fetches and archive imports respect the publisher's revision clock. */
export function upsertWordpressTranscript(db: Db, event: NormalizedEvent): UpsertOutcome | 'stale' {
  const existing = db.prepare('SELECT source_id, raw FROM events WHERE id = ?').get(event.id) as
    { source_id: string; raw: string } | undefined;
  if (existing?.source_id === event.sourceId) {
    const previous = JSON.parse(existing.raw) as Record<string, unknown>;
    const before = Date.parse(String(previous['modifiedAt']));
    const incoming = Date.parse(String(event.raw['modifiedAt']));
    if (Number.isFinite(before) && incoming < before) return 'stale';
  }
  const outcome = upsertEvent(db, event);
  // A metadata-only edit must also advance the clock, without making a revision.
  if (outcome === 'unchanged') {
    db.prepare('UPDATE events SET raw = ? WHERE id = ?').run(JSON.stringify(event.raw), event.id);
  }
  return outcome;
}
