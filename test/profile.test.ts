import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { addSubscription, createUser } from '../src/web/accounts.ts';
import { BLOCKED_DOMAINS, DECLARED_ONLY, findBlockedMentions, isBlockedKey } from '../src/profile/blocked.ts';
import {
  ORIGIN_AUTHORITY,
  defaultPreferences,
  findInterest,
  parsePreferences,
  removeInterest,
  scopeFor,
  serializePreferences,
  setScope,
  treatmentFor,
  upsertInterest,
} from '../src/profile/preferences.ts';
import { allImpactKeys, impactKey, impactLabel, parseImpactKey } from '../src/profile/impacts.ts';
import {
  acceptSuggestion,
  addAlertRule,
  getPreferences,
  listAlertRules,
  listProposals,
  rankContextFor,
  removeAlertRule,
  resolveProposal,
  saveProposal,
  savePreferences,
  setAlertRuleEnabled,
  suggestInterests,
} from '../src/profile/store.ts';

/**
 * The tests that matter here are the refusals.
 *
 * Anyone can check that a preference round-trips. What is worth pinning down is
 * that a blocked domain cannot get into a profile by any route — not through the
 * editor, not through a stored document, not through a template — and that a
 * template can never quietly overwrite something a reader set themselves. Both
 * are one-line mistakes to make and invisible once made.
 */

let db: Db;
let userId: string;

beforeEach(() => {
  db = openDb(':memory:');
  const result = createUser(db, { email: 'reader@example.com', password: 'correct-horse-battery' });
  userId = result.user!.id;
});

describe('the impact vocabulary', () => {
  it('round-trips every closed-vocabulary key', () => {
    for (const key of allImpactKeys()) {
      const parsed = parseImpactKey(key);
      expect(parsed, key).not.toBeNull();
      expect(impactKey(parsed!.dimension, parsed!.value)).toBe(key);
    }
  });

  it('labels every key as something other than the key itself', () => {
    for (const key of allImpactKeys()) {
      expect(impactLabel(key), key).not.toBe(key);
    }
  });

  it('rejects a key that is not in the vocabulary', () => {
    expect(parseImpactKey('income:low')).toBeNull();
    expect(parseImpactKey('service')).toBeNull();
    expect(parseImpactKey('')).toBeNull();
  });
});

describe('blocked domains', () => {
  it('names every domain it refuses to infer', () => {
    // The list is the product here: an unnamed refusal is indistinguishable
    // from a quiet inference, so each entry has to carry its own explanation.
    for (const domain of BLOCKED_DOMAINS) {
      expect(domain.label.length, domain.id).toBeGreaterThan(0);
      expect(domain.say.length, domain.id).toBeGreaterThan(20);
    }
    expect(BLOCKED_DOMAINS.map((d) => d.id)).toContain('income');
    expect(BLOCKED_DOMAINS.map((d) => d.id)).toContain('disability');
    expect(BLOCKED_DOMAINS.map((d) => d.id)).toContain('household_composition');
  });

  it('gives every declared-only attribute a reason it is not inferred', () => {
    for (const item of DECLARED_ONLY) {
      expect(item.why.length, item.id).toBeGreaterThan(20);
    }
  });

  it('finds a mention without acting on it', () => {
    const found = findBlockedMentions("I'm retired, on a fixed income, and I use a wheelchair");
    const ids = found.map((mention) => mention.domain);
    expect(ids).toContain('income');
    expect(ids).toContain('disability');
    for (const mention of found) expect(mention.matched.length).toBeGreaterThan(0);
  });

  it('does not read a street name as a race', () => {
    // "Black" is a street, a pond and a hill in half the towns in New England,
    // and a false positive here would put a refusal notice on an ordinary
    // land-use setup request.
    expect(findBlockedMentions('records near Blue Hill and White Street').map((m) => m.domain)).not.toContain(
      'race_ethnicity',
    );
  });

  it('refuses a preference key namespaced to a blocked domain', () => {
    expect(isBlockedKey('income:low')).toBe(true);
    expect(isBlockedKey('disability:mobility')).toBe(true);
    expect(isBlockedKey('service:schools')).toBe(false);
  });
});

describe('the preference document', () => {
  it('starts townwide on what reaches everyone and near-home on the rest', () => {
    const preferences = defaultPreferences();
    expect(scopeFor(preferences, 'law')).toBe('townwide');
    expect(scopeFor(preferences, 'elections')).toBe('townwide');
    expect(scopeFor(preferences, 'land-use')).toBe('near_home');
    expect(preferences.interests).toEqual([]);
  });

  it('lets a reader outrank a template, and not the other way round', () => {
    let preferences = defaultPreferences();
    preferences = upsertInterest(preferences, {
      key: impactKey('service', 'schools'),
      treatment: 'mute',
      origin: 'declared',
    });
    preferences = upsertInterest(preferences, {
      key: impactKey('service', 'schools'),
      treatment: 'immediate',
      origin: 'template',
      template: 'parent',
    });
    expect(treatmentFor(preferences, impactKey('service', 'schools'))).toBe('mute');

    // The reader changing their mind still works — equal authority is last write.
    preferences = upsertInterest(preferences, {
      key: impactKey('service', 'schools'),
      treatment: 'digest',
      origin: 'declared',
    });
    expect(treatmentFor(preferences, impactKey('service', 'schools'))).toBe('digest');
  });

  it('ranks the origins the way the design argues they should rank', () => {
    expect(ORIGIN_AUTHORITY.declared).toBeGreaterThan(ORIGIN_AUTHORITY.template);
    expect(ORIGIN_AUTHORITY.template).toBeGreaterThan(ORIGIN_AUTHORITY.suggested);
    // "Readers like you" is absent rather than small, so there is no row here
    // to accidentally raise later.
    expect(Object.keys(ORIGIN_AUTHORITY)).not.toContain('similarity');
  });

  it('refuses to store a key outside the vocabulary', () => {
    const preferences = upsertInterest(defaultPreferences(), {
      key: 'income:low',
      treatment: 'immediate',
      origin: 'declared',
    });
    expect(preferences.interests).toEqual([]);
  });

  it('drops a blocked key smuggled into a stored document', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        interests: [
          { key: 'income:low', treatment: 'immediate', origin: 'declared' },
          { key: 'service:parks', treatment: 'digest', origin: 'declared' },
          { key: 'service:parks', treatment: 'not-a-treatment', origin: 'declared' },
        ],
      }),
    );
    expect(parsed.interests.map((i) => i.key)).toEqual(['service:parks']);
  });

  it('degrades to "told us nothing" rather than throwing on a broken document', () => {
    expect(parsePreferences('{not json').interests).toEqual([]);
    expect(parsePreferences(null).geography.length).toBeGreaterThan(0);
  });

  it('round-trips through storage', () => {
    let preferences = setScope(defaultPreferences(), 'schools', 'selected_institutions');
    preferences = upsertInterest(preferences, {
      key: impactKey('school', 'elementary'),
      treatment: 'immediate',
      origin: 'declared',
    });
    const parsed = parsePreferences(serializePreferences(preferences));
    expect(scopeFor(parsed, 'schools')).toBe('selected_institutions');
    expect(findInterest(parsed, 'school:elementary')?.treatment).toBe('immediate');

    expect(findInterest(removeInterest(parsed, 'school:elementary'), 'school:elementary')).toBeUndefined();
  });
});

describe('the profile store', () => {
  it('returns a default profile for a reader who has never saved one', () => {
    expect(getPreferences(db, userId).interests).toEqual([]);
  });

  it('saves and reloads a profile', () => {
    const preferences = upsertInterest(defaultPreferences(), {
      key: impactKey('finance', 'property_tax'),
      treatment: 'digest',
      origin: 'declared',
    });
    savePreferences(db, userId, preferences);
    expect(treatmentFor(getPreferences(db, userId), 'finance:property_tax')).toBe('digest');
  });

  it('keeps alert rules, pauses them, and removes them', () => {
    const rule = addAlertRule(db, userId, {
      kind: 'near_home',
      label: 'Zoning within ½ mile',
      params: { channels: ['land-use'], radiusMeters: 805 },
    });
    expect(listAlertRules(db, userId)).toHaveLength(1);

    setAlertRuleEnabled(db, userId, rule.id, false);
    expect(listAlertRules(db, userId, { enabledOnly: true })).toHaveLength(0);
    expect(listAlertRules(db, userId)[0]!.enabled).toBe(false);

    removeAlertRule(db, userId, rule.id);
    expect(listAlertRules(db, userId)).toHaveLength(0);
  });

  it('keeps a declined proposal, because a refusal is the interesting record', () => {
    const id = saveProposal(db, userId, 'set me up as a retiree', { changes: [] });
    resolveProposal(db, userId, id, 'declined');
    const history = listProposals(db, userId);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe('declined');
    expect(history[0]!.request).toBe('set me up as a retiree');
  });

  it('suggests from subscriptions the reader created, and never applies one', () => {
    addSubscription(db, userId, {
      kind: 'body',
      value: 'Conservation Commission',
      label: 'Conservation Commission',
    });
    const preferences = getPreferences(db, userId);
    const suggestions = suggestInterests(db, userId, preferences);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.ask).toMatch(/\?$/);
    expect(suggestions[0]!.evidence).toContain('Conservation Commission');
    // Nothing was applied by asking.
    expect(getPreferences(db, userId).interests).toEqual([]);

    const accepted = acceptSuggestion(preferences, suggestions[0]!.key);
    // Accepting makes it declared, because at that point it is.
    expect(findInterest(accepted, suggestions[0]!.key)?.origin).toBe('declared');
  });

  it('stops suggesting something the reader already has an opinion about', () => {
    addSubscription(db, userId, {
      kind: 'body',
      value: 'Council on Aging',
      label: 'Council on Aging',
    });
    const preferences = upsertInterest(defaultPreferences(), {
      key: impactKey('service', 'senior_services'),
      treatment: 'mute',
      origin: 'declared',
    });
    expect(suggestInterests(db, userId, preferences).map((s) => s.key)).not.toContain(
      'service:senior_services',
    );
  });

  it('assembles a rank context without a per-row query', () => {
    const context = rankContextFor(db, userId, []);
    expect(context.followedMatters?.size).toBe(0);
    expect(context.pointsByEvent?.size).toBe(0);
  });
});
