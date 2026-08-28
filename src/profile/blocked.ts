/**
 * The domains townCivic will not infer, and what it does when you mention one.
 *
 * A recommendation system that reads free text will, left alone, learn things
 * about a reader that the reader did not offer and cannot see. "Set me up as a
 * parent with three kids" is an invitation to record household composition;
 * "I'm retired and on a fixed income" is an invitation to record income. Both
 * are worse than useless here: neither improves a ranking that already keys off
 * declared interests, and both turn a town's public record into a file on the
 * person reading it.
 *
 * So the blocked domains are a list rather than a instinct. Each one is named,
 * each is enforced in one place, and the enforcement is tested. Two tiers:
 *
 *   NEVER          not inferred, not stored, not a ranking input, ever. A
 *                  mention in setup text is acknowledged and dropped.
 *   DECLARED_ONLY  never inferred from anything — not from words, not from
 *                  behaviour, not from a template — but a reader may set it
 *                  themselves, at which point it is a preference they can see
 *                  and delete, not an attribute the system decided about them.
 *
 * The distinction matters because the useful half of "I own my home" is a
 * preference for property-tax records, and that is exactly what gets stored:
 * `finance:property_tax` at digest, with the reader's name on it. The system
 * never records a belief about their tenure.
 *
 * What this file cannot do is stop a determined operator; the database has no
 * column for any of it, which is the actual guarantee.
 */

export const BLOCKED_DOMAINS = [
  {
    id: 'income',
    label: 'Income, wealth, benefits receipt',
    /** Phrases that would otherwise be read as evidence of the domain. */
    pattern:
      /\b(low[- ]income|fixed income|on benefits|snap|section 8|food stamps|can'?t afford|poor|wealthy|rich|salary|my income|means[- ]tested)\b/i,
    /** What is offered instead — a topic anyone may follow, chosen by them. */
    offer: 'finance:property_tax',
    say: 'townCivic does not record income. Tax-relief and fee programs are followable as a topic if you want them.',
  },
  {
    id: 'disability',
    label: 'Disability status and accommodation needs',
    pattern:
      /\b(disabled|disability|wheelchair|mobility (?:issues|impair\w*)|blind|deaf|hard of hearing|autis\w+|adhd|handicap\w*)\b/i,
    offer: 'property:accessibility',
    say: 'townCivic does not record disability. Accessibility and accommodation decisions are followable as a topic.',
  },
  {
    id: 'health',
    label: 'Medical conditions, treatment, pregnancy',
    pattern:
      /\b(cancer|diabet\w+|pregnan\w+|my (?:doctor|meds|medication|diagnosis)|chronic\w* (?:ill|pain|condition)|mental health treatment)\b/i,
    offer: 'service:health',
    say: 'townCivic does not record health information. Board of Health records are followable as a topic.',
  },
  {
    id: 'race_ethnicity',
    label: 'Race, ethnicity, ancestry',
    pattern:
      /\b(black|white|asian|latin[oax]+|hispanic|african[- ]american|indigenous|native american)\b(?!\s+(?:street|road|avenue|lane|hill|pond|school))/i,
    offer: null,
    say: 'townCivic does not record race or ethnicity, and has nothing to offer in its place.',
  },
  {
    id: 'national_origin',
    label: 'National origin, citizenship, immigration status',
    pattern:
      /\b(immigrant|undocumented|green card|visa holder|citizenship status|naturaliz\w+|asylum|refugee|non[- ]citizen)\b/i,
    offer: null,
    say: 'townCivic does not record citizenship or immigration status. Records about federal enforcement in town are in the ordinary feed, visible to everyone.',
  },
  {
    id: 'religion',
    label: 'Religion and observance',
    pattern:
      /\b(catholic|jewish|muslim|christian|hindu|buddhist|church|synagogue|mosque|temple|observant|my faith)\b/i,
    offer: null,
    say: 'townCivic does not record religion.',
  },
  {
    id: 'sexual_orientation',
    label: 'Sexual orientation and gender identity',
    pattern: /\b(gay|lesbian|bisexual|queer|transgender|trans man|trans woman|nonbinary|lgbtq?\+?)\b/i,
    offer: null,
    say: 'townCivic does not record sexual orientation or gender identity.',
  },
  {
    id: 'political_affiliation',
    label: 'Party, voting intention, position on a ballot question',
    pattern:
      /\b(democrat|republican|libertarian|green party|independent voter|conservative|progressive|liberal|i vote|voting (?:for|against)|pro[- ]|anti[- ])\w*/i,
    offer: 'service:schools',
    say: 'townCivic does not record political affiliation or how you would vote. Election records are followable as a topic, with nothing filtered out by position.',
  },
  {
    id: 'exact_age',
    label: 'Date of birth and exact age',
    pattern: /\b(i'?m|i am|aged?)\s+\d{1,3}\b|\bborn in \d{4}\b|\bmy (?:birthday|dob)\b/i,
    offer: 'service:senior_services',
    say: 'townCivic does not record age. Senior services and age-based programs are followable as a topic.',
  },
  {
    id: 'household_composition',
    label: 'Household size, marital status, who lives with you, children by name or number',
    pattern:
      /\b(three|two|four|five|\d+)\s+(?:kids|children|sons|daughters)\b|\b(married|divorced|widow\w*|single (?:mom|dad|parent)|my (?:wife|husband|partner|spouse))\b/i,
    offer: null,
    say: 'townCivic records which school stages you care about, not how many children you have or who lives with you.',
  },
  {
    id: 'criminal_record',
    label: 'Arrests, charges, court involvement',
    pattern:
      /\b(arrested|convicted|my (?:case|charges|probation|parole)|criminal record|restraining order)\b/i,
    offer: null,
    say: 'townCivic does not record court or police involvement.',
  },
] as const;

export type BlockedDomain = (typeof BLOCKED_DOMAINS)[number];
export type BlockedDomainId = BlockedDomain['id'];

/**
 * Attributes a reader may state about themselves, which nothing may conclude
 * on their behalf.
 *
 * Every one of these has a plausible inference path — a retiree template could
 * assume ownership, a transit question could assume no car — and every one of
 * those inferences is wrong often enough to be insulting. So they are set by a
 * checkbox or not at all, and a template that wants one has to *ask*.
 */
export const DECLARED_ONLY = [
  {
    id: 'tenure',
    label: 'Own or rent',
    why: 'A retiree template that assumes ownership shows a renter tax records they cannot act on, and hides rental-housing records they can.',
  },
  {
    id: 'school_stages',
    label: 'School stages followed',
    why: 'Read from an answer to "which stages?", never from the words "parent" or "kids".',
  },
  {
    id: 'accessibility_interest',
    label: 'Interest in accessibility decisions',
    why: 'An interest in curb cuts and ADA compliance is a civic interest, not a disclosure. It is stored as the former.',
  },
  {
    id: 'senior_services_interest',
    label: 'Interest in senior services',
    why: 'Following the Council on Aging says nothing about the reader’s age, and townCivic does not treat it as if it did.',
  },
  {
    id: 'transit_reliance',
    label: 'Interest in transit records',
    why: 'Following the MBTA is not evidence of not owning a car.',
  },
  {
    id: 'home_location',
    label: 'Home location, for near-me geography',
    why: 'The one genuinely sensitive thing the system does store. Set by the reader, precise to whatever they type, deletable in one click, and never sent anywhere but the geocoder.',
  },
] as const;

export type DeclaredOnlyId = (typeof DECLARED_ONLY)[number]['id'];

export interface BlockedMention {
  domain: BlockedDomainId;
  label: string;
  /** The words that matched, so the reader can see exactly what was dropped. */
  matched: string;
  say: string;
  /** A topic offered in its place, or null when there is honestly nothing. */
  offer: string | null;
}

/**
 * Find blocked domains named in free text.
 *
 * This does not sanitise the text — the reader's own words are shown back to
 * them unchanged. It produces the list of things that were *not* acted on, so
 * that setup can say so out loud. Silently ignoring a mention would look
 * identical to silently recording it.
 */
export function findBlockedMentions(text: string): BlockedMention[] {
  const found: BlockedMention[] = [];
  for (const domain of BLOCKED_DOMAINS) {
    const match = domain.pattern.exec(text);
    if (!match) continue;
    found.push({
      domain: domain.id,
      label: domain.label,
      matched: match[0].trim(),
      say: domain.say,
      offer: domain.offer,
    });
  }
  return found;
}

/**
 * The guard every write to a profile passes through.
 *
 * There is no column for a blocked domain, so this cannot catch a schema
 * mistake — what it catches is a preference key smuggled in as free text, e.g.
 * an `interest` of `income:low`. Anything outside the impact vocabulary is
 * refused rather than stored and ignored, because a stored-and-ignored value is
 * one refactor away from being read.
 */
export function isBlockedKey(key: string): boolean {
  const prefix = key.slice(0, key.indexOf(':')).toLowerCase();
  return (BLOCKED_DOMAINS as readonly { id: string }[]).some((d) => d.id === prefix);
}
