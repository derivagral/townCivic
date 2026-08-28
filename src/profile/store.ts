import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { EventRow } from '../db/repo.ts';
import { listSubscriptions } from '../web/accounts.ts';
import type { LatLon } from '../geo/project.ts';
import { impactKey, impactLabel } from './impacts.ts';
import { defaultPreferences, parsePreferences, serializePreferences, upsertInterest } from './preferences.ts';
import type { Preferences } from './preferences.ts';
import type { AlertRule } from './alerts.ts';
import type { RankContext } from './score.ts';

/**
 * Where a profile lives, and the only door it goes through.
 *
 * Everything personal is behind these functions on purpose. The pipeline stages
 * never import this file — they write `event_impacts`, which is true of a
 * document rather than about a person — so the boundary between "the town's
 * record" and "one reader" is a directory, not a discipline. If a future change
 * makes a ranking feature out of something a reader did not declare, it has to
 * pass through here first, where it is visible.
 *
 * Every table this touches is disposable except `profiles`. Impacts rebuild
 * from `events`; proposals are history; alert rules are a handful of rows a
 * reader could retype. The preference document is the one thing that would
 * actually be missed, which is worth knowing before pointing a backup at this.
 */

const token = (bytes = 12) => randomBytes(bytes).toString('base64url');
const nowIso = () => new Date().toISOString();

/* --------------------------------------------------------------- profiles */

export function getPreferences(db: Db, userId: string): Preferences {
  const row = db.prepare('SELECT preferences FROM profiles WHERE user_id = ?').get(userId) as
    { preferences: string } | undefined;
  return row ? parsePreferences(row.preferences) : defaultPreferences();
}

export function savePreferences(db: Db, userId: string, preferences: Preferences): void {
  const serialized = serializePreferences(preferences);
  db.prepare(
    `INSERT INTO profiles (user_id, version, preferences, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       version = excluded.version,
       preferences = excluded.preferences,
       updated_at = excluded.updated_at`,
  ).run(userId, preferences.version, serialized, nowIso());
}

export function hasProfile(db: Db, userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 AS hit FROM profiles WHERE user_id = ?').get(userId));
}

/* ------------------------------------------------------------ alert rules */

interface AlertRuleRow {
  id: string;
  user_id: string;
  kind: string;
  label: string;
  params: string;
  enabled: number;
  created_at: string;
}

function toRule(row: AlertRuleRow): AlertRule {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params) as Record<string, unknown>;
  } catch {
    // A rule whose parameters will not parse must not fire on everything, so it
    // degrades to an empty parameter set — which every rule kind treats as "no".
    params = {};
  }
  return {
    id: row.id,
    kind: row.kind as AlertRule['kind'],
    label: row.label,
    params,
    enabled: row.enabled === 1,
  };
}

export function listAlertRules(db: Db, userId: string, options: { enabledOnly?: boolean } = {}): AlertRule[] {
  const rows = db
    .prepare(
      `SELECT * FROM alert_rules WHERE user_id = ?${options.enabledOnly ? ' AND enabled = 1' : ''}
        ORDER BY created_at`,
    )
    .all(userId) as unknown as AlertRuleRow[];
  return rows.map(toRule);
}

export function addAlertRule(
  db: Db,
  userId: string,
  input: { kind: string; label: string; params: Record<string, unknown> },
): AlertRule {
  const rule: AlertRule = {
    id: token(),
    kind: input.kind as AlertRule['kind'],
    label: input.label,
    params: input.params,
    enabled: true,
  };
  db.prepare(
    `INSERT INTO alert_rules (id, user_id, kind, label, params, enabled, created_at)
     VALUES (?,?,?,?,?,1,?)`,
  ).run(rule.id, userId, rule.kind, rule.label, JSON.stringify(rule.params), nowIso());
  return rule;
}

export function removeAlertRule(db: Db, userId: string, id: string): void {
  db.prepare('DELETE FROM alert_rules WHERE user_id = ? AND id = ?').run(userId, id);
}

export function setAlertRuleEnabled(db: Db, userId: string, id: string, enabled: boolean): void {
  db.prepare('UPDATE alert_rules SET enabled = ? WHERE user_id = ? AND id = ?').run(
    enabled ? 1 : 0,
    userId,
    id,
  );
}

/* --------------------------------------------------------------- proposals */

export interface ProposalRow {
  id: string;
  user_id: string;
  request: string;
  proposal: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Keep the proposal, whatever the reader does with it.
 *
 * A declined proposal is the interesting one: it is the record that the system
 * suggested something and was told no. Throwing it away would make "what has it
 * decided about me" unanswerable, and would let the same rejected suggestion be
 * re-offered forever with nothing to show that it had been refused.
 */
export function saveProposal(db: Db, userId: string, request: string, proposal: unknown): string {
  const id = token();
  db.prepare(
    `INSERT INTO profile_proposals (id, user_id, request, proposal, status, created_at)
     VALUES (?,?,?,?,'pending',?)`,
  ).run(id, userId, request, JSON.stringify(proposal), nowIso());
  return id;
}

export function getProposalRow(db: Db, userId: string, id: string): ProposalRow | undefined {
  return db
    .prepare('SELECT * FROM profile_proposals WHERE user_id = ? AND id = ?')
    .get(userId, id) as unknown as ProposalRow | undefined;
}

export function resolveProposal(db: Db, userId: string, id: string, status: 'accepted' | 'declined'): void {
  db.prepare('UPDATE profile_proposals SET status = ?, resolved_at = ? WHERE user_id = ? AND id = ?').run(
    status,
    nowIso(),
    userId,
    id,
  );
}

export function listProposals(db: Db, userId: string, limit = 10): ProposalRow[] {
  return db
    .prepare('SELECT * FROM profile_proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as unknown as ProposalRow[];
}

/* ------------------------------------------------------------ rank context */

/**
 * Assemble everything the ranker needs about a page of records in three
 * queries rather than three per row.
 *
 * The N+1 this avoids is not a micro-optimization: For You renders sixty
 * records, each of which may belong to several matters, each of which may have
 * a point. Done naively that is a couple of hundred statements per page load
 * against a file the same process is writing to.
 */
export function rankContextFor(
  db: Db,
  userId: string,
  rows: EventRow[],
  options: { now?: Date } = {},
): RankContext {
  const followedMatters = new Map<string, string>();
  const followedBodies = new Set<string>();
  const followedChannels = new Set<string>();

  for (const subscription of listSubscriptions(db, userId)) {
    if (subscription.kind === 'matter') followedMatters.set(subscription.value, subscription.label);
    if (subscription.kind === 'body') followedBodies.add(subscription.value);
    if (subscription.kind === 'channel') followedChannels.add(subscription.value);
  }

  const mattersByEvent = new Map<string, string[]>();
  const pointsByEvent = new Map<string, LatLon[]>();

  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const links = db
      .prepare(
        `SELECT me.event_id, me.matter_id, p.lat, p.lon
           FROM matter_events me
           LEFT JOIN places p ON p.matter_id = me.matter_id AND p.lat IS NOT NULL
          WHERE me.event_id IN (${placeholders})`,
      )
      .all(...(rows.map((row) => row.id) as never[])) as unknown as {
      event_id: string;
      matter_id: string;
      lat: number | null;
      lon: number | null;
    }[];

    for (const link of links) {
      const matters = mattersByEvent.get(link.event_id) ?? [];
      matters.push(link.matter_id);
      mattersByEvent.set(link.event_id, matters);

      if (link.lat !== null && link.lon !== null) {
        const points = pointsByEvent.get(link.event_id) ?? [];
        points.push({ lat: link.lat, lon: link.lon });
        pointsByEvent.set(link.event_id, points);
      }
    }
  }

  return {
    ...(options.now ? { now: options.now } : {}),
    pointsByEvent,
    followedMatters,
    followedBodies,
    followedChannels,
    mattersByEvent,
  };
}

/* ------------------------------------------------------------- suggestions */

export interface InterestSuggestion {
  key: string;
  label: string;
  /** The sentence the reader is shown. Always a question, never a notification. */
  ask: string;
  /** What it was derived from, in the reader's own actions. */
  evidence: string;
}

/**
 * Suggestions derived from what a reader has explicitly done — and nothing else.
 *
 * The obvious thing to build here is click-through learning, and it is the
 * wrong thing to build here. People open confusing notices, alarming ones, and
 * badly summarized ones; on a corpus this small "opened it" is at least as
 * likely to mean "could not tell what this was" as "want more of this". So the
 * only evidence this function will look at is a subscription, which is a
 * deliberate act the reader can point to.
 *
 * Nothing here is applied. A suggestion becomes a preference when the reader
 * says yes, at which point its origin is `declared` — because it now is.
 */
export function suggestInterests(db: Db, userId: string, preferences: Preferences): InterestSuggestion[] {
  const suggestions: InterestSuggestion[] = [];
  const already = new Set(preferences.interests.map((interest) => interest.key));

  // Bodies a reader follows imply the services those bodies run. Deliberately a
  // small hand-written table: the mapping is jurisdiction knowledge, and a
  // wrong row here is a wrong question rather than a silently wrong feed.
  const BODY_INTERESTS: { match: RegExp; key: string }[] = [
    { match: /conservation/i, key: impactKey('service', 'parks') },
    { match: /council on aging|senior/i, key: impactKey('service', 'senior_services') },
    { match: /school committee/i, key: impactKey('school', 'districtwide') },
    { match: /library|trustees of the public library/i, key: impactKey('service', 'libraries') },
    { match: /board of health/i, key: impactKey('service', 'health') },
    { match: /housing|affordable/i, key: impactKey('service', 'housing') },
    { match: /public works|dpw|traffic|transportation/i, key: impactKey('service', 'roads') },
    { match: /warrant committee|finance|select board/i, key: impactKey('finance', 'operating_budget') },
    { match: /recreation|parks/i, key: impactKey('service', 'parks') },
  ];

  const counts = new Map<string, { key: string; bodies: Set<string> }>();
  for (const subscription of listSubscriptions(db, userId)) {
    if (subscription.kind !== 'body' && subscription.kind !== 'matter') continue;
    for (const rule of BODY_INTERESTS) {
      if (!rule.match.test(subscription.label)) continue;
      const entry = counts.get(rule.key) ?? { key: rule.key, bodies: new Set<string>() };
      entry.bodies.add(subscription.label);
      counts.set(rule.key, entry);
    }
  }

  for (const entry of counts.values()) {
    if (already.has(entry.key)) continue;
    const bodies = [...entry.bodies];
    suggestions.push({
      key: entry.key,
      label: impactLabel(entry.key),
      ask: `Add ${impactLabel(entry.key).toLowerCase()} to your interests?`,
      evidence: `You follow ${bodies.length === 1 ? bodies[0]! : `${bodies.length} bodies including ${bodies[0]!}`}.`,
    });
  }

  return suggestions.sort((a, b) => a.key.localeCompare(b.key));
}

/** Accept one suggestion. It becomes a declared preference, because it now is. */
export function acceptSuggestion(preferences: Preferences, key: string): Preferences {
  return upsertInterest(preferences, {
    key,
    treatment: 'digest',
    origin: 'declared',
    note: 'Accepted from a suggestion.',
  });
}

/**
 * Institution names the extractor has actually seen in this town's records.
 *
 * The school picker offers these rather than a hard-coded list, so it stays
 * right when the town opens a building or renames one, and so a reader is never
 * offered a school that will never appear in a record.
 */
export function knownInstitutions(db: Db, jurisdiction: string, limit = 60): string[] {
  const rows = db
    .prepare(
      `SELECT i.value AS value, count(*) AS n
         FROM event_impacts i
         JOIN events e ON e.id = i.event_id
        WHERE i.dimension = 'institution' AND e.jurisdiction = ?
        GROUP BY i.value
        ORDER BY n DESC, i.value ASC
        LIMIT ?`,
    )
    .all(jurisdiction, limit) as unknown as { value: string; n: number }[];
  return rows.map((row) => row.value);
}
