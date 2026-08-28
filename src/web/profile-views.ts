import type { EventRow } from '../db/repo.ts';
import { CHANNELS, CHANNEL_LABELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { EMPTY_FILTERS, escapeHtml, eventCard, layout } from './views.ts';
import {
  DIMENSION_LABELS,
  IMPACT_DIMENSIONS,
  SCHOOL_SCOPES,
  SCHOOL_SCOPE_LABELS,
  allImpactKeys,
  impactLabel,
  parseImpactKey,
} from '../profile/impacts.ts';
import {
  GEO_SCOPES,
  GEO_SCOPE_LABELS,
  ORIGIN_LABELS,
  TREATMENTS,
  TREATMENT_DESCRIPTIONS,
  TREATMENT_LABELS,
  scopeFor,
  treatmentFor,
} from '../profile/preferences.ts';
import type { Preferences, Treatment } from '../profile/preferences.ts';
import { BLOCKED_DOMAINS, DECLARED_ONLY } from '../profile/blocked.ts';
import { SCORING } from '../profile/score.ts';
import type { ScoredEvent } from '../profile/score.ts';
import type { AlertHit, AlertRule } from '../profile/alerts.ts';
import { describeRule } from '../profile/alerts.ts';
import type { Proposal } from '../profile/setup.ts';
import type { ProfileTemplate, TemplateQuestion } from '../profile/templates.ts';
import type { InterestSuggestion } from '../profile/store.ts';

/**
 * The pages where personalization is visible, editable and arguable.
 *
 * Every one of these exists because of the same rule: a preference a reader
 * cannot see is a preference they cannot correct. So the ranked feed shows the
 * reason under every record, the setup page shows a proposal before anything is
 * saved, the preferences page is the profile in full on one screen, and the
 * alerts page is a list of sentences rather than a slider. None of it is a
 * settings drawer bolted onto a feed — the explanation *is* the feature.
 */

/** Splice the "shown because" line into a card the shared renderer produced. */
function withExplanation(card: string, explanation: string): string {
  if (!explanation) return card;
  return card.replace('</article>', `  <p class="why">${escapeHtml(explanation)}</p>\n</article>`);
}

interface PageChrome {
  jurisdictionLabel: string;
  sampleData: boolean;
  account?: string | null;
  notice?: string;
}

/* ------------------------------------------------------------- for you */

export interface ForYouViewModel extends PageChrome {
  scored: ScoredEvent[];
  upcoming: ScoredEvent[];
  /** How many records were considered, before ranking. */
  considered: number;
  /** How many a preference muted. Shown as a count, with a link to `/`. */
  muted: number;
  preferences: Preferences;
  suggestions: InterestSuggestion[];
  csrfToken: string;
  feedUrl: string;
}

function scoredList(items: ScoredEvent[]): string {
  return items
    .map((item) => withExplanation(eventCard(item.row, EMPTY_FILTERS), item.explanation))
    .join('\n');
}

export function renderForYou(model: ForYouViewModel): string {
  const configured = model.preferences.interests.length + model.preferences.schools.stages.length;

  const suggestions = model.suggestions.length
    ? `<section class="agenda">
  <h2>Because of what you follow</h2>
  <p class="count">Derived from subscriptions you created, never from what you opened. Nothing here is applied
     until you say so.</p>
  ${model.suggestions
    .map(
      (suggestion) => `<div class="subscription">
    <span>${escapeHtml(suggestion.ask)} <span class="origin">${escapeHtml(suggestion.evidence)}</span></span>
    <form method="post" action="/my/suggestions">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      <input type="hidden" name="key" value="${escapeHtml(suggestion.key)}">
      <button type="submit" name="action" value="accept">Add it</button>
    </form>
  </div>`,
    )
    .join('')}
</section>`
    : '';

  const empty = !configured
    ? `<div class="empty">
        <p>You have not told townCivic anything yet, so this is close to the chronological record.</p>
        <p><a href="/my/setup">Set up a profile</a> — describe yourself in a sentence and see exactly what it
           would change before anything is saved.</p>
      </div>`
    : !model.scored.length && !model.upcoming.length
      ? `<div class="empty"><p>Nothing matches your preferences yet.</p>
         <p>The full record is always at <a href="/">All</a>.</p></div>`
      : '';

  const body = `
<div class="toolbar">
  <strong>${model.scored.length + model.upcoming.length}</strong>
  <span class="count">of ${model.considered} record${model.considered === 1 ? '' : 's'}, ranked against
    ${configured} preference${configured === 1 ? '' : 's'}${
      model.muted ? ` · ${model.muted} muted, still in <a href="/">All</a>` : ''
    }</span>
</div>
${model.notice ? `<p class="count" style="color:var(--accent)">${escapeHtml(model.notice)}</p>` : ''}
${empty}
${
  model.upcoming.length
    ? `<h2 class="count" style="margin:22px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Coming up</h2>${scoredList(model.upcoming)}`
    : ''
}
${
  model.scored.length
    ? `<h2 class="count" style="margin:30px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Recent</h2>${scoredList(model.scored)}`
    : ''
}
${suggestions}`;

  const aside = `
<div class="group">
  <h2>This view</h2>
  <p class="count">Ranked, not filtered. Every record here says why it is here, and the unranked record is one
     click away at <a href="/">All</a>.</p>
</div>
<div class="group">
  <h2>Your profile</h2>
  <ul>
    <li><a href="/my/preferences">Edit preferences</a></li>
    <li><a href="/my/setup">Describe yourself in a sentence</a></li>
    <li><a href="/alerts">Alert rules</a></li>
    <li><a href="/my">Subscriptions and feed</a></li>
  </ul>
</div>
<div class="group">
  <h2>Feed</h2>
  <p class="count"><a href="${escapeHtml(model.feedUrl)}">This view as Atom</a>. The URL contains a token that
     stands in for your password.</p>
</div>`;

  return layout({
    title: 'For you — townCivic',
    jurisdictionLabel: model.jurisdictionLabel,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    aside,
    view: 'for-you',
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/* -------------------------------------------------------------- alerts */

export interface AlertsViewModel extends PageChrome {
  rules: AlertRule[];
  hits: AlertHit[];
  suggested: Omit<AlertRule, 'id'>[];
  hasHome: boolean;
  csrfToken: string;
  error?: string;
}

export function renderAlerts(model: AlertsViewModel): string {
  const rules = model.rules.length
    ? model.rules
        .map(
          (rule) => `<div class="rule">
  <span>
    <strong>${escapeHtml(rule.label)}</strong>
    ${rule.enabled ? '' : '<span class="pill off">paused</span>'}
    <br><span class="params">${escapeHtml(describeRule(rule))}</span>
  </span>
  <form method="post" action="/alerts/rules">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
    <input type="hidden" name="id" value="${escapeHtml(rule.id)}">
    <button type="submit" name="action" value="${rule.enabled ? 'pause' : 'resume'}">${rule.enabled ? 'Pause' : 'Resume'}</button>
    <button type="submit" name="action" value="remove">Remove</button>
  </form>
</div>`,
        )
        .join('')
    : `<p class="count">No rules yet. An alert here is an explicit sentence you wrote down — nothing arrives
        because a model thought you would like it.</p>`;

  const suggested = model.suggested.length
    ? `<section class="agenda">
  <h2>Rules your profile implies</h2>
  <p class="count">Suggested from preferences you already set. None of them exists until you add it.</p>
  ${model.suggested
    .map(
      (rule) => `<div class="rule">
    <span><strong>${escapeHtml(rule.label)}</strong><br><span class="params">${escapeHtml(describeRule({ ...rule, id: 'suggested' }))}</span></span>
    <form method="post" action="/alerts/rules">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      <input type="hidden" name="kind" value="${escapeHtml(rule.kind)}">
      <input type="hidden" name="label" value="${escapeHtml(rule.label)}">
      <input type="hidden" name="params" value="${escapeHtml(JSON.stringify(rule.params))}">
      <button type="submit" name="action" value="add">Add rule</button>
    </form>
  </div>`,
    )
    .join('')}
</section>`
    : '';

  const homeWarning = !model.hasHome
    ? `<div class="refusal">A near-home rule cannot fire until you set a home location, and townCivic will not
        guess one. Add it on <a href="/my/preferences">your preferences page</a>; a rule with nowhere to measure
        from stays silent rather than firing on the whole town.</div>`
    : '';

  const body = `<div class="detail">
  <h1>Alerts</h1>
  <p>Explicit, high-confidence rules only. Each one has to be a sentence you would agree to out loud — “zoning
     within half a mile of home”, “elementary-school closures” — and each is checked against facts extracted
     from the record rather than against a guess about you. A rule that cannot be evaluated does not fire.</p>
  ${model.error ? `<div class="refusal">${escapeHtml(model.error)}</div>` : ''}
  ${homeWarning}

  <section class="agenda">
    <h2>Your rules</h2>
    ${rules}
  </section>

  ${suggested}

  <section class="agenda">
    <h2>Add a rule</h2>
    <form method="post" action="/alerts/rules" class="search" style="align-items:center;flex-wrap:wrap">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      <input type="hidden" name="action" value="add">
      <select name="kind" aria-label="Rule kind">
        <option value="near_home">Near home</option>
        <option value="impact">A civic impact</option>
        <option value="school_stage">A school stage</option>
        <option value="deadline">An approaching deadline</option>
        <option value="institution">A named institution</option>
      </select>
      <input type="text" name="label" placeholder="Name this rule" aria-label="Rule name" required>
      <input type="text" name="params" placeholder='{"channels":["land-use"],"radiusMeters":805}'
             aria-label="Rule parameters" required>
      <button type="submit">Add</button>
    </form>
    <p class="count" style="margin-top:6px">Parameters are JSON, and are validated before the rule is stored —
       a malformed rule is refused rather than saved and quietly never fired.</p>
  </section>

  <section class="agenda">
    <h2>Delivery</h2>
    <p class="count">Nothing sends mail or a push yet. What these rules do today is collect the records that
       matched, here and in your Atom feed. The honest description of an alert right now is “a filter with a
       name”, and it will stay that until there is a sender and an unsubscribe path that works without signing
       in.</p>
  </section>
</div>

${
  model.hits.length
    ? `<h2 class="count" style="margin:30px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Matched</h2>
       ${model.hits
         .map((hit) => withExplanation(eventCard(hit.row, EMPTY_FILTERS), `${hit.rule.label}: ${hit.reason}`))
         .join('\n')}`
    : model.rules.length
      ? '<p class="count" style="margin-top:24px">Nothing has matched your rules yet.</p>'
      : ''
}`;

  return layout({
    title: 'Alerts — townCivic',
    jurisdictionLabel: model.jurisdictionLabel,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    view: 'alerts',
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/* --------------------------------------------------------------- setup */

export interface SetupViewModel extends PageChrome {
  templates: ProfileTemplate[];
  proposal: Proposal | null;
  proposalId: string | null;
  preferences: Preferences;
  /** Every proposal this reader has been shown, accepted or not. */
  history: { request: string; status: string; createdAt: string }[];
  csrfToken: string;
}

function proposalTable(proposal: Proposal): string {
  if (!proposal.changes.length && !proposal.geography.length) return '';

  // Group by dimension so the preview reads the way the design writes it —
  // "Schools", then "Family services", then "Geography" — rather than as one
  // undifferentiated list of forty keys.
  const groups = new Map<string, typeof proposal.changes>();
  for (const change of proposal.changes) {
    const dimension = parseImpactKey(change.key)?.dimension ?? 'service';
    const bucket = groups.get(dimension) ?? [];
    bucket.push(change);
    groups.set(dimension, bucket);
  }

  const sections = IMPACT_DIMENSIONS.filter((dimension) => groups.has(dimension))
    .map((dimension) => {
      const rows = groups
        .get(dimension)!
        .map(
          (change) => `<tr>
      <td>${escapeHtml(change.label)}<div class="origin">${escapeHtml(change.why)}</div></td>
      <td class="from">${escapeHtml(TREATMENT_LABELS[change.from])} →</td>
      <td class="to">${escapeHtml(TREATMENT_LABELS[change.treatment])}</td>
    </tr>`,
        )
        .join('');
      return `<h4>${escapeHtml(DIMENSION_LABELS[dimension])}</h4><table>${rows}</table>`;
    })
    .join('');

  const geography = proposal.geography.length
    ? `<h4>Geography</h4><table>${proposal.geography
        .map(
          (row) => `<tr>
      <td>${escapeHtml(row.label)}<div class="origin">${escapeHtml(row.why)}</div></td>
      <td class="from">${escapeHtml(GEO_SCOPE_LABELS[row.from])} →</td>
      <td class="to">${escapeHtml(GEO_SCOPE_LABELS[row.scope])}</td>
    </tr>`,
        )
        .join('')}</table>`
    : '';

  return sections + geography;
}

export function renderSetup(model: SetupViewModel): string {
  const proposal = model.proposal;

  const questions = proposal?.questions.length
    ? `<h4>Before this is useful, one or two questions</h4>
       ${proposal.questions
         .map(
           (
             question,
           ) => `<fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0">
      <legend style="font-size:12.5px;color:var(--muted)">${escapeHtml(question.ask)}</legend>
      ${question.options
        .map(
          (option) => `<label style="display:inline-flex;gap:5px;margin:3px 12px 3px 0;font-size:13.5px">
        <input type="${question.single ? 'radio' : 'checkbox'}" name="answer:${escapeHtml(question.id)}"
               value="${escapeHtml(option.value)}"> ${escapeHtml(option.label)}</label>`,
        )
        .join('')}
      <div class="origin">${escapeHtml(question.why)}</div>
    </fieldset>`,
         )
         .join('')}`
    : '';

  const refusals = proposal?.refusals.length
    ? `<h4>Not recorded</h4>
       ${proposal.refusals
         .map(
           (refusal) => `<div class="refusal">
      You mentioned <strong>${escapeHtml(refusal.matched)}</strong>. ${escapeHtml(refusal.say)}
      <div class="origin">Blocked domain: ${escapeHtml(refusal.label)}. Nothing was stored and nothing was
         inferred from it.</div>
    </div>`,
         )
         .join('')}`
    : '';

  const preview = proposal
    ? `<div class="proposal">
  <h3>Suggested setup</h3>
  <p class="said">You said: “${escapeHtml(proposal.request)}”. Nothing below is saved yet.</p>
  ${proposal.notes.map((note) => `<p class="count">${escapeHtml(note)}</p>`).join('')}
  ${proposalTable(proposal)}
  ${
    proposal.empty
      ? '<p class="count">None of that matched a template. Pick one below, or edit your preferences directly.</p>'
      : ''
  }
  <form method="post" action="/my/setup/accept">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
    <input type="hidden" name="proposal" value="${escapeHtml(model.proposalId ?? '')}">
    ${questions}
    ${refusals}
    <div class="actions" style="margin-top:16px">
      <button type="submit" name="action" value="accept">Accept these</button>
      <button type="submit" name="action" value="decline">No thanks</button>
      <a href="/my/preferences">Edit line by line instead</a>
    </div>
  </form>
</div>`
    : '';

  const templates = model.templates
    .map(
      (template) => `<div class="template">
  <h4>${escapeHtml(template.label)}</h4>
  <p>${escapeHtml(template.description)}</p>
  <form method="post" action="/my/setup">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
    <input type="hidden" name="request" value="${escapeHtml(template.label)}">
    <button type="submit">Preview it</button>
  </form>
</div>`,
    )
    .join('');

  const body = `<div class="detail">
  <h1>Set up a profile</h1>
  <p>Describe yourself in a sentence. townCivic will show you exactly what it proposes to change and save
     nothing until you accept it — a template is a shortcut to a set of preferences you could have typed, not a
     persona it keeps about you.</p>

  <form method="post" action="/my/setup" class="search" style="align-items:center">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
    <input type="text" name="request" style="flex:1"
           placeholder="Set me up as a parent with kids in elementary school"
           aria-label="Describe what you want to follow" required>
    <button type="submit">Show me what that would do</button>
  </form>

  ${preview}

  <section class="agenda">
    <h2>Starter templates</h2>
    <p class="count">Composable, and versioned. Accepting two of them gives you the union of their preferences,
       which is more precise than either — “retiree and renter and transit rider” is a real profile in a way
       that “retiree” is not.</p>
    <div class="templates">${templates}</div>
  </section>

  ${
    model.history.length
      ? `<section class="agenda">
    <h2>What has been proposed to you</h2>
    <p class="count">Kept whether you accepted it or not, so “what did it decide about me, and when” has an
       answer — and so a suggestion you turned down is visible rather than quietly re-offered.</p>
    <ul class="blocked">${model.history
      .map(
        (entry) =>
          `<li>${escapeHtml(entry.createdAt.slice(0, 10))} · <strong>${escapeHtml(entry.status)}</strong> · “${escapeHtml(entry.request)}”</li>`,
      )
      .join('')}</ul>
  </section>`
      : ''
  }

  <section class="agenda">
    <h2>What townCivic will not work out about you</h2>
    <p class="count">These are not inferred from your words, your subscriptions, or anything you open. Mentioning
       one in the box above is acknowledged and dropped, not quietly recorded.</p>
    <ul class="blocked">
      ${BLOCKED_DOMAINS.map((domain) => `<li><strong>${escapeHtml(domain.label)}</strong></li>`).join('')}
    </ul>
    <p class="count">And these are yours to state or leave blank — nothing concludes them on your behalf:</p>
    <ul class="blocked">
      ${DECLARED_ONLY.map(
        (item) => `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.why)}</li>`,
      ).join('')}
    </ul>
  </section>
</div>`;

  return layout({
    title: 'Set up a profile — townCivic',
    jurisdictionLabel: model.jurisdictionLabel,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    view: 'for-you',
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/* --------------------------------------------------------- preferences */

export interface PreferencesViewModel extends PageChrome {
  preferences: Preferences;
  suggestions: InterestSuggestion[];
  /** Questions a template asked that the profile still has no answer to. */
  pending: { template: ProfileTemplate; question: TemplateQuestion }[];
  /** Institution names the extractor has actually seen, for the school picker. */
  knownInstitutions: string[];
  csrfToken: string;
}

function treatmentSelect(key: string, current: Treatment): string {
  const options = TREATMENTS.map(
    (treatment) =>
      `<option value="${treatment}"${treatment === current ? ' selected' : ''}>${escapeHtml(TREATMENT_LABELS[treatment])}</option>`,
  ).join('');
  return `<select name="treatment:${escapeHtml(key)}" aria-label="${escapeHtml(impactLabel(key))}">${options}</select>`;
}

export function renderPreferences(model: PreferencesViewModel): string {
  const { preferences } = model;

  const interestRows = allImpactKeys()
    .map((key) => {
      const existing = preferences.interests.find((interest) => interest.key === key);
      const dimension = parseImpactKey(key)!.dimension;
      return { key, dimension, existing };
    })
    .reduce<Map<string, string[]>>((groups, entry) => {
      const rows = groups.get(entry.dimension) ?? [];
      rows.push(`<tr>
  <td>${escapeHtml(impactLabel(entry.key))}
      ${entry.existing?.note ? `<div class="origin">${escapeHtml(entry.existing.note)}</div>` : ''}</td>
  <td class="treat">${treatmentSelect(entry.key, entry.existing?.treatment ?? 'normal')}</td>
  <td class="origin">${
    entry.existing
      ? escapeHtml(
          ORIGIN_LABELS[entry.existing.origin] +
            (entry.existing.template ? ` (${entry.existing.template})` : ''),
        )
      : ''
  }</td>
</tr>`);
      groups.set(entry.dimension, rows);
      return groups;
    }, new Map());

  const interestTables = IMPACT_DIMENSIONS.filter((dimension) => interestRows.has(dimension))
    .map(
      (
        dimension,
      ) => `<h3 style="margin:20px 0 6px;font-size:14px">${escapeHtml(DIMENSION_LABELS[dimension])}</h3>
<table class="prefs">
  <thead><tr><th>Topic</th><th>Treatment</th><th>Where it came from</th></tr></thead>
  <tbody>${interestRows.get(dimension)!.join('')}</tbody>
</table>`,
    )
    .join('');

  const geographyRows = CHANNELS.map((channel: Channel) => {
    const current = scopeFor(preferences, channel);
    const options = GEO_SCOPES.map(
      (scope) =>
        `<option value="${scope}"${scope === current ? ' selected' : ''}>${escapeHtml(GEO_SCOPE_LABELS[scope])}</option>`,
    ).join('');
    return `<tr>
  <td>${escapeHtml(CHANNEL_LABELS[channel])}</td>
  <td class="treat"><select name="scope:${escapeHtml(channel)}" aria-label="${escapeHtml(CHANNEL_LABELS[channel])} geography">${options}</select></td>
</tr>`;
  }).join('');

  const stageBoxes = SCHOOL_SCOPES.map(
    (stage) => `<label style="display:inline-flex;gap:5px;margin-right:14px;font-size:13.5px">
  <input type="checkbox" name="stage" value="${stage}"${preferences.schools.stages.includes(stage) ? ' checked' : ''}>
  ${escapeHtml(SCHOOL_SCOPE_LABELS[stage])}</label>`,
  ).join('');

  const home = preferences.home;

  // Unanswered questions come first: a row sitting at "Ask" does nothing at all,
  // so leaving the question buried under forty topic rows is the same as never
  // having asked it.
  const pending = model.pending.length
    ? `<section class="agenda">
    <h2>You have not answered these yet</h2>
    <p class="count">Rows waiting on one of these are set to <strong>Ask</strong>, which means they are
       doing nothing. Answering settles them; ignoring them leaves everything exactly as it is.</p>
    <form method="post" action="/my/questions">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      ${model.pending
        .map(
          ({
            template,
            question,
          }) => `<fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0">
        <legend style="font-size:12.5px;color:var(--muted)">${escapeHtml(question.ask)}</legend>
        ${question.options
          .map(
            (option) => `<label style="display:inline-flex;gap:5px;margin:3px 12px 3px 0;font-size:13.5px">
          <input type="${question.single ? 'radio' : 'checkbox'}" name="answer:${escapeHtml(question.id)}"
                 value="${escapeHtml(option.value)}"> ${escapeHtml(option.label)}</label>`,
          )
          .join('')}
        <div class="origin">${escapeHtml(question.why)} From the ${escapeHtml(template.label)} template.</div>
      </fieldset>`,
        )
        .join('')}
      <div class="actions"><button type="submit">Answer</button></div>
    </form>
  </section>`
    : '';

  const suggestions = model.suggestions.length
    ? `<section class="agenda">
    <h2>Because of what you follow</h2>
    <p class="count">Derived from subscriptions you created, never from what you opened. Each is a question,
       and answering it makes the row yours rather than something the system decided.</p>
    ${model.suggestions
      .map(
        (suggestion) => `<div class="subscription">
      <span>${escapeHtml(suggestion.ask)} <span class="origin">${escapeHtml(suggestion.evidence)}</span></span>
      <form method="post" action="/my/suggestions">
        <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
        <input type="hidden" name="key" value="${escapeHtml(suggestion.key)}">
        <input type="hidden" name="next" value="/my/preferences">
        <button type="submit" name="action" value="accept">Add it</button>
      </form>
    </div>`,
      )
      .join('')}
  </section>`
    : '';

  const body = `<div class="detail">
  <h1>Preferences</h1>
  <p>The whole profile, on one page. Every row here is something you or a template you accepted put there, and
     every row is removable. Nothing else feeds the ranking — there is no hidden vector, no cluster, and no
     “readers like you”.</p>
  ${model.notice ? `<p class="count" style="color:var(--accent)">${escapeHtml(model.notice)}</p>` : ''}

  ${pending}
  ${suggestions}

  <form method="post" action="/my/preferences">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">

    <section class="agenda">
      <h2>Interests</h2>
      <p class="count">${TREATMENTS.map((t) => `<strong>${escapeHtml(TREATMENT_LABELS[t])}</strong> — ${escapeHtml(TREATMENT_DESCRIPTIONS[t])}`).join('<br>')}</p>
      ${interestTables}
    </section>

    <section class="agenda">
      <h2>Geography</h2>
      <p class="count">How wide each channel is drawn. “Near home” needs a home location and is inert without
         one — an alert that fires on absent data would be worse than no alert.</p>
      <table class="prefs">
        <thead><tr><th>Channel</th><th>Scope</th></tr></thead>
        <tbody>${geographyRows}</tbody>
      </table>
    </section>

    <section class="agenda">
      <h2>Home</h2>
      <p class="count">The one genuinely sensitive thing stored here. It is used to measure distance, it is
         never sent anywhere but the geocoder, and clearing the field deletes it.</p>
      <table class="prefs">
        <tr><td>Address</td><td><input type="text" name="home" style="width:280px"
            value="${escapeHtml(home?.label ?? '')}" placeholder="39 Frothingham Street"></td></tr>
        <tr><td>“Near home” reaches</td><td><input type="number" name="radius" min="100" max="8000" step="50"
            value="${home?.radiusMeters ?? 805}"> metres <span class="origin">805 m is about half a mile, the
            radius Massachusetts zoning notice tends to use.</span></td></tr>
      </table>
    </section>

    <section class="agenda">
      <h2>Schools</h2>
      <p class="count">Stages, not children. townCivic does not record how many you have, how old they are, or
         who they are.</p>
      <p>${stageBoxes}</p>
      <p><label style="font-size:13.5px">Specific schools, comma separated<br>
        <input type="text" name="institutions" style="width:420px"
               value="${escapeHtml(preferences.schools.institutions.join(', '))}"
               placeholder="Tucker Elementary School, Pierce Middle School" list="known-institutions"></label></p>
      <datalist id="known-institutions">${model.knownInstitutions
        .map((name) => `<option value="${escapeHtml(name)}"></option>`)
        .join('')}</datalist>
    </section>

    <div class="actions"><button type="submit">Save preferences</button>
      <a href="/for-you">See what it does</a></div>
  </form>

  <section class="agenda">
    <h2>How the ranking adds up</h2>
    <p class="count">The whole weight table, because a ranking you cannot check is a ranking you have to take
       on faith. Each number below is a base; what reaches the score is that base multiplied by how much
       authority the thing that said so carries, so the same nominal strength counts for less when a template
       proposed it than when you set it yourself.</p>
    <table class="prefs">
      <thead><tr><th>Signal</th><th>Weight</th></tr></thead>
      <tbody>
        <tr><td>A matter you follow</td><td class="treat">${SCORING.FOLLOWED_MATTER}</td></tr>
        <tr><td>A school or building you named</td><td class="treat">${SCORING.INSTITUTION}</td></tr>
        <tr><td>Inside your near-home radius</td><td class="treat">${SCORING.NEAR_HOME}</td></tr>
        <tr><td>A school stage you picked</td><td class="treat">${SCORING.SCHOOL_STAGE}</td></tr>
        <tr><td>A deadline inside ${SCORING.DEADLINE_WINDOW_DAYS} days</td><td class="treat">${SCORING.DEADLINE_SOON}</td></tr>
        <tr><td>A board you follow</td><td class="treat">${SCORING.FOLLOWED_BODY}</td></tr>
        <tr><td>A channel you watch townwide</td><td class="treat">${SCORING.TOWNWIDE}</td></tr>
        <tr><td>Recent, at most</td><td class="treat">${SCORING.RECENCY_MAX}</td></tr>
        <tr><td>Readers similar to you</td><td class="treat">not collected</td></tr>
      </tbody>
    </table>
    <p class="count">Recency is deliberately small. A fresh record can reorder two equally relevant ones and can
       never push an interest you declared off the page.</p>
  </section>

  ${
    preferences.templates.length
      ? `<section class="agenda">
      <h2>Templates you accepted</h2>
      <p class="count">Kept for provenance only. Nothing reads a template name to decide what to show you — the
         rows above are the whole story, which is why editing them makes the template irrelevant.</p>
      <ul class="blocked">${preferences.templates
        .map(
          (accepted) =>
            `<li><strong>${escapeHtml(accepted.id)}</strong> · ${escapeHtml(accepted.version)} · accepted ${escapeHtml(accepted.acceptedAt.slice(0, 10))}</li>`,
        )
        .join('')}</ul>
    </section>`
      : ''
  }
</div>`;

  return layout({
    title: 'Preferences — townCivic',
    jurisdictionLabel: model.jurisdictionLabel,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    view: 'for-you',
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}
