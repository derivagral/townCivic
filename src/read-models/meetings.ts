import type { Db } from '../db/index.ts';
import {
  countEvents,
  facetCounts,
  queryEvents,
  searchEvidenceForEvents,
  type EventQuery,
} from '../db/repo.ts';

export const MEETING_TYPES = [
  'meeting_transcript',
  'meeting_notice',
  'meeting_agenda',
  'meeting_minutes',
  'hearing_scheduled',
];
export interface MeetingFilters {
  q: string;
  body: string;
  kind: 'transcripts' | 'all';
  when: 'all' | 'past' | 'upcoming';
  page: number;
}

/** Both HTML and mobile use this query so transcript coverage/search cannot drift. */
export function readMeetings(db: Db, jurisdiction: string, filters: MeetingFilters, pageSize: number) {
  const base: EventQuery = {
    jurisdiction,
    eventTypes: filters.kind === 'transcripts' ? ['meeting_transcript'] : MEETING_TYPES,
    includeAdmin: true,
    when: filters.when,
    ...(filters.q ? { q: filters.q } : {}),
  };
  const query = { ...base, ...(filters.body ? { bodies: [filters.body] } : {}) };
  const rows = queryEvents(db, { ...query, limit: pageSize, offset: (filters.page - 1) * pageSize });
  return {
    rows,
    total: countEvents(db, query),
    boards: facetCounts(db, 'body', base),
    evidence: Object.fromEntries(
      searchEvidenceForEvents(
        db,
        rows.map((r) => r.id),
        filters.q,
      ).map((e) => [e.eventId, e]),
    ),
  };
}
