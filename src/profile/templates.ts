import type { Channel } from '../taxonomy.ts';
import { SCHOOL_SCOPE_LABELS, SCHOOL_SCOPES } from './impacts.ts';
import type { GeoScope, Preferences, Treatment } from './preferences.ts';
import { setScope, upsertInterest } from './preferences.ts';

/**
 * Starter templates, which are bundles of ordinary preference rows and nothing else.
 *
 * A cold start is the real problem a template solves: a reader who has told the system nothing gets a
 * feed that is close to the chronological record, which is honest but not useful, and the alternative
 * — asking forty questions before showing anything — is worse. So a template is a shortcut through the
 * preference editor. It proposes the exact rows a patient reader would have set by hand, each with the
 * sentence explaining why, and then it stops existing: `origin` remembers which template proposed a row
 * so the reader can throw it out, and nothing downstream ever reads a template name to rank anything.
 *
 * That is the property the whole design rests on. Two readers who accept different templates and edit
 * to the same rows have identical feeds. A template is therefore never a persona, never a demographic
 * guess, and never a thing the system believes about the person reading — which is also why the hard
 * cases here are the ones where a template is tempted to infer. `retiree` wants to assume home
 * ownership; `renter` wants to assume no car; `parent` wants to record three children. All three are
 * refused in the data below rather than in a policy document: ownership is a question, transit interest
 * is a topic, and the only thing recorded about a reader's family is which school stages they picked.
 *
 * The tradeoff taken here is composition over completeness. Rather than a long list of finely-drawn
 * personas, there are eight small bundles that stack — `retiree` plus `renter` plus `neighborhood` is a
 * real reader, and each of the three is legible on its own. The cost is that two templates can propose
 * different treatments for the same key, so a resolution rule is needed; `resolveChanges` is that rule,
 * and it is deliberately the one that never quiets something another template asked for.
 */

export interface TemplateChange {
  key: string;
  treatment: Treatment;
  /** One sentence: why this template proposes this row. Shown in the preview. */
  why: string;
}

export interface TemplateQuestion {
  id: string;
  /** The question, in plain English. */
  ask: string;
  /** Choices; multi-select unless `single`. */
  options: { value: string; label: string }[];
  single?: boolean;
  /** What answering does. `school_stages` | `institutions` | `interests` | `geography` | `home` */
  applies: 'school_stages' | 'institutions' | 'interests' | 'geography' | 'home';
  /** Why it is asked as a question rather than assumed. */
  why: string;
}

export interface ProfileTemplate {
  id: string;
  version: string;
  label: string;
  /** One paragraph: what this template assumes, and pointedly what it does not. */
  description: string;
  changes: TemplateChange[];
  geography: { channel: Channel; scope: GeoScope; why: string }[];
  questions: TemplateQuestion[];
  /** Downranks, never mutes. Each carries the sentence shown to the reader. */
  downranks: TemplateChange[];
}

/**
 * The buildings a Milton reader can name, spelled the way the district spells them.
 *
 * The `institution` dimension is open — its values are whatever the extractor read off a document — so
 * this list is only the picker's contents, not a constraint. It is here rather than in the taxonomy
 * because it is a piece of setup copy that changes when the town builds a school, not a vocabulary the
 * pipeline agrees on.
 */
export const MILTON_SCHOOLS = [
  'Collicot Elementary School',
  'Cunningham Elementary School',
  'Glover Elementary School',
  'Tucker Elementary School',
  'Pierce Middle School',
  'Milton High School',
] as const;

/**
 * The school downrank, and the rows it is forbidden to take with it.
 *
 * This pair is the worked example the design argues from, so it lives in the data rather than in prose.
 * A reader who says "no school stuff" — or who accepts `retiree` — means the concerts, the calendar and
 * the staffing announcements. They do not mean the twelve-million-dollar budget their taxes pay, the
 * bond that will be on the ballot, or the vote that closes a building. Muting the school service would
 * take all of it; downranking one row while keeping four others is the difference between a preference
 * and a blind spot.
 *
 * The two halves are meant to be summed by the ranker rather than resolved against each other. A school
 * concert carries `service:schools` alone and sinks. A school budget carries `service:schools` and
 * `finance:operating_budget`, so it comes out above the line. That arithmetic is the whole mechanism,
 * and it is why nothing here is ever a `mute`: a mute is negative infinity and cannot be outweighed.
 */
export const SCHOOL_DOWNRANKS: TemplateChange[] = [
  {
    key: 'service:schools',
    treatment: 'downrank',
    why: 'Routine school programming — calendars, concerts, staffing notices — is ranked below everything else rather than hidden.',
  },
  ...(['preschool', 'elementary', 'middle', 'high'] as const).map((stage): TemplateChange => ({
    key: `school:${stage}`,
    treatment: 'downrank',
    why: `${SCHOOL_SCOPE_LABELS[stage]} programming specifically, which is what a reader means by "no school stuff" — the budget that pays for it is a separate row that stays.`,
  })),
];

export const SCHOOL_RETAINED: TemplateChange[] = [
  {
    key: 'finance:operating_budget',
    treatment: 'digest',
    why: 'The school budget is the largest line in the town budget, and every household votes on it whether or not it has a child in a classroom.',
  },
  {
    key: 'finance:bond',
    treatment: 'digest',
    why: 'School construction is borrowed against the whole town for twenty years, so a debt exclusion is a tax question before it is a school question.',
  },
  {
    key: 'school:districtwide',
    treatment: 'digest',
    why: 'Closures, redistricting and start times are town decisions wearing a school’s name.',
  },
  {
    key: 'property:decision_stage',
    treatment: 'digest',
    why: 'Elections, override ballot questions and the votes that settle a district matter are kept, because that is the moment the whole town is being asked.',
  },
];

/**
 * Geography that a school downrank must not quietly narrow.
 *
 * Downranking is a ranking decision. Narrowing the geography at the same time would turn it into a
 * filter, and the reader would never see the difference — which is exactly the failure this codebase
 * spends its time avoiding.
 */
export const SCHOOL_RETAINED_GEOGRAPHY: { channel: Channel; scope: GeoScope; why: string }[] = [
  {
    channel: 'schools',
    scope: 'townwide',
    why: 'The downrank is a ranking decision; narrowing the geography as well would quietly turn it into a filter.',
  },
  {
    channel: 'elections',
    scope: 'townwide',
    why: 'Override votes and School Committee elections are decided by the whole town, including the readers who downranked schools.',
  },
];

/** The sentence a reader is owed whenever a school row is downranked. Shared, so it cannot drift. */
export const SCHOOL_DOWNRANK_NOTE =
  "I've downranked routine school programming, but retained school budgets, construction, elections and major district decisions, because they affect the whole town.";

/** Offered by every template whose rows are inert without an address. */
const HOME_QUESTION: TemplateQuestion = {
  id: 'home',
  ask: 'Set a home address, so that "near home" means something?',
  options: [
    { value: 'set', label: 'Yes — I will type a street address' },
    { value: 'skip', label: 'No — keep everything townwide' },
  ],
  single: true,
  applies: 'home',
  why: 'Near-home geography does nothing without an address, and the address is the one genuinely sensitive thing this system stores — so it is typed, never derived from an IP address or a click.',
};

export const TEMPLATES: ProfileTemplate[] = [
  {
    id: 'parent',
    version: 'parent-1',
    label: 'Following the schools',
    description:
      'Proposes the rows a reader who follows the schools would set by hand: the schools service, districtwide decisions, evening meetings, the town-run programs that sit alongside the district, and the deadlines that cannot be caught up on. It asks which stages you follow and which buildings you want named, because those are facts about records. It does not record how many children you have, how old they are, whether they exist, or how old you are — nothing here is a household. A grandparent, a teacher and a neighbour who votes on the budget accepting this template all end up with exactly the same rows, which is the point.',
    changes: [
      {
        key: 'service:schools',
        treatment: 'digest',
        why: 'Schools are the largest thing the town buys and the most frequent thing it decides.',
      },
      {
        key: 'school:districtwide',
        treatment: 'digest',
        why: 'Calendar, policy and budget decisions reach every stage, whichever ones you end up following.',
      },
      {
        key: 'property:evening_meeting',
        treatment: 'digest',
        why: 'The School Committee sits in the evening, which is the only reason most readers can attend at all.',
      },
      {
        key: 'property:deadline',
        treatment: 'digest',
        why: 'Registration, lottery and transport deadlines are the school news that is worthless the day after.',
      },
      {
        key: 'service:childcare',
        treatment: 'digest',
        why: 'After-school, recreation and summer programs are run by the town rather than the district, and are announced somewhere else entirely.',
      },
    ],
    geography: [
      {
        channel: 'schools',
        scope: 'townwide',
        why: 'School decisions are made districtwide even when they land at one building, and narrowing this before you have picked any schools would hide the ones that reach everyone.',
      },
      {
        channel: 'meetings',
        scope: 'townwide',
        why: 'The School Committee and Town Meeting both sit townwide; a school decision is almost never made near your house.',
      },
    ],
    questions: [
      {
        id: 'school_stages',
        ask: 'Which school stages should reach you?',
        options: SCHOOL_SCOPES.filter((stage) => stage !== 'districtwide').map((stage) => ({
          value: stage,
          label: SCHOOL_SCOPE_LABELS[stage],
        })),
        applies: 'school_stages',
        why: 'The stage is the only thing about a reader’s family this system asks for, and it is asked rather than read out of the words "parent" or "kids".',
      },
      {
        id: 'school_institutions',
        ask: 'Any schools you want followed by name?',
        options: MILTON_SCHOOLS.map((school) => ({ value: school, label: school })),
        applies: 'institutions',
        why: 'A named building ranks its records up; it never filters the others out, so naming none of them costs you nothing.',
      },
    ],
    downranks: [],
  },
  {
    id: 'retiree',
    version: 'retiree-1',
    label: 'Senior services, daytime meetings and what things cost',
    description:
      'Assumes you want senior services, the boards that meet during the working day, utility rates and accessibility decisions, and that routine school programming can sit below the fold. It does not assume you own your home — that is asked, because ownership is declared-only — and it does not record your age, your income, your health or a disability, none of which have a column to be recorded in. It downranks routine school programming while deliberately keeping school budgets, school construction, elections and districtwide decisions at digest, because those are paid for and voted on by the whole town.',
    changes: [
      {
        key: 'service:senior_services',
        treatment: 'digest',
        why: 'The Council on Aging’s programs, transport and meal services are decided in public and announced almost nowhere else.',
      },
      {
        key: 'institution:Milton Council on Aging',
        treatment: 'digest',
        why: 'Named because its own agendas, rather than the town’s news page, are where senior-service decisions actually appear first.',
      },
      {
        key: 'finance:utility_rate',
        treatment: 'digest',
        why: 'Water and sewer rates are reset annually and change a bill that does not otherwise move.',
      },
      {
        key: 'property:daytime_meeting',
        treatment: 'digest',
        why: 'A board that meets at two in the afternoon is attendable by some readers and invisible to everyone else.',
      },
      {
        key: 'property:accessibility',
        treatment: 'digest',
        why: 'Curb cuts, ramps and hearing loops are civic decisions, and following them says nothing whatever about the reader.',
      },
      {
        key: 'finance:property_tax',
        treatment: 'ask',
        why: 'Proposed but inert: whether you own or rent is declared-only (see DECLARED_ONLY in blocked.ts), so this row does nothing at all until the ownership question below is answered.',
      },
      ...SCHOOL_RETAINED,
    ],
    geography: [
      ...SCHOOL_RETAINED_GEOGRAPHY,
      {
        channel: 'meetings',
        scope: 'townwide',
        why: 'The boards that set fees, rates and services sit at Town Hall, wherever you live.',
      },
    ],
    questions: [
      {
        id: 'tenure',
        ask: 'Do you own or rent? This sets a topic, not a fact about you.',
        options: [
          {
            value: 'finance:property_tax',
            label: 'I own — follow property tax, exemptions and abatements',
          },
          { value: 'service:housing', label: 'I rent — follow rental housing and tenant notices' },
          { value: 'skip', label: 'Rather not say — follow neither' },
        ],
        single: true,
        applies: 'interests',
        why: 'A template that assumed ownership would show a renter tax records they cannot act on and hide the rental records they can; what gets stored either way is a topic you can see and delete, never a belief about your tenure.',
      },
    ],
    downranks: SCHOOL_DOWNRANKS,
  },
  {
    id: 'renter',
    version: 'renter-1',
    label: 'Rental housing, and what a lease does not insulate you from',
    description:
      'Proposes rental housing, hearings, residency-keyed programs and the utility rates that reach a tenant through the lease a year later. Accepting it stores those rows and only those rows — there is no tenure field, so the system does not come to hold the belief that you rent. It does not infer income from renting, does not infer that you have no car, and does not narrow anything to the address you have not given it.',
    changes: [
      {
        key: 'service:housing',
        treatment: 'digest',
        why: 'Rental construction, conversions and inspectional decisions are the housing news a lease does not shield you from.',
      },
      {
        key: 'finance:utility_rate',
        treatment: 'digest',
        why: 'Water and sewer rates reach a tenant through the lease, usually a year late and without an explanation.',
      },
      {
        key: 'property:hearing_date',
        treatment: 'digest',
        why: 'Housing decisions are made at hearings that abutting owners are notified of by statute and tenants generally are not.',
      },
      {
        key: 'eligibility:residency_based',
        treatment: 'digest',
        why: 'Programs keyed to living here rather than owning here are the ones this reader can actually use.',
      },
    ],
    geography: [
      {
        channel: 'land-use',
        scope: 'near_home',
        why: 'A conversion two streets away changes the street you live on; one across town does not.',
      },
    ],
    questions: [HOME_QUESTION],
    downranks: [],
  },
  {
    id: 'homeowner',
    version: 'homeowner-1',
    label: 'The tax bill, the assessment and the street',
    description:
      'Proposes property tax, betterments, debt, ownership-keyed programs and the deadlines they carry. This is the one place property tax is applied without asking first, because choosing this template is itself the declaration — nothing anywhere else in townCivic concludes that you own your home, not from a template, not from your words, and not from what you read. It records no assessed value, no address you have not typed, and nothing about a mortgage.',
    changes: [
      {
        key: 'finance:property_tax',
        treatment: 'digest',
        why: 'Choosing this template is the declaration; nothing else in the system infers ownership from anything.',
      },
      {
        key: 'finance:assessment',
        treatment: 'digest',
        why: 'A betterment is charged to the abutting owners and is decided months before it turns up on a bill.',
      },
      {
        key: 'finance:bond',
        treatment: 'digest',
        why: 'Debt exclusions and overrides move a tax bill further than the rate does.',
      },
      {
        key: 'eligibility:property_ownership',
        treatment: 'digest',
        why: 'Exemptions and abatements are keyed to ownership and every one of them has a filing window.',
      },
      {
        key: 'property:deadline',
        treatment: 'digest',
        why: 'Abatement and exemption windows close quietly and are not reopened.',
      },
      {
        key: 'service:utilities',
        treatment: 'digest',
        why: 'Water, sewer and stormwater charges arrive on the same bill and are set by a different board.',
      },
    ],
    geography: [
      {
        channel: 'land-use',
        scope: 'near_home',
        why: 'A special permit next door is the land-use record that changes what you own; the rest is background.',
      },
      {
        channel: 'public-safety',
        scope: 'near_home',
        why: 'Road work, water shutoffs and paving are street-level facts.',
      },
    ],
    questions: [HOME_QUESTION],
    downranks: [],
  },
  {
    id: 'transit-rider',
    version: 'transit-1',
    label: 'The trolley, the buses and the streets that reach them',
    description:
      'Proposes transit, the MBTA as a named institution, the roads and crossings that get people to a stop, and the fees set at public meetings. Following the MBTA is a civic interest and this template treats it as exactly that: it does not conclude that you have no car, no licence, or no money, and there is nowhere for such a conclusion to be written down.',
    changes: [
      {
        key: 'service:transit',
        treatment: 'digest',
        why: 'Service changes, shuttle replacements and stop closures are decided outside the town and announced inside it.',
      },
      {
        key: 'institution:MBTA',
        treatment: 'digest',
        why: 'The Mattapan trolley and the bus routes belong to an authority that does not publish to the town’s website.',
      },
      {
        key: 'service:roads',
        treatment: 'digest',
        why: 'Crossings, sidewalks and bus stops are town decisions even when the vehicle is not.',
      },
      {
        key: 'finance:user_fee',
        treatment: 'digest',
        why: 'Fares, permits and parking charges are set at meetings with an agenda and a comment period.',
      },
    ],
    geography: [
      {
        channel: 'state-federal',
        scope: 'townwide',
        why: 'The MBTA is a state authority, so its decisions arrive through the state-federal channel with no address in town to be near.',
      },
      {
        channel: 'public-safety',
        scope: 'townwide',
        why: 'A detour or a shuttle replacement matters anywhere on the line, not only near your house.',
      },
    ],
    questions: [
      {
        id: 'transit_institutions',
        ask: 'Which lines or routes should be followed by name?',
        options: [
          { value: 'MBTA Mattapan Line', label: 'Mattapan trolley (Milton, Central Avenue, Valley Road)' },
          { value: 'MBTA Route 245', label: 'Bus route 245' },
          { value: 'MBTA Route 716', label: 'Bus route 716' },
        ],
        applies: 'institutions',
        why: 'Naming a line ranks its records up and nothing else; it is not read as evidence of how you get around.',
      },
    ],
    downranks: [],
  },
  {
    id: 'newcomer',
    version: 'newcomer-1',
    label: 'Getting your bearings',
    description:
      'Proposes deadlines, comment periods, evening meetings, the two departments a new household deals with first, and the programs keyed to residency. It assumes only that you have not yet learned which board decides what. It does not record where you moved from, your citizenship or immigration status, or how long you have lived anywhere — see the national-origin entry in blocked.ts, which is refused rather than merely unused.',
    changes: [
      {
        key: 'property:deadline',
        treatment: 'digest',
        why: 'Almost everything a new resident misses is a deadline rather than an argument.',
      },
      {
        key: 'property:public_comment',
        treatment: 'digest',
        why: 'The point at which input is still being taken is the only point worth hearing about in advance.',
      },
      {
        key: 'property:evening_meeting',
        treatment: 'digest',
        why: 'Evening meetings are the ones a reader with a job can attend.',
      },
      {
        key: 'service:libraries',
        treatment: 'digest',
        why: 'The library is where most people’s first transaction with the town happens.',
      },
      {
        key: 'service:parks',
        treatment: 'digest',
        why: 'Fields, permits and playgrounds are the second one.',
      },
      {
        key: 'eligibility:residency_based',
        treatment: 'digest',
        why: 'Stickers, permits and programs keyed to residency are the paperwork of arriving.',
      },
    ],
    geography: [
      {
        channel: 'meetings',
        scope: 'townwide',
        why: 'Until you know which board decides what, narrowing the meetings channel hides the answer.',
      },
    ],
    questions: [HOME_QUESTION],
    downranks: [],
  },
  {
    id: 'watchdog',
    version: 'watchdog-1',
    label: 'Meetings and decisions, townwide',
    description:
      'Follows the machinery: hearings and comment periods immediately, decisions, deadlines, cost figures and the money that moves, everywhere in town rather than near an address. This is a workload rather than an identity — it is the only template that proposes alert-eligible rows, and a reader who accepts it should expect to be interrupted. It assumes nothing about who you are, only that you intend to read a lot.',
    changes: [
      {
        key: 'property:hearing_date',
        treatment: 'immediate',
        why: 'A hearing heard about afterwards is a hearing that happened without you.',
      },
      {
        key: 'property:public_comment',
        treatment: 'immediate',
        why: 'A comment period is the one thing in the record that cannot be caught up on once it closes.',
      },
      {
        key: 'property:decision_stage',
        treatment: 'digest',
        why: 'Where a matter has actually reached a vote, as against being discussed for the fourth time.',
      },
      {
        key: 'property:estimated_cost',
        treatment: 'digest',
        why: 'A cost figure printed in a document is the fact most worth checking against the last one.',
      },
      {
        key: 'finance:operating_budget',
        treatment: 'digest',
        why: 'The operating budget is where every department’s year is actually decided.',
      },
      {
        key: 'finance:bond',
        treatment: 'digest',
        why: 'Borrowing commits the town for decades on a single evening’s vote.',
      },
    ],
    geography: [
      { channel: 'meetings', scope: 'townwide', why: 'Every board, not the nearest ones.' },
      {
        channel: 'land-use',
        scope: 'townwide',
        why: 'A project across town sets the precedent for the one next door.',
      },
      { channel: 'money', scope: 'townwide', why: 'Money has no address.' },
      { channel: 'law', scope: 'townwide', why: 'A by-law applies to the whole town by definition.' },
      { channel: 'elections', scope: 'townwide', why: 'Ballot questions are put to everyone.' },
    ],
    questions: [
      {
        id: 'watchdog_institutions',
        ask: 'Any boards you want followed by name?',
        options: [
          { value: 'Select Board', label: 'Select Board' },
          { value: 'Planning Board', label: 'Planning Board' },
          { value: 'Zoning Board of Appeals', label: 'Zoning Board of Appeals' },
          { value: 'Conservation Commission', label: 'Conservation Commission' },
          { value: 'School Committee', label: 'School Committee' },
          { value: 'Warrant Committee', label: 'Warrant Committee' },
        ],
        applies: 'institutions',
        why: 'Naming a board ranks its records up without hiding the others, which matters here because the boards that matter change with what is in front of them.',
      },
    ],
    downranks: [],
  },
  {
    id: 'neighborhood',
    version: 'neighborhood-1',
    label: 'Near home: land use and the street',
    description:
      'Proposes the records that have a location — land use, roads, parks, hearings and betterments — and draws them around an address you type. It assumes you care about a radius, not a demographic. Without a home location it does almost nothing, which is deliberate: the address is the single genuinely sensitive value stored here, so it is asked for plainly, kept as the text you typed, and deleted in one click.',
    changes: [
      {
        key: 'property:geography',
        treatment: 'digest',
        why: 'Records that name a location are the only ones a near-home radius can rank at all.',
      },
      {
        key: 'service:roads',
        treatment: 'digest',
        why: 'Paving, sidewalks, crossings and closures are decided street by street.',
      },
      {
        key: 'service:parks',
        treatment: 'digest',
        why: 'A park decision is a neighbourhood decision far more often than a town one.',
      },
      {
        key: 'property:hearing_date',
        treatment: 'digest',
        why: 'Abutter notice is a legal minimum, and a short one.',
      },
      {
        key: 'finance:assessment',
        treatment: 'digest',
        why: 'A betterment is charged to the street that got the work, and only to that street.',
      },
    ],
    geography: [
      {
        channel: 'land-use',
        scope: 'near_home',
        why: 'The whole point of the template: permits, variances and site plans within walking distance.',
      },
      {
        channel: 'public-safety',
        scope: 'near_home',
        why: 'Closures and water work are street-level facts and stop being useful two miles away.',
      },
      {
        channel: 'meetings',
        scope: 'townwide',
        why: 'The board deciding your street sits at Town Hall, so the meetings channel stays wide.',
      },
    ],
    questions: [HOME_QUESTION],
    downranks: [],
  },
];

export function getTemplate(id: string): ProfileTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/**
 * Which treatment wins when two templates propose the same key.
 *
 * Ordered so that a downrank never beats a request. A reader who accepts `parent` and `retiree` has
 * asked for schools and asked for them quieter in the same breath, and the resolution that keeps faith
 * with both is to follow them: a template may quiet a row only when nothing else asked for it. `ask`
 * outranks `normal` because an unanswered question is more informative than silence, and `mute` is last
 * because a template is never allowed to reach it.
 */
const TREATMENT_PRECEDENCE: Treatment[] = ['immediate', 'digest', 'ask', 'normal', 'downrank', 'mute'];

/** Widest scope wins, for the same reason: composing two templates must not narrow either one. */
const SCOPE_PRECEDENCE: GeoScope[] = ['townwide', 'selected_institutions', 'near_home', 'off'];

/**
 * Collapse proposed rows to one per key, and drop anything a template must not do.
 *
 * Both the direct path (`applyTemplates`, for a reader picking from a list) and the text path
 * (`proposeFromText` in setup.ts) run through this, which is what makes them produce identical rows and
 * makes composition order-independent. The `mute` filter is a guardrail rather than live code — no
 * template contains one — but it is the place a mute would have to get through, so it is closed here
 * instead of in a comment.
 */
export function resolveChanges<T extends TemplateChange>(changes: T[]): T[] {
  const best = new Map<string, T>();
  for (const change of changes) {
    if (change.treatment === 'mute') continue;
    const held = best.get(change.key);
    if (
      !held ||
      TREATMENT_PRECEDENCE.indexOf(change.treatment) < TREATMENT_PRECEDENCE.indexOf(held.treatment)
    ) {
      best.set(change.key, change);
    }
  }
  return [...best.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveGeography<T extends { channel: Channel; scope: GeoScope }>(rows: T[]): T[] {
  const best = new Map<Channel, T>();
  for (const row of rows) {
    const held = best.get(row.channel);
    if (!held || SCOPE_PRECEDENCE.indexOf(row.scope) < SCOPE_PRECEDENCE.indexOf(held.scope)) {
      best.set(row.channel, row);
    }
  }
  return [...best.values()];
}

/**
 * Apply one or more templates to a profile. Composition is the point.
 *
 * Questions are not applied here, because a question with no answer applies nothing — the caller that
 * collects answers is `acceptProposal`. The templates a reader accepted are recorded for provenance so
 * the editor can say where a row came from; nothing reads that list to rank, and deleting a row does not
 * require deleting the note that explains it.
 */
export function applyTemplates(preferences: Preferences, ids: string[], now = new Date()): Preferences {
  const templates = ids
    .map((id) => getTemplate(id))
    .filter((template): template is ProfileTemplate => Boolean(template));
  if (templates.length === 0) return preferences;

  const proposed = templates.flatMap((template) =>
    [...template.changes, ...template.downranks].map((change) => ({ ...change, template: template.id })),
  );

  let next = preferences;
  for (const change of resolveChanges(proposed)) {
    next = upsertInterest(next, {
      key: change.key,
      treatment: change.treatment,
      origin: 'template',
      template: change.template,
      note: change.why,
    });
  }
  for (const row of resolveGeography(templates.flatMap((template) => template.geography))) {
    next = setScope(next, row.channel, row.scope);
  }

  const accepted = templates.map((template) => ({
    id: template.id,
    version: template.version,
    acceptedAt: now.toISOString(),
  }));
  const kept = next.templates.filter((row) => !accepted.some((entry) => entry.id === row.id));
  return { ...next, templates: [...kept, ...accepted], updatedAt: now.toISOString() };
}
