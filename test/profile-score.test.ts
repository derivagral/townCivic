import { describe, expect, it } from 'vitest';
import type { EventRow } from '../src/db/repo.ts';
import type { Impact } from '../src/profile/impacts.ts';
import { impactKey } from '../src/profile/impacts.ts';
import {
  DEFAULT_RADIUS_METERS,
  defaultPreferences,
  setScope,
  upsertInterest,
} from '../src/profile/preferences.ts';
import type { Preferences } from '../src/profile/preferences.ts';
import { explain, rankEvents, scoreEvent } from '../src/profile/score.ts';
import type { RankContext } from '../src/profile/score.ts';
import { describeRule, evaluateAlerts, suggestedRules, validateRule } from '../src/profile/alerts.ts';
import type { AlertRule } from '../src/profile/alerts.ts';

/**
 * Ranking is only defensible if it can be argued with, so that is what these
 * check: that every point of score turns into a sentence, that a reader's own
 * word beats a template's, that muting keeps a record out of a recommendation
 * without touching the record, and that a rule which cannot be evaluated stays
 * silent instead of firing on whatever it happens to have.
 */

const HOME = { label: '271 Pleasant Street', lat: 42.25, lon: -71.07, radiusMeters: DEFAULT_RADIUS_METERS };

/** Roughly 300 m north of home, and roughly 3 km north of it. */
const NEARBY = { lat: 42.2527, lon: -71.07 };
const FAR = { lat: 42.28, lon: -71.07 };

let seq = 0;

function row(opts: Partial<EventRow> = {}): EventRow {
  seq += 1;
  const occurred = opts.occurred_at ?? '2026-08-20T19:00:00-04:00';
  return {
    id: `event-${seq}`,
    jurisdiction: 'milton-ma',
    source_id: 'src',
    level: 'municipal',
    agency: 'Town of Milton',
    body: 'Planning Board',
    channel: 'land-use',
    event_type: 'meeting_agenda',
    priority: 'medium',
    title: `Record ${seq}`,
    summary: null,
    url: 'https://example.test/1',
    document_url: null,
    occurred_at: occurred,
    published_at: occurred,
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
    revised_at: null,
    revision: 1,
    subjects: '[]',
    tags: '[]',
    content_hash: `hash-${seq}`,
    raw: '{}',
    doc_text: null,
    extracted_at: null,
    ...opts,
  } as EventRow;
}

function impact(key: string, extra: Partial<Impact> = {}): Impact {
  const [dimension, ...rest] = key.split(':');
  return {
    dimension: dimension as Impact['dimension'],
    value: rest.join(':'),
    evidence: 'the notice said so',
    detail: null,
    confidence: 'exact',
    rule: 'test',
    ...extra,
  };
}

const NOW = new Date('2026-08-25T12:00:00Z');
const context = (extra: RankContext = {}): RankContext => ({ now: NOW, ...extra });

const withInterest = (
  key: string,
  treatment: 'immediate' | 'digest' | 'downrank' | 'mute',
  origin: 'declared' | 'template' | 'suggested' = 'declared',
): Preferences => upsertInterest(defaultPreferences(), { key, treatment, origin });

describe('scoring one record', () => {
  it('turns every point of score into a sentence', () => {
    const scored = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'digest'),
      context(),
    );

    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons.length).toBeGreaterThan(0);
    expect(scored.explanation).toMatch(/^Shown because /);
    expect(scored.explanation.endsWith('.')).toBe(true);
  });

  it('lets what a reader declared outrank what a template proposed', () => {
    // Same treatment, same impact, different provenance. This is the authority
    // ladder as an observable fact rather than a paragraph of documentation.
    const declared = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'digest', 'declared'),
      context(),
    );
    const fromTemplate = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'digest', 'template'),
      context(),
    );

    expect(declared.score).toBeGreaterThan(fromTemplate.score);
  });

  it('ranks an immediate interest above a digest one', () => {
    const urgent = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'immediate'),
      context(),
    );
    const ordinary = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'digest'),
      context(),
    );
    expect(urgent.score).toBeGreaterThan(ordinary.score);
  });

  it('marks a muted record muted', () => {
    const scored = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'mute'),
      context(),
    );
    expect(scored.muted).toBe(true);
  });

  it('names a distance a person would recognise', () => {
    const preferences = { ...defaultPreferences(), home: HOME };
    const scored = scoreEvent(
      row({ id: 'near' }),
      [impact(impactKey('property', 'geography'))],
      preferences,
      context({ pointsByEvent: new Map([['near', [NEARBY]]]) }),
    );

    const geography = scored.reasons.find((reason) => reason.kind === 'geography');
    expect(geography).toBeDefined();
    expect(geography!.text).toMatch(/home/);
    expect(geography!.text).toMatch(/mile|metres|feet|yards|street/i);
  });

  it('scores nothing for near-home when the reader has set no home', () => {
    // The alternative is a scope that silently matches the whole town, which
    // looks configured and is not.
    const scored = scoreEvent(
      row({ id: 'near' }),
      [impact(impactKey('property', 'geography'))],
      defaultPreferences(),
      context({ pointsByEvent: new Map([['near', [NEARBY]]]) }),
    );
    expect(scored.reasons.some((reason) => reason.kind === 'geography')).toBe(false);
  });

  it('scores nothing for a point outside the radius', () => {
    const preferences = { ...defaultPreferences(), home: HOME };
    const scored = scoreEvent(
      row({ id: 'far' }),
      [impact(impactKey('property', 'geography'))],
      preferences,
      context({ pointsByEvent: new Map([['far', [FAR]]]) }),
    );
    expect(scored.reasons.some((reason) => reason.kind === 'geography')).toBe(false);
  });

  it('puts a followed matter above everything else', () => {
    const followed = scoreEvent(
      row({ id: 'followed' }),
      [],
      defaultPreferences(),
      context({
        followedMatters: new Map([['matter-1', '271 Pleasant Street']]),
        mattersByEvent: new Map([['followed', ['matter-1']]]),
      }),
    );
    const interest = scoreEvent(
      row(),
      [impact(impactKey('service', 'housing'))],
      withInterest(impactKey('service', 'housing'), 'immediate'),
      context(),
    );
    expect(followed.score).toBeGreaterThan(interest.score);
  });

  it('never returns a shown record with nothing to say for it', () => {
    const scored = scoreEvent(row(), [], defaultPreferences(), context());
    expect(scored.explanation.length).toBeGreaterThan(0);
    expect(scored.reasons.length).toBeGreaterThan(0);
  });
});

describe('explaining a record', () => {
  it('joins at most three clauses into one sentence', () => {
    const sentence = explain([
      { kind: 'school', text: 'it concerns your selected elementary school', weight: 3, origin: 'declared' },
      { kind: 'interest', text: 'it includes a budget vote', weight: 2, origin: 'declared' },
      { kind: 'deadline', text: 'it has a public-comment deadline Friday', weight: 2, origin: 'declared' },
      { kind: 'recency', text: 'it was published this week', weight: 0.1, origin: 'deterministic' },
    ]);

    expect(sentence).toBe(
      'Shown because it concerns your selected elementary school, it includes a budget vote, and ' +
        'it has a public-comment deadline Friday.',
    );
  });

  it('drops a clause a more specific one already says', () => {
    // "it has a deadline" and "it has a deadline Friday" are both true and both
    // earn score. Read together they are a stutter, and the vaguer one wastes
    // one of the three clauses the sentence gets.
    const sentence = explain([
      { kind: 'deadline', text: 'it has a deadline Friday', weight: 2, origin: 'deterministic' },
      { kind: 'interest', text: 'it has a deadline', weight: 1.6, origin: 'template' },
      { kind: 'recency', text: 'it has not happened yet', weight: 0.5, origin: 'deterministic' },
    ]);
    expect(sentence).toBe('Shown because it has a deadline Friday and it has not happened yet.');
  });

  it('falls back to something true rather than to nothing', () => {
    // A record shown with no sentence under it is the failure this whole design
    // set out to avoid, so the floor is a claim that is always true rather than
    // an empty string.
    const sentence = explain([]);
    expect(sentence).toMatch(/^Shown because /);
    expect(sentence.endsWith('.')).toBe(true);
  });
});

describe('ranking a page', () => {
  const housing = impactKey('service', 'housing');

  it('drops muted records from For You, and only from For You', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    const impacts = new Map([
      ['a', [impact(housing)]],
      ['b', []],
    ]);
    const ranked = rankEvents(rows, impacts, withInterest(housing, 'mute'), context());

    expect(ranked.map((item) => item.row.id)).not.toContain('a');
    // The record itself is untouched: nothing here filters `/`.
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps a downranked record, below a neutral one', () => {
    const rows = [row({ id: 'down' }), row({ id: 'plain' })];
    const impacts = new Map([
      ['down', [impact(housing)]],
      ['plain', []],
    ]);
    const ranked = rankEvents(rows, impacts, withInterest(housing, 'downrank'), context());

    expect(ranked.map((item) => item.row.id)).toContain('down');
    expect(ranked.map((item) => item.row.id)).toEqual(['plain', 'down']);
  });

  it('is stable: the same records in a different order rank the same', () => {
    const a = row({ id: 'a' });
    const b = row({ id: 'b' });
    const c = row({ id: 'c' });
    const impacts = new Map([
      ['a', [impact(housing)]],
      ['b', []],
      ['c', [impact(impactKey('service', 'transit'))]],
    ]);
    const preferences = withInterest(housing, 'digest');

    const forwards = rankEvents([a, b, c], impacts, preferences, context()).map((i) => i.row.id);
    const backwards = rankEvents([c, b, a], impacts, preferences, context()).map((i) => i.row.id);
    expect(backwards).toEqual(forwards);
  });

  it('explains every record it shows', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const ranked = rankEvents(rows, new Map(), defaultPreferences(), context());
    for (const item of ranked) expect(item.explanation, item.row.id).not.toBe('');
  });
});

describe('alert rules', () => {
  const nearHome: AlertRule = {
    id: 'rule-1',
    kind: 'near_home',
    label: 'Zoning within ½ mile',
    params: { channels: ['land-use'], radiusMeters: DEFAULT_RADIUS_METERS },
    enabled: true,
  };
  const preferences = { ...defaultPreferences(), home: HOME };

  it('fires on a land-use record inside the radius', () => {
    const hits = evaluateAlerts(
      [nearHome],
      row({ id: 'near', channel: 'land-use' }),
      [impact(impactKey('property', 'geography'))],
      preferences,
      context({ pointsByEvent: new Map([['near', [NEARBY]]]) }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reason).toMatch(/home/);
  });

  it('does not fire outside the radius', () => {
    const hits = evaluateAlerts(
      [nearHome],
      row({ id: 'far', channel: 'land-use' }),
      [impact(impactKey('property', 'geography'))],
      preferences,
      context({ pointsByEvent: new Map([['far', [FAR]]]) }),
    );
    expect(hits).toEqual([]);
  });

  it('does not fire on a record with no point at all', () => {
    // The failure this prevents is the quiet one: a rule that matches anything
    // it cannot measure looks like it is working right up until it matters.
    const hits = evaluateAlerts(
      [nearHome],
      row({ id: 'placeless', channel: 'land-use' }),
      [],
      preferences,
      context(),
    );
    expect(hits).toEqual([]);
  });

  it('does not fire when the reader has set no home', () => {
    const hits = evaluateAlerts(
      [nearHome],
      row({ id: 'near', channel: 'land-use' }),
      [impact(impactKey('property', 'geography'))],
      defaultPreferences(),
      context({ pointsByEvent: new Map([['near', [NEARBY]]]) }),
    );
    expect(hits).toEqual([]);
  });

  it('does not fire a paused rule', () => {
    const hits = evaluateAlerts(
      [{ ...nearHome, enabled: false }],
      row({ id: 'near', channel: 'land-use' }),
      [impact(impactKey('property', 'geography'))],
      preferences,
      context({ pointsByEvent: new Map([['near', [NEARBY]]]) }),
    );
    expect(hits).toEqual([]);
  });

  it('fires an elementary-closure rule on a closure and not on routine news', () => {
    const rule: AlertRule = {
      id: 'rule-2',
      kind: 'school_stage',
      label: 'Elementary-school closures',
      params: { stages: ['elementary'], onlyClosures: true },
      enabled: true,
    };
    const closure = evaluateAlerts(
      [rule],
      row({ id: 'closure', channel: 'schools', title: 'Proposal to close Glover Elementary School' }),
      [impact(impactKey('school', 'elementary'), { evidence: 'Proposal to close Glover Elementary School' })],
      preferences,
      context(),
    );
    const routine = evaluateAlerts(
      [rule],
      row({ id: 'routine', channel: 'schools', title: 'Elementary school picture day' }),
      [impact(impactKey('school', 'elementary'), { evidence: 'Elementary school picture day' })],
      preferences,
      context(),
    );

    expect(closure).toHaveLength(1);
    expect(routine).toEqual([]);
  });

  it('describes a rule as a sentence a person would agree to', () => {
    expect(describeRule(nearHome)).toMatch(/½ mile|half a mile|805/);
    expect(describeRule(nearHome).length).toBeGreaterThan(10);
  });

  it('suggests rules from preferences, without creating any', () => {
    const withHome = {
      ...defaultPreferences(),
      home: HOME,
      schools: { stages: ['elementary' as const], institutions: [] },
    };
    const suggestions = suggestedRules(setScope(withHome, 'land-use', 'near_home'));
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) expect(suggestion.label.length).toBeGreaterThan(0);
  });

  it('suggests no near-home rule to a reader with no home', () => {
    expect(suggestedRules(defaultPreferences()).some((rule) => rule.kind === 'near_home')).toBe(false);
  });

  it('refuses a rule that could never be evaluated', () => {
    expect(validateRule('not-a-kind', {}).ok).toBe(false);
    expect(validateRule('near_home', { radiusMeters: 'a lot' }).ok).toBe(false);
    expect(validateRule('school_stage', { stages: ['kindergarten'] }).ok).toBe(false);
    expect(validateRule('impact', { keys: ['income:low'] }).ok).toBe(false);

    const good = validateRule('near_home', { channels: ['land-use'], radiusMeters: 805 });
    expect(good.ok).toBe(true);
  });

  it('says why it refused, in words a form can show', () => {
    const bad = validateRule('near_home', { radiusMeters: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(10);
  });
});
