/**
 * What a civic record does to people, as a controlled vocabulary.
 *
 * This is the layer that replaces personas. The processing pipeline is never
 * asked "is this relevant to retirees" — it is asked which services a record
 * touches, which school tiers, what it does to a bill, who is eligible, and
 * what kind of thing it is. Those are properties of the *document*, true or
 * false regardless of who is reading, so they can be extracted once, stored on
 * the event, and audited against the text they came from.
 *
 * Everything personal happens downstream of here. A profile is weights over
 * this vocabulary and nothing else, which is why the ranking can be rewritten
 * without reprocessing a single PDF — and why a reader can be shown the exact
 * feature that put a record in front of them.
 *
 * The vocabulary is hand-maintained on purpose, the same bet the rest of the
 * taxonomy makes: at one-to-several-town scale a curated list is manageable,
 * and a wrong entry is fixable in one place rather than distributed across a
 * model's weights.
 */

/** The service a record affects the delivery of. */
export const AFFECTED_SERVICES = [
  'schools',
  'childcare',
  'senior_services',
  'housing',
  'transit',
  'roads',
  'parks',
  'libraries',
  'public_safety',
  'health',
  'utilities',
] as const;
export type AffectedService = (typeof AFFECTED_SERVICES)[number];

export const SERVICE_LABELS: Record<AffectedService, string> = {
  schools: 'Schools',
  childcare: 'Childcare and recreation',
  senior_services: 'Senior services',
  housing: 'Housing',
  transit: 'Transit',
  roads: 'Roads and sidewalks',
  parks: 'Parks',
  libraries: 'Libraries',
  public_safety: 'Public safety',
  health: 'Health services',
  utilities: 'Water, sewer and utilities',
};

/**
 * Which tier of school a record reaches.
 *
 * Deliberately the stage rather than the household: "elementary" is a fact
 * about the record, and it is also the only thing about a reader's children
 * this system ever asks for. How many there are, how old they are and what
 * they are called are not preferences, they are a family, and none of it makes
 * the feed better than "elementary, and Tucker specifically" already does.
 */
export const SCHOOL_SCOPES = ['preschool', 'elementary', 'middle', 'high', 'districtwide'] as const;
export type SchoolScope = (typeof SCHOOL_SCOPES)[number];

export const SCHOOL_SCOPE_LABELS: Record<SchoolScope, string> = {
  preschool: 'Preschool',
  elementary: 'Elementary',
  middle: 'Middle school',
  high: 'High school',
  districtwide: 'Districtwide',
};

/** What the record does to somebody's bill. */
export const FINANCIAL_EFFECTS = [
  'property_tax',
  'utility_rate',
  'user_fee',
  'assessment',
  'bond',
  'operating_budget',
] as const;
export type FinancialEffect = (typeof FINANCIAL_EFFECTS)[number];

export const FINANCIAL_EFFECT_LABELS: Record<FinancialEffect, string> = {
  property_tax: 'Property tax',
  utility_rate: 'Utility rate',
  user_fee: 'User fee',
  assessment: 'Betterment or assessment',
  bond: 'Debt or bond',
  operating_budget: 'Operating budget',
};

/**
 * How a program decides who qualifies.
 *
 * Note what this is: a property of the *program*, read off the notice. That a
 * tax-relief program is income-based is public information. Whether a reader
 * would qualify for it is not something townCivic knows, asks, or infers — see
 * `blocked.ts`. The system can say "this program is income-based"; it can
 * never say "this program is for you".
 */
export const ELIGIBILITY_BASES = [
  'age_based',
  'income_based',
  'residency_based',
  'property_ownership',
] as const;
export type EligibilityBasis = (typeof ELIGIBILITY_BASES)[number];

export const ELIGIBILITY_LABELS: Record<EligibilityBasis, string> = {
  age_based: 'Age-based eligibility',
  income_based: 'Income-based eligibility',
  residency_based: 'Residency-based eligibility',
  property_ownership: 'Property-ownership eligibility',
};

/** Structural facts about the record itself, rather than its subject. */
export const EVENT_PROPERTIES = [
  'geography',
  'institutions',
  'deadline',
  'hearing_date',
  'decision_stage',
  'estimated_cost',
  'daytime_meeting',
  'evening_meeting',
  'public_comment',
  'accessibility',
] as const;
export type EventProperty = (typeof EVENT_PROPERTIES)[number];

export const EVENT_PROPERTY_LABELS: Record<EventProperty, string> = {
  geography: 'Has a location',
  institutions: 'Names an institution',
  deadline: 'Has a deadline',
  hearing_date: 'Has a hearing date',
  decision_stage: 'Reaches a decision',
  estimated_cost: 'Carries a cost figure',
  daytime_meeting: 'Meets during the working day',
  evening_meeting: 'Meets in the evening',
  public_comment: 'Takes public comment',
  accessibility: 'Concerns access or accommodation',
};

/**
 * The six axes, as one flat namespace.
 *
 * Preferences, alert rules and explanations all key off `dimension:value`
 * strings — `service:schools`, `school:elementary`, `finance:property_tax` —
 * so one loop scores every axis and there is no per-axis special case to keep
 * in sync. `institution` is the open dimension: its values are names the
 * extractor found ("Tucker Elementary School"), not a fixed list.
 */
export const IMPACT_DIMENSIONS = [
  'service',
  'school',
  'finance',
  'eligibility',
  'property',
  'institution',
] as const;
export type ImpactDimension = (typeof IMPACT_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<ImpactDimension, string> = {
  service: 'Affected service',
  school: 'School scope',
  finance: 'Financial effect',
  eligibility: 'Eligibility',
  property: 'Record property',
  institution: 'Institution',
};

/**
 * One extracted fact about a record.
 *
 * `evidence` is not optional decoration. A civic impact that cannot be traced
 * to the words that produced it is an opinion, and the whole point of doing
 * this deterministically is that a surprising one can be argued with. `rule`
 * says which line of `src/pipeline/impacts.ts` fired, so a systematic error is
 * fixable in one place.
 */
export interface Impact {
  dimension: ImpactDimension;
  value: string;
  /** The phrase this was read out of, verbatim. Null only for structural facts. */
  evidence: string | null;
  /** A normalized scalar where the value has one: dollars, an ISO date, a name. */
  detail: string | null;
  /** `exact` when the text said it; `derived` when a rule concluded it. */
  confidence: 'exact' | 'derived';
  /** Identifier of the rule that produced this, for auditing. */
  rule: string;
}

/** The key a preference or an alert rule matches on. */
export function impactKey(dimension: ImpactDimension, value: string): string {
  return `${dimension}:${value}`;
}

export function parseImpactKey(key: string): { dimension: ImpactDimension; value: string } | null {
  const index = key.indexOf(':');
  if (index === -1) return null;
  const dimension = key.slice(0, index);
  const value = key.slice(index + 1);
  if (!value || !(IMPACT_DIMENSIONS as readonly string[]).includes(dimension)) return null;
  return { dimension: dimension as ImpactDimension, value };
}

/** Human wording for one key, used in the "shown because" line and the editor. */
export function impactLabel(key: string): string {
  const parsed = parseImpactKey(key);
  if (!parsed) return key;
  const { dimension, value } = parsed;
  switch (dimension) {
    case 'service':
      return SERVICE_LABELS[value as AffectedService] ?? value;
    case 'school':
      return SCHOOL_SCOPE_LABELS[value as SchoolScope] ?? value;
    case 'finance':
      return FINANCIAL_EFFECT_LABELS[value as FinancialEffect] ?? value;
    case 'eligibility':
      return ELIGIBILITY_LABELS[value as EligibilityBasis] ?? value;
    case 'property':
      return EVENT_PROPERTY_LABELS[value as EventProperty] ?? value;
    case 'institution':
      return value;
  }
}

/** Every closed-vocabulary key, for the preference editor's checklist. */
export function allImpactKeys(): string[] {
  return [
    ...AFFECTED_SERVICES.map((v) => impactKey('service', v)),
    ...SCHOOL_SCOPES.map((v) => impactKey('school', v)),
    ...FINANCIAL_EFFECTS.map((v) => impactKey('finance', v)),
    ...ELIGIBILITY_BASES.map((v) => impactKey('eligibility', v)),
    ...EVENT_PROPERTIES.map((v) => impactKey('property', v)),
  ];
}

export function isImpactValue(dimension: ImpactDimension, value: string): boolean {
  switch (dimension) {
    case 'service':
      return (AFFECTED_SERVICES as readonly string[]).includes(value);
    case 'school':
      return (SCHOOL_SCOPES as readonly string[]).includes(value);
    case 'finance':
      return (FINANCIAL_EFFECTS as readonly string[]).includes(value);
    case 'eligibility':
      return (ELIGIBILITY_BASES as readonly string[]).includes(value);
    case 'property':
      return (EVENT_PROPERTIES as readonly string[]).includes(value);
    case 'institution':
      return value.trim().length > 0;
  }
}
