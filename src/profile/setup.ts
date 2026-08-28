import { CHANNEL_LABELS, CHANNELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { findBlockedMentions } from './blocked.ts';
import type { BlockedMention } from './blocked.ts';
import { impactKey, impactLabel, parseImpactKey, SCHOOL_SCOPES } from './impacts.ts';
import type { SchoolScope } from './impacts.ts';
import {
  findInterest,
  GEO_SCOPE_LABELS,
  ORIGIN_AUTHORITY,
  scopeFor,
  setScope,
  treatmentFor,
  TREATMENT_LABELS,
  upsertInterest,
} from './preferences.ts';
import type { GeoScope, Preferences, Treatment } from './preferences.ts';
import {
  getTemplate,
  resolveChanges,
  resolveGeography,
  SCHOOL_DOWNRANK_NOTE,
  SCHOOL_DOWNRANKS,
  SCHOOL_RETAINED,
  SCHOOL_RETAINED_GEOGRAPHY,
  TEMPLATES,
} from './templates.ts';
import type { TemplateChange, TemplateQuestion } from './templates.ts';

/**
 * "Set me up as a parent with three kids", turned into a preview rather than a profile.
 *
 * The temptation in a setup box is enormous and it is always the same one: read the sentence, decide
 * what kind of person wrote it, and save the result. That is how a system ends up holding a record of
 * somebody's household, income and health that they never typed into a field, cannot see, and did not
 * agree to — assembled out of one friendly sentence. So this module has exactly one output, a
 * `Proposal`, and a proposal is inert. Nothing here writes; `acceptProposal` writes, and only what the
 * reader was shown.
 *
 * Three rules do the work. Matching is deterministic phrase matching over a rules table, so a
 * surprising suggestion is reproducible and fixable in one line. Blocked domains are named out loud
 * rather than silently dropped, because silently ignoring "three kids" and silently recording it look
 * identical from the reader's chair. And a negative sentence downranks rather than mutes, keeping the
 * rows a reader would want back — the school budget they pay for is not what they meant by "no school
 * stuff", and guessing that it was is the same error as guessing anything else about them.
 *
 * The tradeoff: phrase matching understands far less English than a model would. That is accepted here
 * because the failure mode of this component is not "missed a template", which costs one click on the
 * template list, but "quietly learned something about the reader", which costs the premise.
 */

export interface ProposedChange {
  key: string;
  label: string;
  treatment: Treatment;
  /** The current treatment this would replace, so the preview shows a diff. */
  from: Treatment;
  why: string;
  template: string | null;
}

export interface Proposal {
  /** The reader's words, verbatim. Never a cleaned-up paraphrase. */
  request: string;
  matchedTemplates: { id: string; label: string; matched: string }[];
  changes: ProposedChange[];
  geography: { channel: Channel; label: string; scope: GeoScope; from: GeoScope; why: string }[];
  questions: TemplateQuestion[];
  /** Blocked domains the reader mentioned, and what was done instead: nothing. */
  refusals: BlockedMention[];
  /** Plain-English lines shown above the table, e.g. the downrank explanation. */
  notes: string[];
  /** True when nothing matched — the caller should offer the template list. */
  empty: boolean;
}

/**
 * The phrases that name a template, most literal first.
 *
 * Rules rather than a model, for the reason the rest of the pipeline gives: the deterministic provider
 * is the floor, a model is opt-in on top of it, and this particular floor has to hold even when nothing
 * else is configured. A model-backed parser would slot in immediately below this table behind the same
 * boundary — it would return template ids and matched spans and nothing else, its output would still be
 * a `Proposal` the reader has to accept, and it would still be handed to `findBlockedMentions` on the
 * way past. What it must never acquire is the ability to invent a preference key or to save one.
 *
 * Patterns are deliberately narrow. A false positive here is a row a reader has to notice and delete,
 * which is a worse outcome than the template being missed entirely and picked from the list by hand.
 */
export const TEMPLATE_TRIGGERS: { template: string; pattern: RegExp }[] = [
  { template: 'parent', pattern: /\b(parents?|kids?|children|school[- ]age|my (?:son|daughter)|pta|pto)\b/i },
  { template: 'retiree', pattern: /\b(retired|retiree|retirement|senior|council on aging|elderly)\b/i },
  {
    template: 'homeowner',
    pattern:
      /\b(homeowner|home ?owner|(?:i|we|who) owns?|own (?:my|our) (?:home|house|condo)|bought (?:a|my) (?:house|home|condo))\b/i,
  },
  {
    // `(?:i|we|who) rents?` rather than a bare `rents?`: the town rents the
    // hall, a hall rents for $200, and neither sentence is somebody telling us
    // they are a tenant.
    template: 'renter',
    pattern: /\b(renter|tenant|(?:i|we|who) rents?|renting|my landlord|my apartment)\b/i,
  },
  {
    template: 'transit-rider',
    pattern: /\b(mbta|transit|trolley|mattapan line|bus (?:route|stop)|commuter rail|i take the t)\b/i,
  },
  {
    template: 'newcomer',
    pattern: /\b(new to (?:town|milton)|just moved|newcomer|new resident|moved here|new here)\b/i,
  },
  {
    template: 'watchdog',
    pattern:
      /\b(watchdog|all (?:the )?meetings|every meeting|select board|town meeting|follow everything|keep an eye|hold them accountable)\b/i,
  },
  {
    template: 'neighborhood',
    pattern:
      /\b(neighbou?rhood|my street|my block|near (?:me|my (?:home|house|street))|next door|abutter|down the street)\b/i,
  },
];

/**
 * Sentences that ask for less, and the rows that survive them.
 *
 * Only one entry ships, and that is not an oversight. "No school stuff" is the case where a reader's
 * plain meaning and a literal reading come apart badly enough to matter — they mean the concerts, and a
 * literal reading takes the budget with it. Every other topic degrades gracefully under a downrank, so
 * inventing rules for them would be adding guesses to a module whose whole argument is that it does not
 * guess. `suppresses` matters as much as the downranks: "I don't have kids" contains the word "kids",
 * and without it the parent template would match the exact sentence that rejects it.
 */
export const NEGATION_RULES: {
  id: string;
  pattern: RegExp;
  suppresses: string[];
  downranks: TemplateChange[];
  retains: TemplateChange[];
  retainedGeography: { channel: Channel; scope: GeoScope; why: string }[];
  note: string;
}[] = [
  {
    id: 'no-schools',
    pattern:
      /\b(?:no|not|never|nothing|without|don['’]?t|do not|doesn['’]?t|isn['’]?t)\b[^.;!?]{0,28}\b(?:kids?|children|schools?|school stuff|pta|pto)\b/i,
    suppresses: ['parent'],
    downranks: SCHOOL_DOWNRANKS,
    retains: SCHOOL_RETAINED,
    retainedGeography: SCHOOL_RETAINED_GEOGRAPHY,
    note: SCHOOL_DOWNRANK_NOTE,
  },
];

/**
 * How an offered topic is worded when a blocked domain comes up.
 *
 * `impactLabel` gives the editor's wording — "Property tax" — which is right in a table of rows and
 * wrong in a sentence offering something in place of a refusal. Only the domains whose offer needs
 * softer wording appear here; the rest fall through to the label.
 */
const OFFER_ASKS: Record<string, string> = {
  income: 'Add property-tax and fee programs as an interest?',
  disability: 'Add accessibility and accommodation decisions as an interest?',
  exact_age: 'Add senior services and age-based programs as an interest?',
};

/**
 * Which heading a row appears under in the plain-text preview.
 *
 * First match wins, so the order is the design's order rather than the vocabulary's: a reader scanning
 * this is looking for "did it do something odd to my schools", and the schools have to be at the top
 * where that question gets answered in one glance.
 */
const SECTIONS: { title: string; match: (key: string) => boolean }[] = [
  { title: 'Schools', match: (key) => key.startsWith('school:') || /school/i.test(key) },
  {
    title: 'Family services',
    match: (key) => ['service:childcare', 'service:parks', 'service:libraries'].includes(key),
  },
  {
    title: 'Senior services',
    match: (key) => key === 'service:senior_services' || /council on aging/i.test(key),
  },
  { title: 'Money and bills', match: (key) => key.startsWith('finance:') },
  { title: 'Eligibility', match: (key) => key.startsWith('eligibility:') },
  { title: 'Meetings and decisions', match: (key) => key.startsWith('property:') },
  { title: 'Institutions', match: (key) => key.startsWith('institution:') },
  { title: 'Services', match: (key) => key.startsWith('service:') },
];

function sectionFor(key: string): string {
  return SECTIONS.find((section) => section.match(key))?.title ?? 'Other';
}

/** A question built out of a refusal, so an offer is something to accept rather than something applied. */
function offerQuestion(mention: BlockedMention): TemplateQuestion | null {
  if (!mention.offer) return null;
  return {
    id: `offer:${mention.domain}`,
    ask: OFFER_ASKS[mention.domain] ?? `Add ${impactLabel(mention.offer).toLowerCase()} as an interest?`,
    options: [
      { value: mention.offer, label: `Yes — follow ${impactLabel(mention.offer)}` },
      { value: 'skip', label: 'No thanks' },
    ],
    single: true,
    applies: 'interests',
    why: mention.say,
  };
}

/**
 * Read a sentence and produce something the reader can argue with.
 *
 * The order matters. Refusals are collected from the raw text first, so that a blocked mention is on
 * the record even when nothing else in the sentence matches anything. Negations are read before
 * triggers, because a negation suppresses the template its own words would otherwise match. Only then
 * are template rows gathered, resolved, and diffed against what the reader already has — and a row they
 * set themselves is dropped from the proposal rather than shown as a change that will not happen.
 */
export function proposeFromText(text: string, current: Preferences): Proposal {
  const request = text;
  const refusals = findBlockedMentions(text);
  const negations = NEGATION_RULES.filter((rule) => rule.pattern.test(text));
  const suppressed = new Set(negations.flatMap((rule) => rule.suppresses));

  const matchedTemplates: { id: string; label: string; matched: string }[] = [];
  const proposed: ProposedChange[] = [];
  const geographyRows: { channel: Channel; scope: GeoScope; why: string }[] = [];
  const questions: TemplateQuestion[] = [];

  for (const trigger of TEMPLATE_TRIGGERS) {
    if (suppressed.has(trigger.template)) continue;
    const match = trigger.pattern.exec(text);
    const template = getTemplate(trigger.template);
    if (!match || !template) continue;

    matchedTemplates.push({ id: template.id, label: template.label, matched: match[0].trim() });
    for (const change of [...template.changes, ...template.downranks]) {
      proposed.push(asProposed(change, template.id, current));
    }
    geographyRows.push(...template.geography);
    questions.push(...template.questions);
  }

  for (const rule of negations) {
    // A reader's own sentence carries their authority, so these rows have no template attached — which
    // is also what stops a template accepted later from quietly undoing them.
    for (const change of [...rule.downranks, ...rule.retains]) {
      proposed.push(asProposed(change, null, current));
    }
    geographyRows.push(...rule.retainedGeography);
  }

  for (const mention of refusals) {
    const question = offerQuestion(mention);
    if (question) questions.push(question);
  }

  // A row the reader set themselves outranks a template (see ORIGIN_AUTHORITY), so proposing it would
  // be showing a change that `acceptProposal` is going to refuse. It is named in a note instead.
  const held = proposed.filter((change) => change.template !== null && isReaderHeld(current, change.key));
  const changes = resolveChanges(proposed.filter((change) => !held.some((row) => row.key === change.key)));

  const geography = resolveGeography(geographyRows)
    .map((row) => ({
      channel: row.channel,
      label: CHANNEL_LABELS[row.channel],
      scope: row.scope,
      from: scopeFor(current, row.channel),
      why: row.why,
    }))
    .sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));

  const notes = ['Nothing here is saved until you accept it, and every row stays editable afterwards.'];
  if (changes.some((change) => change.treatment === 'downrank' && sectionFor(change.key) === 'Schools')) {
    notes.push(SCHOOL_DOWNRANK_NOTE);
  }
  if (changes.some((change) => change.treatment === 'ask')) {
    notes.push('Rows marked Ask do nothing at all until you answer the question that goes with them.');
  }
  if (held.length > 0) {
    const names = [...new Set(held.map((row) => row.label))].join(', ');
    notes.push(`Left alone, because you set them yourself: ${names}.`);
  }
  if (refusals.length > 0) {
    notes.push(
      'Some of what you wrote is listed under "Not recorded" below. It changed nothing above, and none of it was stored.',
    );
  }

  const uniqueQuestions = questions.filter(
    (question, index) => questions.findIndex((other) => other.id === question.id) === index,
  );

  return {
    request,
    matchedTemplates,
    changes,
    geography,
    questions: uniqueQuestions,
    refusals,
    notes,
    empty: changes.length === 0 && uniqueQuestions.length === 0,
  };
}

function asProposed(change: TemplateChange, template: string | null, current: Preferences): ProposedChange {
  return {
    key: change.key,
    label: impactLabel(change.key),
    treatment: change.treatment,
    from: treatmentFor(current, change.key),
    why: change.why,
    template,
  };
}

function isReaderHeld(current: Preferences, key: string): boolean {
  const existing = findInterest(current, key);
  return Boolean(existing && ORIGIN_AUTHORITY[existing.origin] > ORIGIN_AUTHORITY.template);
}

/**
 * Apply answers to setup questions, wherever they were answered.
 *
 * Split out of `acceptProposal` because a question outlives the proposal that raised it. A reader who
 * accepts "retiree" without saying whether they own or rent leaves a row sitting at `ask`, and that row
 * has to be answerable later from the preferences page rather than only in the sixty seconds the
 * preview was on screen. Both callers pass the questions they actually showed, so a form field invented
 * between render and post cannot introduce a row nobody was asked about.
 *
 * An answer carries the reader's own authority, which is why everything written here is `declared`.
 */
export function applyAnswers(
  preferences: Preferences,
  questions: TemplateQuestion[],
  choices: Record<string, string[]>,
): Preferences {
  let next = preferences;
  const asked = new Map(questions.map((question) => [question.id, question]));

  for (const [id, values] of Object.entries(choices)) {
    const question = asked.get(id);
    if (!question) continue;
    const answers = values.filter((value) => value && value !== 'skip');

    if (question.applies === 'school_stages') {
      const picked = answers.filter((value): value is SchoolScope =>
        (SCHOOL_SCOPES as readonly string[]).includes(value),
      );
      const stages = SCHOOL_SCOPES.filter(
        (stage) => picked.includes(stage) || next.schools.stages.includes(stage),
      );
      next = { ...next, schools: { ...next.schools, stages } };
      for (const stage of picked) {
        next = upsertInterest(next, {
          key: impactKey('school', stage),
          treatment: 'digest',
          origin: 'declared',
          note: 'You picked this stage during setup.',
        });
      }
    }

    if (question.applies === 'institutions') {
      for (const name of answers) {
        next = upsertInterest(next, {
          key: impactKey('institution', name),
          treatment: 'digest',
          origin: 'declared',
          note: 'You asked for this institution by name during setup.',
        });
        // `schools.institutions` exists so the school editor has something to list. The check is on the
        // name because the institution dimension is open by design — a bus route answering the same
        // kind of question has no business in a list of schools.
        if (/\b(school|elementary|middle|high)\b/i.test(name) && !next.schools.institutions.includes(name)) {
          next = {
            ...next,
            schools: { ...next.schools, institutions: [...next.schools.institutions, name] },
          };
        }
      }
    }

    if (question.applies === 'interests') {
      for (const key of answers) {
        // `upsertInterest` refuses anything outside the impact vocabulary, so a junk option value is
        // dropped rather than stored and ignored.
        next = upsertInterest(next, {
          key,
          treatment: 'digest',
          origin: 'declared',
          note: 'You answered a setup question with this.',
        });
      }
    }

    if (question.applies === 'geography') {
      for (const channel of answers) {
        if ((CHANNELS as readonly string[]).includes(channel)) {
          next = setScope(next, channel as Channel, 'townwide');
        }
      }
    }

    // `home` is not applied here. A home location needs a geocoder and a confirmation step, and
    // inventing coordinates from an answer to a yes/no question is exactly the kind of quiet guess this
    // module exists to refuse. The caller collects the address and writes it.
  }

  return next;
}

/**
 * Write the rows the reader looked at, and nothing else.
 *
 * Answers are the interesting half. `choices` is keyed by question id and is filtered against the
 * questions this proposal actually asked, so a form field invented somewhere between the preview and
 * the post cannot introduce a row that was never shown. An answer carries the reader's own authority —
 * they typed it — which is why school stages land as `declared` and not as something a template
 * decided, and why the ownership question stores `finance:property_tax` as a topic rather than storing
 * that the reader owns a house. There is no field for the latter.
 */
export function acceptProposal(
  preferences: Preferences,
  proposal: Proposal,
  choices: Record<string, string[]> = {},
): Preferences {
  let next = preferences;

  for (const change of proposal.changes) {
    // Defence in depth: a template cannot reach `mute`, and a hand-built proposal does not get to
    // either. Muting is a decision a reader makes in the editor, one row at a time.
    if (change.treatment === 'mute') continue;
    next = upsertInterest(next, {
      key: change.key,
      treatment: change.treatment,
      origin: change.template ? 'template' : 'declared',
      ...(change.template ? { template: change.template } : {}),
      note: change.why,
    });
  }

  for (const row of proposal.geography) {
    if (row.scope !== scopeFor(next, row.channel)) next = setScope(next, row.channel, row.scope);
  }

  next = applyAnswers(next, proposal.questions, choices);

  const accepted = proposal.matchedTemplates
    .map((match) => getTemplate(match.id))
    .filter((template) => Boolean(template))
    .map((template) => ({
      id: template!.id,
      version: template!.version,
      acceptedAt: new Date().toISOString(),
    }));
  const kept = next.templates.filter((row) => !accepted.some((entry) => entry.id === row.id));

  return { ...next, templates: [...kept, ...accepted], updatedAt: new Date().toISOString() };
}

/**
 * The preview as plain text, for the CLI.
 *
 * Deliberately the same shape as the web preview: what the reader said, what matched, what was refused,
 * then the rows grouped and aligned so that the treatment column can be read down without reading
 * across. No colour codes — the CLI adds those, and this string also ends up in logs and in tests,
 * where escape sequences are noise.
 */
export function formatProposal(proposal: Proposal): string {
  const lines: string[] = [];
  lines.push('Setup preview. Nothing is saved until you accept.');
  lines.push('');
  lines.push(`  You said: "${proposal.request}"`);
  lines.push('');

  if (proposal.matchedTemplates.length > 0) {
    lines.push('Matched templates');
    for (const match of proposal.matchedTemplates) {
      lines.push(`  ${match.id.padEnd(14)}${match.label}  (matched "${match.matched}")`);
    }
    lines.push('');
  }

  for (const note of proposal.notes) {
    lines.push(`  - ${note}`);
  }
  lines.push('');

  if (proposal.refusals.length > 0) {
    lines.push('Not recorded');
    for (const refusal of proposal.refusals) {
      lines.push(`  ${refusal.label}`);
      lines.push(`    you wrote: "${refusal.matched}"`);
      lines.push(`    ${refusal.say}`);
    }
    lines.push('');
  }

  const width = columnWidth([
    ...proposal.changes.map((change) => change.label),
    ...proposal.geography.map((row) => row.label),
  ]);

  for (const section of [...SECTIONS.map((entry) => entry.title), 'Other']) {
    const rows = proposal.changes.filter((change) => sectionFor(change.key) === section);
    if (rows.length === 0) continue;
    lines.push(section);
    for (const row of rows) {
      const change =
        row.from === row.treatment ? '(unchanged)' : `(was ${TREATMENT_LABELS[row.from].toLowerCase()})`;
      lines.push(`  ${row.label.padEnd(width)}${TREATMENT_LABELS[row.treatment].padEnd(12)}${change}`);
    }
    lines.push('');
  }

  if (proposal.geography.length > 0) {
    lines.push('Geography');
    for (const row of proposal.geography) {
      const change =
        row.from === row.scope ? '(unchanged)' : `(was ${GEO_SCOPE_LABELS[row.from].toLowerCase()})`;
      lines.push(`  ${row.label.padEnd(width)}${GEO_SCOPE_LABELS[row.scope].padEnd(12)}${change}`);
    }
    lines.push('');
  }

  if (proposal.questions.length > 0) {
    lines.push('Questions');
    proposal.questions.forEach((question, index) => {
      lines.push(`  ${index + 1}. ${question.ask}`);
      const marker = question.single ? '( )' : '[ ]';
      for (const option of question.options) {
        lines.push(`       ${marker} ${option.label}`);
      }
      lines.push(`     Asked because: ${question.why}`);
    });
    lines.push('');
  }

  if (proposal.empty) {
    lines.push('None of that matched a template. The ones on offer are:');
    for (const template of TEMPLATES) {
      lines.push(`  ${template.id.padEnd(14)}${template.label}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Wide enough for the longest label, bounded so one institution name cannot push the column off. */
function columnWidth(labels: string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.min(Math.max(longest + 2, 26), 44);
}
