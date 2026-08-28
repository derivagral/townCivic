import { describe, expect, it } from 'vitest';
import { TEMPLATES, applyTemplates, getTemplate, pendingQuestions } from '../src/profile/templates.ts';
import { acceptProposal, applyAnswers, formatProposal, proposeFromText } from '../src/profile/setup.ts';
import {
  defaultPreferences,
  findInterest,
  scopeFor,
  treatmentFor,
  upsertInterest,
} from '../src/profile/preferences.ts';
import { impactKey } from '../src/profile/impacts.ts';

/**
 * The tests that matter here are about what a sentence is *not* allowed to do.
 *
 * "Set me up as a parent with three kids" is the whole design in one line: it
 * should produce a useful proposal, ask about school stages, refuse to record a
 * household, and save nothing until someone says yes. Each of those is one
 * careless edit away from being untrue, and none of them is visible from the
 * outside once it stops being true.
 */

const parent = () => proposeFromText('Set me up as a parent with three kids', defaultPreferences());
const retiree = () => proposeFromText('empty-nest retiree', defaultPreferences());

describe('the templates themselves', () => {
  it('explains every row it proposes', () => {
    for (const template of TEMPLATES) {
      expect(template.description.length, template.id).toBeGreaterThan(40);
      for (const change of [...template.changes, ...template.downranks]) {
        expect(change.why.length, `${template.id} / ${change.key}`).toBeGreaterThan(10);
      }
      for (const question of template.questions) {
        expect(question.why.length, `${template.id} / ${question.id}`).toBeGreaterThan(10);
      }
    }
  });

  it('never mutes anything', () => {
    // A template may downrank. Muting is a decision a reader makes one row at a
    // time in the editor, because "we assumed you did not want this" and "you
    // told us you did not want this" are different claims.
    for (const template of TEMPLATES) {
      for (const change of [...template.changes, ...template.downranks]) {
        expect(change.treatment, `${template.id} muted ${change.key}`).not.toBe('mute');
      }
    }
  });

  it('composes: two templates give the union, not a conflict', () => {
    const both = applyTemplates(defaultPreferences(), ['retiree', 'renter']);
    const onlyRetiree = applyTemplates(defaultPreferences(), ['retiree']);

    expect(both.interests.length).toBeGreaterThanOrEqual(onlyRetiree.interests.length);
    expect(both.templates.map((t) => t.id).sort()).toEqual(['renter', 'retiree']);
    // One key, one treatment — composition may not leave two contradictory rows.
    expect(new Set(both.interests.map((i) => i.key)).size).toBe(both.interests.length);
  });

  it('records which template a row came from, and nothing else about it', () => {
    const applied = applyTemplates(defaultPreferences(), ['transit-rider']);
    const fromTemplate = applied.interests.filter((interest) => interest.origin === 'template');
    expect(fromTemplate.length).toBeGreaterThan(0);
    for (const interest of fromTemplate) expect(interest.template).toBeTruthy();
  });

  it('has no template for an attribute it refuses to infer', () => {
    for (const id of ['income', 'disabled', 'religion', 'veteran-status']) {
      expect(getTemplate(id), `a template exists for ${id}`).toBeUndefined();
    }
  });
});

describe('"set me up as a parent with three kids"', () => {
  it('matches the parent template and proposes school interests', () => {
    const proposal = parent();
    expect(proposal.matchedTemplates.map((t) => t.id)).toContain('parent');
    expect(proposal.changes.map((c) => c.key)).toContain(impactKey('service', 'schools'));
    expect(proposal.empty).toBe(false);
  });

  it('asks which stages instead of reading them out of the word "parent"', () => {
    const proposal = parent();
    const stages = proposal.questions.find((question) => question.applies === 'school_stages');
    expect(stages).toBeDefined();
    expect(stages!.options.map((option) => option.value)).toEqual([
      'preschool',
      'elementary',
      'middle',
      'high',
    ]);
    // Nothing about a stage is decided before the question is answered.
    expect(proposal.changes.map((c) => c.key)).not.toContain(impactKey('school', 'elementary'));
  });

  it('refuses the household, names the refusal, and stores nothing from it', () => {
    const proposal = parent();
    const refusal = proposal.refusals.find((r) => r.domain === 'household_composition');
    expect(refusal).toBeDefined();
    expect(refusal!.matched).toContain('three');

    const after = acceptProposal(defaultPreferences(), proposal);
    const document = JSON.stringify(after);
    expect(document).not.toMatch(/three/i);
    expect(document).not.toMatch(/\bkids\b/i);
  });

  it('renders a preview a person can read before agreeing to it', () => {
    const text = formatProposal(parent());
    expect(text).toContain('Schools');
    expect(text).toMatch(/Digest/);
    expect(text).toMatch(/not saved|Nothing is saved/i);
    expect(text).toMatch(/Not recorded/);
    // Plain text: the CLI adds colour, the formatter does not.
    expect(text).not.toContain('');
  });
});

describe('the retiree case', () => {
  it('downranks routine school programming and keeps what reaches the whole town', () => {
    const proposal = retiree();
    const treatment = (key: string) => proposal.changes.find((c) => c.key === key)?.treatment;

    expect(treatment(impactKey('school', 'elementary'))).toBe('downrank');
    expect(treatment(impactKey('school', 'districtwide'))).toBe('digest');
    expect(treatment(impactKey('finance', 'operating_budget'))).toBe('digest');

    expect(proposal.notes.join(' ')).toMatch(/downranked routine school programming/i);
    expect(proposal.notes.join(' ')).toMatch(/budgets/i);
  });

  it('mutes nothing, because a negative assumption is not a decision', () => {
    for (const change of retiree().changes) expect(change.treatment).not.toBe('mute');
  });

  it('asks about tenure rather than assuming a homeowner', () => {
    const proposal = retiree();
    const tax = proposal.changes.find((c) => c.key === impactKey('finance', 'property_tax'));
    expect(tax?.treatment).toBe('ask');
    expect(proposal.questions.some((q) => /own|rent/i.test(q.ask))).toBe(true);

    // `ask` is inert: accepting the proposal must not turn it into a preference
    // that ranks anything.
    const after = acceptProposal(defaultPreferences(), proposal);
    expect(['ask', 'normal']).toContain(treatmentFor(after, impactKey('finance', 'property_tax')));
  });

  it('proposes daytime meetings and senior services, which are topics not attributes', () => {
    const keys = retiree().changes.map((c) => c.key);
    expect(keys).toContain(impactKey('service', 'senior_services'));
    expect(keys).toContain(impactKey('property', 'daytime_meeting'));
  });
});

describe('blocked mentions in free text', () => {
  it('acknowledges an income mention and changes nothing because of it', () => {
    const proposal = proposeFromText('I am on a fixed income', defaultPreferences());
    expect(proposal.refusals.map((r) => r.domain)).toContain('income');

    const after = acceptProposal(defaultPreferences(), proposal);
    // The offer exists, as a question. It is not applied.
    expect(findInterest(after, impactKey('finance', 'property_tax'))?.treatment ?? 'normal').not.toBe(
      'digest',
    );
    expect(proposal.questions.length + proposal.refusals.length).toBeGreaterThan(0);
  });

  it('acknowledges a disability mention without recording anything about the reader', () => {
    const proposal = proposeFromText('I use a wheelchair', defaultPreferences());
    expect(proposal.refusals.map((r) => r.domain)).toContain('disability');
    expect(JSON.stringify(acceptProposal(defaultPreferences(), proposal))).not.toMatch(/wheelchair/i);
  });

  it('keeps the reader’s own words in the proposal, unedited', () => {
    const said = "I'm retired and on a fixed income";
    expect(proposeFromText(said, defaultPreferences()).request).toBe(said);
  });
});

describe('accepting a proposal', () => {
  it('writes only what was shown', () => {
    const proposal = parent();
    const after = acceptProposal(defaultPreferences(), proposal);
    const shown = new Set(proposal.changes.filter((c) => c.treatment !== 'normal').map((c) => c.key));

    for (const interest of after.interests) {
      expect(shown.has(interest.key), `${interest.key} was written but never shown`).toBe(true);
    }
  });

  it('does not overwrite a row the reader set themselves', () => {
    const held = upsertInterest(defaultPreferences(), {
      key: impactKey('service', 'schools'),
      treatment: 'mute',
      origin: 'declared',
    });
    const proposal = proposeFromText('set me up as a parent', held);
    const after = acceptProposal(held, proposal);
    expect(treatmentFor(after, impactKey('service', 'schools'))).toBe('mute');
  });

  it('applies an answered question, and only what the question asked', () => {
    const proposal = parent();
    const question = proposal.questions.find((q) => q.applies === 'school_stages')!;
    const after = acceptProposal(defaultPreferences(), proposal, {
      [question.id]: ['elementary'],
      'not-a-question': ['middle'],
    });

    expect(after.schools.stages).toEqual(['elementary']);
  });

  it('changes nothing at all when the reader declines by never calling accept', () => {
    const before = defaultPreferences();
    proposeFromText('set me up as a retiree who rents', before);
    expect(before.interests).toEqual([]);
    expect(before.schools.stages).toEqual([]);
  });

  it('records the templates it applied, for provenance only', () => {
    const after = acceptProposal(defaultPreferences(), parent());
    expect(after.templates.map((t) => t.id)).toContain('parent');
    expect(after.templates[0]!.version).toBeTruthy();
  });

  it('widens school geography when the reader is following schools', () => {
    const after = acceptProposal(defaultPreferences(), parent());
    expect(['townwide', 'selected_institutions']).toContain(scopeFor(after, 'schools'));
  });
});

describe('questions that outlive the preview', () => {
  it('keeps asking a question the profile has no answer to', () => {
    // Accepting the retiree template without answering leaves property tax at
    // `ask`, which does nothing. If nobody ever asks again, the system raised a
    // question and then lost interest in the answer.
    const after = acceptProposal(defaultPreferences(), retiree());
    expect(treatmentFor(after, impactKey('finance', 'property_tax'))).toBe('ask');
    expect(pendingQuestions(after).map((row) => row.question.id)).toContain('tenure');
  });

  it('retires the question once the profile carries an answer', () => {
    const after = acceptProposal(defaultPreferences(), retiree());
    const tenure = pendingQuestions(after).find((row) => row.question.id === 'tenure')!;
    const answered = applyAnswers(after, [tenure.question], {
      tenure: [impactKey('finance', 'property_tax')],
    });

    expect(treatmentFor(answered, impactKey('finance', 'property_tax'))).toBe('digest');
    expect(pendingQuestions(answered).map((row) => row.question.id)).not.toContain('tenure');
  });

  it('retires a stage question answered by editing the profile directly', () => {
    // The question is derived from the profile rather than stored as a queue, so
    // an answer given anywhere retires it. Nagging a reader who already said is
    // worse than missing one row.
    const after = acceptProposal(defaultPreferences(), parent());
    expect(pendingQuestions(after).some((row) => row.question.applies === 'school_stages')).toBe(true);

    const edited = { ...after, schools: { ...after.schools, stages: ['middle' as const] } };
    expect(pendingQuestions(edited).some((row) => row.question.applies === 'school_stages')).toBe(false);
  });

  it('asks nothing of a reader who accepted no template', () => {
    expect(pendingQuestions(defaultPreferences())).toEqual([]);
  });

  it('honours only the questions it was given', () => {
    const before = defaultPreferences();
    const after = applyAnswers(before, [], { school_stages: ['elementary'] });
    expect(after.schools.stages).toEqual([]);
  });
});

describe('reading tenure out of a sentence', () => {
  it('matches the way people actually write it', () => {
    const matched = (said: string) =>
      proposeFromText(said, defaultPreferences()).matchedTemplates.map((t) => t.id);

    expect(matched('retiree who rents and takes the trolley')).toContain('renter');
    expect(matched('I rent an apartment near the square')).toContain('renter');
    expect(matched('homeowner who owns a two-family')).toContain('homeowner');
  });

  it('does not read a hall rental as a tenancy', () => {
    // "The town rents the hall" is not somebody telling us they are a tenant.
    expect(
      proposeFromText('the town rents the hall for events', defaultPreferences()).matchedTemplates.map(
        (t) => t.id,
      ),
    ).not.toContain('renter');
  });
});

describe('a sentence that matches nothing', () => {
  it('says so rather than inventing a profile', () => {
    const proposal = proposeFromText('asdfgh qwerty', defaultPreferences());
    expect(proposal.empty).toBe(true);
    expect(proposal.changes).toEqual([]);
  });
});
