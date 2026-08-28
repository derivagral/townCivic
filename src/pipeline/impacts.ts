import type { Db } from '../db/index.ts';
import { IMPACT_DIMENSIONS } from '../profile/impacts.ts';
import type { Impact, ImpactDimension } from '../profile/impacts.ts';
import { TIMEZONE, dayKey, hasRealTime, parseLooseDate } from '../util/dates.ts';
import { clean, extractAddresses, truncate } from '../util/text.ts';

/**
 * Fifth pass: read what a record does to people, before anyone asks who is
 * reading.
 *
 * Personalization normally works the other way round — a persona goes in, a
 * feed comes out, and nobody can say why. This stage inverts it. Every fact it
 * writes is a property of the *document*: this notice affects housing, it
 * reaches elementary schools, it carries a bond, it meets at two in the
 * afternoon. Those are true or false regardless of the reader, so they can be
 * extracted once, stored on the event, and argued with. A profile is then only
 * weights over this vocabulary, which is why the ranking can be rewritten
 * without reprocessing a single PDF.
 *
 * The tradeoff taken here is precision over recall, and it is not a close call.
 * A missed impact costs one record its place in one feed. A false impact
 * silently reroutes somebody's civic attention — it puts a garage variance in
 * front of a parent watching school budgets, and worse, it does so invisibly,
 * because nobody sees the feed they did not get. So the rules below are narrow,
 * every one of them stores the sentence it fired on, and where a pattern had to
 * be broad the comment says what it deliberately refuses to match.
 *
 * Two kinds of reading live here. Prose rules run over the title and document
 * text and produce `exact` impacts quoting the sentence they matched in.
 * Metadata rules run over the fields the pipeline already established — the
 * body, the event type, the meeting time, whether a linked matter geocoded —
 * and produce `derived` impacts with no evidence, because there is no sentence
 * to quote; their rule ids name the metadata they came from so the distinction
 * survives into the table. Where a conclusion is drawn from prose (a School
 * Committee record with no named tier is districtwide) it is `derived` too, but
 * it still carries the sentence that prompted it.
 *
 * Like the rest of the taxonomy this is a hand-maintained table rather than a
 * model. At one-town scale a curated list is manageable, a wrong entry is
 * fixable in one place rather than distributed across a set of weights, and a
 * surprising answer is reproducible — which is the only thing that makes "why
 * am I seeing this" answerable at all.
 */

/* ------------------------------------------------------------------- rules */

export interface ImpactRule {
  id: string;
  dimension: ImpactDimension;
  value: string;
  pattern: RegExp;
  confidence?: 'exact' | 'derived';
}

/**
 * A dollar figure, with the scale words municipal documents actually use.
 *
 * Anchored on `$` on purpose: "1.2 million residents" is not a cost, and the
 * dollar sign is the cheapest reliable way to tell a price from a population.
 */
const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:million|billion|thousand|[kmb])\b)?/i;
const MONEY_CAPTURE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(million|billion|thousand|[kmb])\b)?/i;
const MONEY_SCALES: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  billion: 1e9,
  b: 1e9,
};

export const IMPACT_RULES: ImpactRule[] = [
  /* -- service ------------------------------------------------------------ */
  {
    // Named school governance rather than the word "school", which turns up in
    // "school zone speed limit" and "school street" without the schools being
    // the subject. Tier matches derive `service:schools` separately, below.
    id: 'service-schools',
    dimension: 'service',
    value: 'schools',
    pattern:
      /\bschool committee\b|\bsuperintendent\b|\bschool (?:district|department|budget|building|choice|calendar|start times?)\b|\bMilton Public Schools\b|\bMSBA\b|\bschool bus(?:es|ing)?\b/i,
  },
  {
    id: 'service-childcare',
    dimension: 'service',
    value: 'childcare',
    pattern:
      /\bchild ?care\b|\bday ?care\b|\bafter-?school program\b|\bsummer (?:camp|program)\b|\bvacation (?:camp|program)\b|\bpre-?school program\b|\bearly (?:education|childhood)\b|\byouth program\b|\brecreation program\b/i,
  },
  {
    // A bare "senior" is not matched: high-school seniors and senior planners
    // both appear in this corpus, and either would put the whole Council on
    // Aging feed in front of the wrong reader.
    id: 'service-senior-services',
    dimension: 'service',
    value: 'senior_services',
    pattern:
      /\bcouncil on aging\b|\bsenior (?:center|citizens?|services?|residents?|programs?|transportation|dining|lunch|tax)\b|\bolder adults?\b|\belderly\b|\belder services\b|\bmeals on wheels\b|\bage-?friendly\b/i,
  },
  {
    // Deliberately not triggered by "zoning" on its own. Most zoning relief in
    // Milton is a setback or a garage, and treating every Board of Appeals
    // item as housing policy would drown the housing feed in driveways.
    id: 'service-housing',
    dimension: 'service',
    value: 'housing',
    pattern:
      /\bhousing authority\b|\baffordable housing\b|\bhousing production plan\b|\bchapter 40B\b|\b40B\b|\bMBTA Communities\b|\binclusionary\b|\baccessory dwelling\b|\bmulti-?family (?:housing|district|overlay|dwelling|zoning)\b|\bhousing trust\b|\brental assistance\b|\bhomeless(?:ness)?\b|\bsection 8\b|\bhousing choice\b/i,
  },
  {
    // "MBTA Communities" is a housing statute that happens to be named after
    // the transit authority. Matching it here would file every multi-family
    // zoning article under transit — see the housing rule above.
    id: 'service-transit',
    dimension: 'service',
    value: 'transit',
    pattern:
      /\bMBTA\b(?!\s+Communities)|\bMattapan (?:trolley|line|high speed line)\b|\bbus (?:route|stop|service|shelter)\b|\bcommuter rail\b|\bred line\b|\btransit\b|\bshuttle\b|\bparatransit\b/i,
  },
  {
    id: 'service-roads',
    dimension: 'service',
    value: 'roads',
    pattern:
      /\bDPW\b|\bDepartment of Public Works\b|\bre-?pav(?:e|ing|ed)\b|\bresurfac\w+\b|\bsidewalks?\b|\btraffic calming\b|\bspeed (?:hump|table|limit)\b|\bcrosswalks?\b|\broad (?:closure|work|repair)\b|\bstreet (?:light|sweeping|opening|acceptance)\b|\bpothole\b|\bChapter 90\b|\bcomplete streets\b|\bdetour\b|\bsnow (?:removal|plow\w*)\b|\btraffic signal\b|\bpedestrian (?:safety|crossing)\b|\bcurb cut\b/i,
  },
  {
    // "parking" does not match — the word boundary after "park" sees to that —
    // but "Park Street" would, so street types are excluded explicitly.
    id: 'service-parks',
    dimension: 'service',
    value: 'parks',
    pattern:
      /\bparks?\b(?!\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|lane|drive|place|terrace|way)\b)|\bplayground\b|\bathletic field\b|\bball ?field\b|\brecreation (?:department|commission|area|facilit\w+)\b|\bopen space\b|\btrails?\b|\bconservation land\b|\btot lot\b/i,
  },
  {
    id: 'service-libraries',
    dimension: 'service',
    value: 'libraries',
    pattern: /\blibrar(?:y|ies)\b/i,
  },
  {
    // "fire" is qualified: fire code, fireplace and fire lane are not the fire
    // department, and a fire-protection condition on a site plan is land use.
    id: 'service-public-safety',
    dimension: 'service',
    value: 'public_safety',
    pattern:
      /\bpolice\b|\bfire (?:department|station|chief|prevention|district|alarm|apparatus)\b|\bemergency (?:management|services|preparedness|response)\b|\bambulance\b|\bEMS\b|\bpublic safety\b|\bdispatch\b|\bcrossing guard\b|\bsnow emergency\b|\bstate of emergency\b|\bparking ban\b/i,
  },
  {
    id: 'service-health',
    dimension: 'service',
    value: 'health',
    pattern:
      /\bboard of health\b|\bpublic health\b|\bhealth department\b|\btown nurse\b|\bfood (?:inspection|establishment)\b|\btobacco (?:regulation|permit|control)\b|\bmosquito\b|\bWest Nile\b|\bvaccinat\w+\b|\bimmuniz\w+\b|\bflu clinic\b|\bmental health\b|\bsubstance use\b|\bopioid\b|\bcommunicable disease\b/i,
  },
  {
    // "water" is qualified for the same reason "fire" is: wetlands notices are
    // full of water bodies, waterfronts and watercourses, and none of them is
    // a utility.
    id: 'service-utilities',
    dimension: 'service',
    value: 'utilities',
    pattern:
      /\bMWRA\b|\bwater (?:main|rates?|department|supply|system|meter|service|quality|restriction|bill)\b|\bsewers?\b|\bstorm ?water\b|\bdrainage\b|\bcatch basins?\b|\bhydrants?\b|\bwastewater\b|\btrash\b|\brecycling\b|\bsolid waste\b|\bcurbside collection\b|\belectric aggregation\b|\bboil water\b/i,
  },

  /* -- school ------------------------------------------------------------- */
  {
    id: 'school-preschool',
    dimension: 'school',
    value: 'preschool',
    pattern: /\bpre-?schools?\b|\bpre-?k\b|\bearly childhood\b|\bintegrated preschool\b/i,
  },
  {
    // Kindergarten counts as elementary here because Massachusetts elementary
    // schools are K-5 and a kindergarten notice reaches exactly the households
    // an elementary notice does.
    id: 'school-elementary',
    dimension: 'school',
    value: 'elementary',
    pattern:
      /\belementary schools?\b|\bgrades?\s*K\s*[-–]\s*5\b|\bK\s*[-–]\s*5\b|\bkindergarten\b|\b(?:Collicot|Cunningham|Glover|Tucker)\s+(?:Elementary(?:\s+School)?|School)\b/i,
  },
  {
    id: 'school-middle',
    dimension: 'school',
    value: 'middle',
    pattern: /\bmiddle schools?\b|\bgrades?\s*6\s*[-–]\s*8\b|\bPierce\s+(?:Middle\s+School|School)\b/i,
  },
  {
    id: 'school-high',
    dimension: 'school',
    value: 'high',
    pattern: /\bhigh schools?\b|\bgrades?\s*9\s*[-–]\s*12\b|\bMilton High School\b/i,
  },

  /* -- finance ------------------------------------------------------------ */
  {
    id: 'finance-property-tax',
    dimension: 'finance',
    value: 'property_tax',
    pattern:
      /\bproperty tax\w*\b|\btax rate\b|\btax classification\b|\btax levy\b|\bresidential exemption\b|\btax bills?\b|\bProposition 2\s*(?:½|1\/2)\b|\boverride\b|\bdebt exclusion\b|\btax (?:deferral|abatement|work-?off|relief)\b|\bcommunity preservation (?:act )?surcharge\b|\bCPA surcharge\b/i,
  },
  {
    id: 'finance-utility-rate',
    dimension: 'finance',
    value: 'utility_rate',
    pattern:
      /\b(?:water|sewer|utility|electric|gas) rates?\b|\brate (?:increase|hearing|schedule|adjustment|setting)\b/i,
  },
  {
    // "tuition" is qualified: out-of-district special education tuition is a
    // cost the district pays, not a fee anybody is being charged.
    id: 'finance-user-fee',
    dimension: 'finance',
    value: 'user_fee',
    pattern:
      /\bfee schedule\b|\bpermit fees?\b|\buser fees?\b|\bregistration fees?\b|\bprogram fees?\b|\bathletic fees?\b|\bfee increase\b|\btransfer station sticker\b|\bbeach sticker\b|\bparking (?:fee|meter rate)s?\b|\b(?:preschool|kindergarten) tuition\b|\btuition (?:rates?|increase|schedule)\b/i,
  },
  {
    // Bare "assessment" is refused. Traffic impact assessments, environmental
    // assessments and assessed valuations all use the word and none of them
    // puts a charge on a property.
    id: 'finance-assessment',
    dimension: 'finance',
    value: 'assessment',
    pattern:
      /\bbetterments?\b|\bspecial assessments?\b|\bsewer assessments?\b|\bassessment district\b|\bapportionment of the assessment\b/i,
  },
  {
    // Performance, surety, maintenance, payment and bid bonds are routine
    // land-use conditions, not borrowing. The lookbehind is the whole rule.
    id: 'finance-bond',
    dimension: 'finance',
    value: 'bond',
    pattern:
      /(?<!\b(?:performance|surety|maintenance|payment|bid)\s)\bbonds?\b|\bborrow(?:ing)?\b|\bdebt (?:service|exclusion|authorization)\b|\bbond anticipation note\b|\bgeneral obligation\b/i,
  },
  {
    // "appropriations", never "appropriate" — the adjective is everywhere.
    id: 'finance-operating-budget',
    dimension: 'finance',
    value: 'operating_budget',
    pattern:
      /\boperating budget\b|\bannual budget\b|\bomnibus budget\b|\bFY\s?\d{2,4}\s+budget\b|\bbudget (?:hearing|presentation|request|transfer|process|deficit|gap)\b|\bappropriations?\b|\bline items?\b|\bfree cash\b|\blevel[- ]service budget\b/i,
  },

  /* -- eligibility -------------------------------------------------------- */
  {
    id: 'eligibility-age',
    dimension: 'eligibility',
    value: 'age_based',
    pattern:
      /\bresidents?\s+(?:aged?\s+)?\d{2}\s+(?:and|or)\s+(?:over|older|above)\b|\bages?\s+\d{1,2}\s*(?:[-–]\s*\d{1,2}|\+|and (?:over|older|up))\b|\b(?:55|60|62|65|70)\+\b|\bage[- ]eligible\b|\bunder the age of \d{1,2}\b|\bchildren under \d{1,2}\b|\bmust be at least \d{1,2} years old\b/i,
  },
  {
    id: 'eligibility-income',
    dimension: 'eligibility',
    value: 'income_based',
    pattern:
      /\bincome[- ](?:eligible|qualified|limits?|based|restricted)\b|\blow[- ](?:and moderate[- ])?income\b|\bmoderate[- ]income\b|\barea median income\b|\b\d{1,3}%\s+of\s+(?:the\s+)?(?:area median income|AMI)\b|\bmeans[- ]tested\b|\bfuel assistance\b|\bfree and reduced[- ]price\b|\bsliding scale\b|\bfinancial hardship\b/i,
  },
  {
    // "residents are invited to attend" is not an eligibility rule, it is a
    // welcome. Only restrictions match: the program has to actually turn
    // somebody away for this to be true of it.
    id: 'eligibility-residency',
    dimension: 'eligibility',
    value: 'residency_based',
    pattern:
      /\b(?:Milton )?residents? only\b|\bmust be a (?:Milton )?resident\b|\bresidency (?:requirement|verification)\b|\bproof of (?:Milton )?residency\b|\blimited to (?:Milton )?residents\b|\bopen to (?:Milton )?residents only\b|\bresidents? are eligible\b/i,
  },
  {
    // Not "property owners within 300 feet", which is an abutter notice — a
    // legal notification list, not a test of who qualifies for anything.
    id: 'eligibility-property-ownership',
    dimension: 'eligibility',
    value: 'property_ownership',
    pattern: /\bowner[- ]occupied\b|\bhomeowners?\b|\bhome ?ownership\b|\bmust own (?:the|their|a)\b/i,
  },

  /* -- property ----------------------------------------------------------- */
  {
    id: 'property-deadline',
    dimension: 'property',
    value: 'deadline',
    pattern:
      /\bdeadlines?\b|\bapplications? (?:are )?due\b|\bmust be (?:filed|submitted|received|postmarked)\b|\bno later than\b|\bdue (?:by|on or before)\b|\blast day to\b|\bbids? (?:are )?due\b|\bapplication period (?:closes|ends)\b|\bsubmissions? (?:are )?due\b/i,
  },
  {
    id: 'property-hearing-date',
    dimension: 'property',
    value: 'hearing_date',
    pattern:
      /\bpublic hearing\b|\bnotice of (?:a )?public hearing\b|\bhearing (?:will be held|is scheduled|on|continued to)\b/i,
  },
  {
    // Bare "approved" is refused, because "Approval of Minutes" is the second
    // item on every agenda in town and it decides nothing. What matters is a
    // decision on the subject: a scheduled vote, a recorded tally, a motion.
    id: 'property-decision-stage',
    dimension: 'property',
    value: 'decision_stage',
    pattern:
      /\bwill vote\b|\bvote (?:on|to)\b|\bvoted (?:to|on)\b|\bfinal (?:action|vote|decision)\b|\brender a decision\b|\btake action on\b|\bmotions? (?:carried|passed|failed)\b|\b\d+\s*[-–]\s*\d+\s+vote\b|\bunanimously (?:approved|adopted|denied|granted)\b|\bthe (?:board|committee|commission) (?:approved|denied|granted|adopted)\b|\baward(?:ed)? (?:the )?contract\b/i,
  },
  {
    id: 'property-estimated-cost',
    dimension: 'property',
    value: 'estimated_cost',
    pattern: MONEY,
  },
  {
    id: 'property-public-comment',
    dimension: 'property',
    value: 'public_comment',
    pattern:
      /\bpublic comments?\b|\bcomment period\b|\bwritten comments?\b|\bpublic (?:testimony|participation|input)\b|\bcitizens? speak\b|\bopen forum\b|\ball (?:interested )?(?:persons|parties) (?:are invited|may be heard|will be heard)\b/i,
  },
  {
    // This fires on the accessibility boilerplate at the foot of most agendas,
    // which is correct — the notice really does concern accommodation — but it
    // makes the flag common, so it is a weak ranking signal rather than a rare
    // one. Better a true fact that is often true than a rare fact that is not.
    id: 'property-accessibility',
    dimension: 'property',
    value: 'accessibility',
    pattern:
      /\bADA\b|\baccessib\w+\b|\breasonable accommodation\b|\bwheelchair\b|\bassistive listening\b|\bsign language interpreter\b|\bauxiliary aids\b|\bhearing[- ]impaired\b|\btranslation services\b|\bbarrier[- ]free\b/i,
  },

  /* -- institution -------------------------------------------------------- */
  //
  // These exist to canonicalize, not to enumerate. The generic scanner below
  // finds "Tucker Elementary School" on its own; what it cannot do is know that
  // "the Tucker School" is the same building, or read a name out of an ALL-CAPS
  // PDF heading. Every value here is spelled the way the generic scanner would
  // spell it, so the two never produce two rows for one place.
  {
    id: 'institution-collicot',
    dimension: 'institution',
    value: 'Collicot Elementary School',
    pattern: /\bCollicot\s+(?:Elementary(?:\s+School)?|School)\b/i,
  },
  {
    id: 'institution-cunningham-school',
    dimension: 'institution',
    value: 'Cunningham Elementary School',
    pattern: /\bCunningham\s+(?:Elementary(?:\s+School)?|School)\b/i,
  },
  {
    id: 'institution-glover',
    dimension: 'institution',
    value: 'Glover Elementary School',
    pattern: /\bGlover\s+(?:Elementary(?:\s+School)?|School)\b/i,
  },
  {
    id: 'institution-tucker',
    dimension: 'institution',
    value: 'Tucker Elementary School',
    pattern: /\bTucker\s+(?:Elementary(?:\s+School)?|School)\b/i,
  },
  {
    id: 'institution-pierce',
    dimension: 'institution',
    value: 'Pierce Middle School',
    pattern: /\bPierce\s+(?:Middle\s+School|School)\b/i,
  },
  {
    id: 'institution-milton-high',
    dimension: 'institution',
    value: 'Milton High School',
    pattern: /\bMilton High School\b/i,
  },
  {
    id: 'institution-milton-public-library',
    dimension: 'institution',
    value: 'Milton Public Library',
    pattern: /\bMilton Public Library\b/i,
  },
  {
    // "Town Hall" has no proper-noun prefix to key on, so the generic scanner
    // is not given the suffix at all and this rule owns it outright.
    id: 'institution-town-hall',
    dimension: 'institution',
    value: 'Town Hall',
    pattern: /\bTown Hall\b/i,
  },
];

/* ------------------------------------------------------- reading the prose */

/** How much of a sentence is kept as evidence. Long enough to argue with. */
const EVIDENCE_WIDTH = 200;

/**
 * Abbreviations that end in a period without ending a sentence.
 *
 * Without this list "the MBTA Communities Act. Written comments are due" is one
 * fragment, and the deadline in the second half gets dated by the hearing in
 * the first. Single capitals are here for initials — "Upon the Application of
 * A. Resident" is one clause, and splitting it strands the verb.
 */
const ABBREVIATION = String.raw`(?<!\b(?:[A-Z]|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mr|Mrs|Ms|Dr|Rev|St|Ave|Rd|Ln|Rte|No|Inc|Corp|Co|Approx|Est)\.)`;

const ITEM_BREAK = new RegExp(String.raw`(?<=[.;:!?])${ABBREVIATION}\s+|(?=\s\d{1,2}[.)]\s)`);

/**
 * Where one statement ends and the next begins.
 *
 * Evidence is only useful if it is the phrase the rule actually read, so the
 * text is cut into the smallest fragments that still hold a whole thought.
 * Line breaks come first: in an agenda they are the item boundaries the clerk
 * typed, and they are more reliable than punctuation.
 */
function statements(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(ITEM_BREAK))
    .map((part) => clean(part))
    .filter(Boolean);
}

/** "$1.2 million" as a plain number of dollars. Null when there is no figure. */
function normalizeMoney(text: string): string | null {
  const match = MONEY_CAPTURE.exec(text);
  if (!match) return null;
  const amount = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const scale = match[2] ? (MONEY_SCALES[match[2].toLowerCase()] ?? 1) : 1;
  return String(Math.round(amount * scale));
}

/** A calendar day in the town's timezone, which is what a reader means by a date. */
function isoDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return dayKey(iso);
}

const INSTITUTION_SUFFIX =
  'Elementary School|Middle School|High School|School Building|Library|Playgrounds?|Parks?|Fields?|Community Center|Senior Center|Recreation Center|Fire Station|Police Station';

/**
 * A proper name followed by a kind of place.
 *
 * Case-sensitive and requiring a lower-case second letter, which rules out
 * ALL-CAPS headings — those are handled by the curated rules above where the
 * name is one worth knowing. The alternative is matching every shouted word in
 * a scanned PDF, and "NOTICE OF PUBLIC HEARING PARK" is not an institution.
 */
const INSTITUTION_RE = new RegExp(
  String.raw`\b((?:[A-Z][a-z'’.-][A-Za-z'’.-]*\s+){1,3})(${INSTITUTION_SUFFIX})\b`,
  'g',
);

/**
 * Words that are capitalized because a sentence started, not because they are
 * part of a name. Trimmed off the front of a candidate so "Approved Cunningham
 * Park" does not become an institution called "Approved Cunningham Park".
 */
const NAME_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'approved',
  'at',
  'by',
  'concerning',
  'continued',
  'denied',
  'discussion',
  'for',
  'from',
  'in',
  'new',
  'next',
  'notice',
  'of',
  'old',
  'on',
  'presentation',
  'proposed',
  'public',
  're',
  'regarding',
  'request',
  'review',
  'the',
  'to',
  'update',
  'with',
]);

const MINOR_WORDS = new Set(['and', 'at', 'for', 'in', 'of', 'on', 'the']);

function titleCase(name: string): string {
  return clean(name)
    .split(/\s+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && MINOR_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Named places in one statement, as the text spells them. */
function institutionsIn(sentence: string): string[] {
  const names: string[] = [];
  for (const match of sentence.matchAll(INSTITUTION_RE)) {
    const words = clean(match[1] ?? '').split(/\s+/);
    while (words.length && NAME_STOPWORDS.has((words[0] ?? '').toLowerCase().replace(/[.,]$/, ''))) {
      words.shift();
    }
    // Nothing left but the kind of place — "the Public Library" names a service,
    // not a building, and the service rules have already recorded that.
    if (!words.length) continue;
    names.push(titleCase(`${words.join(' ')} ${match[2] ?? ''}`));
  }
  return names;
}

/** How many named places one record may contribute, so a long PDF cannot flood the table. */
const MAX_INSTITUTIONS = 12;

/** Event types where a clock time means a meeting somebody could attend. */
const MEETING_TYPES = new Set(['meeting_agenda', 'meeting_minutes', 'meeting_notice', 'hearing_scheduled']);

/** The hour of the day a timestamp lands on in the town's timezone. */
function localHour(iso: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const rendered = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  const hour = Number(rendered) % 24;
  return Number.isFinite(hour) ? hour : null;
}

/** Where a School Committee record identifies itself without naming a tier. */
const SCHOOL_GOVERNANCE =
  /\bschool committee\b|\bschool department\b|\bsuperintendent\b|\bMilton Public Schools\b|\bschool district\b/i;

/** Stable output order, so a stored row set and a fresh reading compare directly. */
const DIMENSION_ORDER = new Map<string, number>(IMPACT_DIMENSIONS.map((d, index) => [d, index]));

export interface ImpactInput {
  title: string;
  summary?: string | null;
  docText?: string | null;
  /** The public body, e.g. "Planning Board". */
  body?: string | null;
  /** Taxonomy channel. */
  channel?: string;
  eventType?: string;
  tags?: string[];
  occurredAt?: string | null;
  /** True when a linked matter geocoded. */
  hasPlace?: boolean;
}

/**
 * Read every impact out of one record's text. No database, no network.
 *
 * The prose pass runs statement by statement rather than rule by rule, so the
 * evidence stored for a value is the earliest place the record says it — which
 * is nearly always the title or the first line of the notice, the phrasing a
 * reader would recognise. The metadata pass runs afterwards and cannot displace
 * anything the text said outright.
 */
export function extractImpacts(input: ImpactInput): Impact[] {
  const found = new Map<string, Impact>();

  const add = (impact: Impact): void => {
    const key = `${impact.dimension}:${impact.value}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, impact);
      return;
    }
    // What the text said beats what a rule concluded, whichever arrived first.
    if (existing.confidence === 'derived' && impact.confidence === 'exact') {
      found.set(key, { ...impact, detail: impact.detail ?? existing.detail });
      return;
    }
    // Otherwise the first reading stands — but a later one may fill in a scalar
    // the first could not parse, which adds information without changing the claim.
    if (existing.detail === null && impact.detail !== null) {
      found.set(key, { ...existing, detail: impact.detail });
    }
  };

  // Same source text as `interpret`: the extracted document where there is one,
  // and the listing's own description where there is not, plus the title, which
  // is the one field every adapter fills in.
  const prose = [clean(input.title), clean(input.docText ?? input.summary ?? '')].filter(Boolean).join('\n');
  const sentences = statements(prose);
  let institutions = 0;

  for (const sentence of sentences) {
    for (const rule of IMPACT_RULES) {
      if (!rule.pattern.test(sentence)) continue;
      add({
        dimension: rule.dimension,
        value: rule.value,
        evidence: truncate(sentence, EVIDENCE_WIDTH),
        detail: detailFor(rule.dimension, rule.value, sentence, input),
        confidence: rule.confidence ?? 'exact',
        rule: rule.id,
      });
    }

    for (const name of institutionsIn(sentence)) {
      if (institutions >= MAX_INSTITUTIONS) break;
      institutions++;
      add({
        dimension: 'institution',
        value: name,
        evidence: truncate(sentence, EVIDENCE_WIDTH),
        detail: name.toLowerCase(),
        confidence: 'exact',
        rule: 'institution-named',
      });
    }

    // Addresses go through `extractAddresses` rather than a pattern of their
    // own, so there is exactly one street grammar in the codebase and the
    // subjects a matter is keyed on are the same ones counted as geography.
    for (const address of extractAddresses(sentence)) {
      add({
        dimension: 'property',
        value: 'geography',
        evidence: truncate(sentence, EVIDENCE_WIDTH),
        detail: address,
        confidence: 'exact',
        rule: 'address-in-text',
      });
      break;
    }
  }

  const first = (dimension: ImpactDimension): Impact | undefined =>
    [...found.values()].find((impact) => impact.dimension === dimension);

  // A record about a school tier is a record about the schools. Carrying the
  // tier's evidence through means the conclusion is still traceable to a
  // sentence even though no sentence used the word.
  const tier = first('school');
  if (tier) {
    add({
      dimension: 'service',
      value: 'schools',
      evidence: tier.evidence,
      detail: null,
      confidence: 'derived',
      rule: 'service-schools-from-tier',
    });
  }

  const institution = first('institution');
  if (institution) {
    add({
      dimension: 'property',
      value: 'institutions',
      evidence: institution.evidence,
      detail: institution.detail,
      confidence: 'derived',
      rule: 'property-institutions-from-name',
    });
  }

  /* -- metadata ----------------------------------------------------------- */

  const body = clean(input.body ?? '');
  if (body) {
    // Only the service dimension is read off the body. Which service a board is
    // responsible for is exactly what its name tells you; what it is about to
    // do to a bill, when the deadline is and who qualifies are not in the name,
    // and guessing them from it is how a feed fills up with things nobody said.
    for (const rule of IMPACT_RULES) {
      if (rule.dimension !== 'service' || !rule.pattern.test(body)) continue;
      add({
        dimension: 'service',
        value: rule.value,
        evidence: null,
        detail: null,
        confidence: 'derived',
        rule: `meta:body/${rule.id}`,
      });
    }
  }

  if (input.channel === 'schools') {
    add({
      dimension: 'service',
      value: 'schools',
      evidence: null,
      detail: null,
      confidence: 'derived',
      rule: 'meta:channel-schools',
    });
  }

  // A School Committee record that names no tier reaches every family in the
  // district. This is the rule that keeps school budgets in front of a reader
  // who has no children in a particular building — and it is why the districtwide
  // scope exists at all.
  if (!first('school')) {
    const governance = sentences.find((sentence) => SCHOOL_GOVERNANCE.test(sentence));
    if (governance) {
      add({
        dimension: 'school',
        value: 'districtwide',
        evidence: truncate(governance, EVIDENCE_WIDTH),
        detail: null,
        confidence: 'derived',
        rule: 'school-districtwide-from-governance',
      });
    } else if (SCHOOL_GOVERNANCE.test(body) || input.channel === 'schools') {
      add({
        dimension: 'school',
        value: 'districtwide',
        evidence: null,
        detail: null,
        confidence: 'derived',
        rule: 'meta:body/school-districtwide',
      });
    }
  }

  const tags = input.tags ?? [];
  if (input.eventType === 'hearing_scheduled' || tags.includes('hearing')) {
    add({
      dimension: 'property',
      value: 'hearing_date',
      evidence: null,
      detail: isoDay(input.occurredAt),
      confidence: 'derived',
      rule: 'meta:hearing-event-type',
    });
  }

  // `occurred_at` on a bid posting is the due date — that is what the ingest
  // stage puts there, and a bid with no deadline is not a bid.
  if (input.eventType === 'bid_posted' && input.occurredAt) {
    add({
      dimension: 'property',
      value: 'deadline',
      evidence: null,
      detail: isoDay(input.occurredAt),
      confidence: 'derived',
      rule: 'meta:bid-due-date',
    });
  }

  if (input.hasPlace) {
    add({
      dimension: 'property',
      value: 'geography',
      evidence: null,
      detail: null,
      confidence: 'derived',
      rule: 'meta:geocoded-place',
    });
  }

  // Only when the timestamp carries a real clock time. A date-only listing is
  // anchored at noon UTC by `dateOnlyToIso`, and reading that as a meeting hour
  // would label every undated record in the corpus a daytime meeting — the one
  // fact that decides whether somebody with a job can attend.
  const meetingHour =
    input.occurredAt && hasRealTime(input.occurredAt) && MEETING_TYPES.has(input.eventType ?? '')
      ? localHour(input.occurredAt)
      : null;
  if (meetingHour !== null) {
    add({
      dimension: 'property',
      value: meetingHour < 16 ? 'daytime_meeting' : 'evening_meeting',
      evidence: null,
      detail: null,
      confidence: 'derived',
      rule: 'meta:meeting-time',
    });
  }

  return [...found.values()].sort(
    (a, b) =>
      (DIMENSION_ORDER.get(a.dimension) ?? 99) - (DIMENSION_ORDER.get(b.dimension) ?? 99) ||
      a.value.localeCompare(b.value),
  );
}

/**
 * The normalized scalar for a value that has one.
 *
 * Kept out of the rules table on purpose: `ImpactRule` is the audit surface, and
 * a table of regexes is readable in a way a table of regexes-and-callbacks is not.
 */
function detailFor(
  dimension: ImpactDimension,
  value: string,
  sentence: string,
  input: ImpactInput,
): string | null {
  if (dimension !== 'property') return null;
  if (value === 'estimated_cost') return normalizeMoney(sentence);
  if (value === 'deadline') return isoDay(parseLooseDate(sentence));
  if (value === 'hearing_date') {
    // The date in the sentence, or the one the listing already knows. A hearing
    // notice that gives no date in its prose still has one on the record.
    return isoDay(parseLooseDate(sentence)) ?? isoDay(input.occurredAt);
  }
  return null;
}

/* ------------------------------------------------------------------ storage */

export interface ImpactsOptions {
  jurisdiction?: string;
  eventIds?: string[];
  since?: string;
  limit?: number;
  force?: boolean;
  onProgress?: (report: ImpactReport) => void;
}

export interface ImpactReport {
  eventId: string;
  title: string;
  /** Impacts this event now carries — what was written, or what was already there. */
  found: number;
  skipped?: 'unchanged';
}

export interface ImpactsSummary {
  eventsConsidered: number;
  /** Rows written by this run. A run that skipped everything wrote nothing. */
  impacts: number;
  reports: ImpactReport[];
  byDimension: Record<string, number>;
}

interface Candidate {
  id: string;
  title: string;
  summary: string | null;
  source_text: string | null;
  body: string | null;
  channel: string;
  event_type: string;
  tags: string;
  occurred_at: string | null;
  /** The latest moment the source text could have changed. */
  changed_at: string;
  stored: number;
  impacts_at: string | null;
  place_count: number;
}

function selectCandidates(db: Db, options: ImpactsOptions): Candidate[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.jurisdiction) {
    conditions.push('e.jurisdiction = ?');
    params.push(options.jurisdiction);
  }
  if (options.eventIds?.length) {
    conditions.push(`e.id IN (${options.eventIds.map(() => '?').join(',')})`);
    params.push(...options.eventIds);
  }
  if (options.since) {
    conditions.push('coalesce(e.occurred_at, e.published_at, e.first_seen_at) >= ?');
    params.push(options.since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // `changed_at` is the freshness test, and it is deliberately built from the
  // three stamps that mean the *text* moved: when the record first appeared,
  // when a later fetch revised it in place, and when its document was last
  // extracted. `last_seen_at` is excluded even though it is the obvious
  // candidate — ingest touches it on every run whether anything changed or not,
  // so comparing against it would re-extract the whole corpus nightly.
  //
  // The cost of this choice is that a record whose text yields no impacts at all
  // is re-read on every run, because there is no row to carry a timestamp. That
  // is one regex sweep of one document, and the alternative — a sentinel row
  // meaning nothing — would put rows in the ranker's table that the ranker has
  // to learn to ignore. Cheap work beats a lying table.
  return db
    .prepare(
      `SELECT e.id, e.title, e.summary, coalesce(e.doc_text, e.summary, '') AS source_text,
              e.body, e.channel, e.event_type, e.tags, e.occurred_at,
              max(coalesce(e.revised_at, ''), e.first_seen_at, coalesce(e.extracted_at, '')) AS changed_at,
              (SELECT count(*) FROM event_impacts i WHERE i.event_id = e.id) AS stored,
              (SELECT min(i.extracted_at) FROM event_impacts i WHERE i.event_id = e.id) AS impacts_at,
              (SELECT count(*) FROM matter_events me
                 JOIN places p ON p.matter_id = me.matter_id
                WHERE me.event_id = e.id AND p.lat IS NOT NULL) AS place_count
         FROM events e
         ${where}
        ORDER BY coalesce(e.occurred_at, e.published_at, e.first_seen_at) DESC
        LIMIT ?`,
    )
    .all(...(params as never[]), options.limit ?? -1) as unknown as Candidate[];
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Read events out of the database, store their impacts, and say what happened.
 *
 * An event's rows are deleted and rewritten together, so a re-run converges on
 * the same table rather than accumulating: the impacts of a record are a view of
 * what it says now, not a history of what it has said. That also means a change
 * to the rules above takes effect everywhere on the next forced run, which is
 * the only sane way to maintain a table of regexes.
 */
export function extractEventImpacts(db: Db, options: ImpactsOptions = {}): ImpactsSummary {
  const candidates = selectCandidates(db, options);
  const reports: ImpactReport[] = [];
  const byDimension: Record<string, number> = {};
  const now = new Date().toISOString();
  let impacts = 0;

  // `node:sqlite` has no transaction helper, so drive it with statements. The
  // whole table is derived, so a run that dies partway is repaired by the next.
  db.exec('BEGIN');
  try {
    const remove = db.prepare('DELETE FROM event_impacts WHERE event_id = ?');
    const insert = db.prepare(
      `INSERT INTO event_impacts (event_id, dimension, value, evidence, detail, confidence, rule, extracted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );

    for (const candidate of candidates) {
      if (!options.force && candidate.impacts_at && candidate.impacts_at >= candidate.changed_at) {
        const report: ImpactReport = {
          eventId: candidate.id,
          title: candidate.title,
          found: candidate.stored,
          skipped: 'unchanged',
        };
        reports.push(report);
        options.onProgress?.(report);
        continue;
      }

      const results = extractImpacts({
        title: candidate.title,
        summary: candidate.summary,
        docText: candidate.source_text,
        body: candidate.body,
        channel: candidate.channel,
        eventType: candidate.event_type,
        tags: parseTags(candidate.tags),
        occurredAt: candidate.occurred_at,
        hasPlace: candidate.place_count > 0,
      });

      remove.run(candidate.id);
      for (const impact of results) {
        insert.run(
          candidate.id,
          impact.dimension,
          impact.value,
          impact.evidence,
          impact.detail,
          impact.confidence,
          impact.rule,
          now,
        );
        byDimension[impact.dimension] = (byDimension[impact.dimension] ?? 0) + 1;
        impacts++;
      }

      const report: ImpactReport = {
        eventId: candidate.id,
        title: candidate.title,
        found: results.length,
      };
      reports.push(report);
      options.onProgress?.(report);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { eventsConsidered: candidates.length, impacts, reports, byDimension };
}

interface ImpactRow {
  event_id: string;
  dimension: string;
  value: string;
  evidence: string | null;
  detail: string | null;
  confidence: string;
  rule: string;
}

function toImpact(row: ImpactRow): Impact {
  return {
    dimension: row.dimension as ImpactDimension,
    value: row.value,
    evidence: row.evidence,
    detail: row.detail,
    confidence: row.confidence === 'derived' ? 'derived' : 'exact',
    rule: row.rule,
  };
}

/** What was stored for one record, for the ranker and the "shown because" line. */
export function impactsForEvent(db: Db, eventId: string): Impact[] {
  const rows = db
    .prepare(
      `SELECT event_id, dimension, value, evidence, detail, confidence, rule
         FROM event_impacts WHERE event_id = ? ORDER BY dimension, value`,
    )
    .all(eventId) as unknown as ImpactRow[];
  return rows.map(toImpact);
}

/** The same, for a page of events, in one query per chunk rather than one per row. */
export function impactsForEvents(db: Db, eventIds: string[]): Map<string, Impact[]> {
  const byEvent = new Map<string, Impact[]>();
  // SQLite caps the number of bound parameters; a feed page is well under this,
  // but a whole-corpus rank is not, so chunk rather than trust the caller.
  const CHUNK = 400;

  for (let start = 0; start < eventIds.length; start += CHUNK) {
    const chunk = eventIds.slice(start, start + CHUNK);
    if (!chunk.length) continue;
    const rows = db
      .prepare(
        `SELECT event_id, dimension, value, evidence, detail, confidence, rule
           FROM event_impacts
          WHERE event_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY dimension, value`,
      )
      .all(...(chunk as never[])) as unknown as ImpactRow[];

    for (const row of rows) {
      const list = byEvent.get(row.event_id) ?? [];
      list.push(toImpact(row));
      byEvent.set(row.event_id, list);
    }
  }

  return byEvent;
}
