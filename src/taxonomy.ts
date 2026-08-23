/**
 * The controlled vocabularies the whole pipeline agrees on.
 *
 * Everything here is deterministic and hand-maintained on purpose. The system
 * is not deciding what is newsworthy — it decides only: is this authoritative,
 * does it concern this jurisdiction, and what kind of thing is it.
 */

/** Who published the record, not who it is about. */
export const LEVELS = ['municipal', 'regional', 'state', 'federal'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Feed channels. Each maps to an Atom/JSON feed at /feeds/<channel>.
 * Ordered roughly by day-to-day usefulness at town scale.
 */
export const CHANNELS = [
  'meetings',
  'land-use',
  'money',
  'law',
  'elections',
  'schools',
  'public-safety',
  'courts',
  'state-federal',
  'admin',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  meetings: 'Meetings & Government',
  'land-use': 'Land & Development',
  money: 'Money',
  law: 'Law & Rules',
  elections: 'Elections & Civic Admin',
  schools: 'Schools',
  'public-safety': 'Public Safety & Infrastructure',
  courts: 'Courts',
  'state-federal': 'State & Federal, Locally',
  admin: 'Routine Administration',
};

export const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  meetings: 'Select Board, Town Meeting, committee agendas, minutes, votes and appointments.',
  'land-use': 'Planning Board, ZBA, Conservation Commission, permits, subdivisions, zoning.',
  money: 'Budgets, warrants, contracts, RFPs, purchases, grants, debt actions.',
  law: 'New and amended bylaws, AG approvals and disapprovals, regulations.',
  elections: 'Elections, ballot questions, vacancies, appointments, clerk deadlines.',
  schools: 'School Committee budgets, contracts, policy and facility decisions.',
  'public-safety': 'Road closures, water restrictions, emergency notices, safety policy.',
  courts: 'Cases where the town, its officials or its land-use decisions are at issue.',
  'state-federal': 'State and federal actions that resolve to this municipality.',
  admin: 'Ordinary licenses, small purchases, routine renewals. Collapsed by default.',
};

/** What actually happened. Kept coarse in v0 — refine as adapters improve. */
export const EVENT_TYPES = [
  'meeting_notice',
  'meeting_agenda',
  'meeting_minutes',
  'hearing_scheduled',
  'bid_posted',
  'warrant_article',
  'bylaw_decision',
  'news_notice',
  'alert',
  'election_notice',
  'document_posted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  meeting_notice: 'Meeting notice',
  meeting_agenda: 'Agenda',
  meeting_minutes: 'Minutes',
  hearing_scheduled: 'Hearing scheduled',
  bid_posted: 'Bid / RFP posted',
  warrant_article: 'Warrant article',
  bylaw_decision: 'AG bylaw decision',
  news_notice: 'Notice',
  alert: 'Alert',
  election_notice: 'Election notice',
  document_posted: 'Document posted',
};

/** Default treatment, straight out of the channel table. */
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Source tiers.
 *   1 — the town itself (the canonical record)
 *   2 — state systems queried for the town
 *   3 — federal systems queried for the town
 *   4 — town-controlled peripheral accounts; discovery only, never canonical
 */
export const TIERS = [1, 2, 3, 4] as const;
export type Tier = (typeof TIERS)[number];

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}
