import type { EventRow, MatterRow, SourceRow, TimelineRow } from '../db/repo.ts';
import { CHANNELS, CHANNEL_DESCRIPTIONS, CHANNEL_LABELS, EVENT_TYPE_LABELS } from '../taxonomy.ts';
import type { Channel } from '../taxonomy.ts';
import { MATTER_KIND_LABELS } from '../matters/key.ts';
import type { MatterKind } from '../matters/key.ts';
import { STAGE_LABELS, isStage } from '../matters/stages.ts';
import { dayKey, formatDate, formatDayHeading, hasRealTime, relativeDays } from '../util/dates.ts';

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The town this page is about, and the ones a reader could switch to.
 *
 * Threaded through every view instead of a bare label string, because with more
 * than one town the label is no longer the only thing the page needs: links
 * have to carry the town, and the header has to offer the others.
 */
export interface TownView {
  id: string;
  label: string;
  /**
   * Every town, for the switcher. A single entry hides the switcher *and*
   * suppresses the `town` query parameter — a one-town install keeps exactly
   * the URLs it has today, which is the point of doing it this way rather than
   * with a path prefix.
   */
  options: { id: string; label: string }[];
  /** The current path, so switching towns stays on the same kind of page. */
  path: string;
}

export const isMultiTown = (town: TownView): boolean => town.options.length > 1;

/** An internal link that stays in the current town. */
export function withTown(path: string, town: TownView, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params);
  if (isMultiTown(town)) search.set('town', town.id);
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The same page, in another town. Filters are dropped: they mean nothing there. */
function switchTownHref(path: string, id: string): string {
  return `${path}?town=${encodeURIComponent(id)}`;
}

export interface Filters {
  /** Set only when the install serves more than one town. */
  town?: string;
  channel?: string;
  source?: string;
  body?: string;
  level?: string;
  q?: string;
  /** Widen the search to model-derived readings as well as the records. */
  derived?: boolean;
  when: 'all' | 'upcoming' | 'past';
  page: number;
}

export const EMPTY_FILTERS: Filters = { when: 'all', page: 1 };

/** Build a URL for the current filters with one or more values replaced. */
export function href(filters: Filters, patch: Partial<Filters> = {}, path = '/'): string {
  const next = { ...filters, ...patch };
  const params = new URLSearchParams();
  // First, so a shared link reads as the town before it reads as the filter.
  if (next.town) params.set('town', next.town);
  if (next.channel) params.set('channel', next.channel);
  if (next.source) params.set('source', next.source);
  if (next.body) params.set('body', next.body);
  if (next.level) params.set('level', next.level);
  if (next.q) params.set('q', next.q);
  if (next.derived) params.set('derived', '1');
  if (next.when !== 'all') params.set('when', next.when);
  if (next.page > 1) params.set('page', String(next.page));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Toggle a facet: clicking the active value clears it. */
function toggle(filters: Filters, key: 'source' | 'body' | 'level', value: string): string {
  return href(filters, { [key]: filters[key] === value ? undefined : value, page: 1 });
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface Facet {
  value: string;
  n: number;
  label?: string;
}

export interface LayoutOptions {
  title: string;
  town: TownView;
  filters: Filters;
  sampleData: boolean;
  body: string;
  aside?: string;
  feedUrl?: string;
  /** Display name of the signed-in reader, when there is one. */
  account?: string | null;
}

export function layout(options: LayoutOptions): string {
  const { filters, town } = options;
  const tabs = [
    { value: '', label: 'Everything' },
    ...CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
  ]
    .map((tab) => {
      const on = (filters.channel ?? '') === tab.value;
      const url = href(filters, { channel: tab.value || undefined, page: 1 });
      return `<a class="${on ? 'on' : ''}" href="${escapeHtml(url)}">${escapeHtml(tab.label)}</a>`;
    })
    .join('');

  // The switcher is the whole multi-town UI: the same pages, a different town.
  // It deliberately drops the current filters — "Planning Board" is a different
  // board in the next town over, and a board filter that silently follows you
  // across the town line is worse than no filter at all.
  const switcher = isMultiTown(town)
    ? `<nav class="towns" aria-label="Town">${town.options
        .map(
          (option) =>
            `<a class="${option.id === town.id ? 'on' : ''}" href="${escapeHtml(
              switchTownHref(town.path, option.id),
            )}">${escapeHtml(option.label.split(',')[0] ?? option.label)}</a>`,
        )
        .join('')}<a href="${escapeHtml(withTown('/towns', town))}">All towns</a></nav>`
    : '';

  const banner = options.sampleData
    ? `<div class="banner"><strong>Sample data.</strong> Some entries below were loaded from synthetic fixtures for development
       and are <strong>not</strong> records of anything the town actually did. Run <code>npm run ingest</code> against the live
       site, then <code>npm run clear-samples</code>, to work with real records.</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="/styles.css">
${options.feedUrl ? `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(options.title)}" href="${escapeHtml(options.feedUrl)}">` : ''}
</head>
<body>
<header class="site">
  <div class="wrap">
    <div class="brand">
      <h1><a href="${escapeHtml(withTown('/', town))}">townCivic</a></h1>
      <span class="tag">${escapeHtml(town.label)} · primary-source civic record</span>
      <span class="spacer"></span>
      <span class="util"><a href="${escapeHtml(withTown('/matters', town))}">Timelines</a><a href="${escapeHtml(withTown('/map', town))}">Map</a><a href="${escapeHtml(withTown('/sources', town))}">Sources</a><a href="${escapeHtml(withTown('/feeds', town))}">Feeds</a>${
        options.account ? `<a href="/my">${escapeHtml(options.account)}</a>` : '<a href="/login">Sign in</a>'
      }</span>
    </div>
    ${switcher}
    <nav class="channels">${tabs}</nav>
  </div>
</header>
<div class="wrap">
  ${banner}
  ${options.aside ? `<div class="layout"><aside>${options.aside}</aside><main>${options.body}</main></div>` : `<main>${options.body}</main>`}
  <footer class="site">
    <p>Every entry links to the primary source. townCivic does not summarize, editorialize, or decide what is newsworthy —
       it records what was published, by whom, and when.</p>
    <p><a href="${escapeHtml(withTown('/feeds', town))}">Atom &amp; JSON feeds</a> · <a href="${escapeHtml(withTown('/sources', town))}">Source registry</a>${
      isMultiTown(town) ? ` · <a href="${escapeHtml(withTown('/towns', town))}">Towns</a>` : ''
    }</p>
  </footer>
</div>
</body>
</html>`;
}

function badge(row: EventRow): string {
  const channel = row.channel as Channel;
  return `<span class="badge ch ch-${escapeHtml(channel)}">${escapeHtml(CHANNEL_LABELS[channel] ?? channel)}</span>`;
}

function eventCard(row: EventRow, filters: Filters): string {
  const subjects = parseJsonArray(row.subjects)
    .slice(0, 4)
    .map((s) => `<span class="badge subject">${escapeHtml(s)}</span>`)
    .join('');

  const kind = EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type;
  const bodyLink = row.body
    ? `<a href="${escapeHtml(toggle(filters, 'body', row.body))}">${escapeHtml(row.body)}</a>`
    : escapeHtml(row.agency);
  const sourceLink = `<a href="${escapeHtml(toggle(filters, 'source', row.source_id))}">${escapeHtml(row.source_label ?? row.source_id)}</a>`;

  // Show a clock time only when the document actually gave us one.
  const when = row.occurred_at
    ? formatDate(row.occurred_at, hasRealTime(row.occurred_at) ? { hour: 'numeric', minute: '2-digit' } : {})
    : row.published_at
      ? `posted ${formatDate(row.published_at)}`
      : '';

  const revised =
    row.revision > 1
      ? `<span class="dot">·</span><span title="This item changed after it was first seen">revised</span>`
      : '';

  return `<article class="event p-${escapeHtml(row.priority)}">
  <h4><a href="/event/${escapeHtml(row.id)}">${escapeHtml(row.title)}</a></h4>
  ${row.summary ? `<p class="summary">${escapeHtml(row.summary)}</p>` : ''}
  <div class="meta">
    ${badge(row)}
    <span class="badge kind">${escapeHtml(kind)}</span>
    ${subjects}
    <span class="dot">·</span>${bodyLink}
    <span class="dot">·</span>${sourceLink}
    ${when ? `<span class="dot">·</span><span>${escapeHtml(when)}</span>` : ''}
    ${revised}
  </div>
</article>`;
}

function dayGroups(rows: EventRow[], filters: Filters, upcoming: boolean): string {
  const groups = new Map<string, EventRow[]>();
  for (const row of rows) {
    const key = dayKey(row.occurred_at ?? row.published_at ?? row.first_seen_at);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const days = relativeDays(`${key}T12:00:00Z`);
      const relative =
        days === 0 ? ' · today' : days === 1 ? ' · tomorrow' : days === -1 ? ' · yesterday' : '';
      return `<section class="daygroup${upcoming ? ' upcoming' : ''}">
  <h3>${escapeHtml(formatDayHeading(key))}${escapeHtml(relative)}</h3>
  ${items.map((row) => eventCard(row, filters)).join('\n')}
</section>`;
    })
    .join('\n');
}

/** A facet list capped for display, plus how many values did not fit. */
export interface FacetGroup {
  shown: Facet[];
  hidden: number;
}

export interface IndexViewModel {
  filters: Filters;
  upcoming: EventRow[];
  past: EventRow[];
  total: number;
  facets: { sources: FacetGroup; bodies: FacetGroup; levels: FacetGroup };
  sampleData: boolean;
  town: TownView;
  pageSize: number;
  feedUrl: string;
  /** Whether the interpretation stage has produced anything to search. */
  hasDerived: boolean;
  /**
   * True when this town is registered but has nothing enabled yet. Its empty
   * page then says what is actually true of it, rather than telling a reader to
   * run `ingest` against sources that do not exist.
   */
  townDormant?: boolean;
  account?: string | null;
}

function facetGroup(
  heading: string,
  key: 'source' | 'body' | 'level',
  group: FacetGroup,
  filters: Filters,
): string {
  if (!group.shown.length) return '';
  const items = group.shown
    .map((facet) => {
      const on = filters[key] === facet.value;
      return `<li><a class="${on ? 'on' : ''}" href="${escapeHtml(toggle(filters, key, facet.value))}">
        <span>${escapeHtml(facet.label ?? facet.value)}</span><span class="n">${facet.n}</span></a></li>`;
    })
    .join('');
  // Long tails are real here — Milton has 78 boards — so say what was left out
  // rather than silently truncating, and point at search for the rest.
  const more = group.hidden ? `<li class="more"><span>+ ${group.hidden} more — use search</span></li>` : '';
  return `<div class="group"><h2>${escapeHtml(heading)}</h2><ul>${items}${more}</ul></div>`;
}

export function renderIndex(model: IndexViewModel): string {
  const { filters } = model;

  // The derived-search toggle only appears once there is derived text to find,
  // so a database that has never run `interpret` shows no dead control.
  const derivedToggle = model.hasDerived
    ? `<label class="derivedtoggle">
         <input type="checkbox" name="derived" value="1"${filters.derived ? ' checked' : ''}>
         <span>Also search AI-derived readings of minutes</span>
       </label>`
    : '';

  const aside = `
<form class="search" action="/" method="get">
  <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Search records" aria-label="Search records">
  ${filters.town ? `<input type="hidden" name="town" value="${escapeHtml(filters.town)}">` : ''}
  ${filters.channel ? `<input type="hidden" name="channel" value="${escapeHtml(filters.channel)}">` : ''}
  <button type="submit">Go</button>
  ${derivedToggle}
</form>
${facetGroup('Board or department', 'body', model.facets.bodies, filters)}
${facetGroup('Source', 'source', model.facets.sources, filters)}
${facetGroup('Level of government', 'level', model.facets.levels, filters)}
${
  filters.source || filters.body || filters.level || filters.q
    ? `<div class="group"><a href="${escapeHtml(href({ ...EMPTY_FILTERS, channel: filters.channel }))}">Clear filters</a></div>`
    : ''
}`;

  const modes = (['all', 'upcoming', 'past'] as const)
    .map((mode) => {
      const label = mode === 'all' ? 'All' : mode === 'upcoming' ? 'Upcoming' : 'Past';
      const on = filters.when === mode;
      return `<a class="${on ? 'on' : ''}" href="${escapeHtml(href(filters, { when: mode, page: 1 }))}">${label}</a>`;
    })
    .join('');

  const channelNote = filters.channel
    ? `<p class="count">${escapeHtml(CHANNEL_DESCRIPTIONS[filters.channel as Channel] ?? '')}</p>`
    : '';

  const empty =
    model.upcoming.length || model.past.length
      ? ''
      : model.townDormant
        ? `<div class="empty">
             <p>Nothing has been collected for ${escapeHtml(model.town.label)} yet.</p>
             <p>It is registered — its URL shapes are written down — but no source has been confirmed
                against the live site, so nothing fetches. Run <code>npm run discover</code> for its board
                ids, then <code>npm run verify</code>, and enable what answered.</p>
           </div>`
        : `<div class="empty">
             <p>No records match these filters.</p>
             <p>If the database is empty, load the development fixtures with <code>npm run seed</code>,
                or fetch the live site with <code>npm run ingest</code>.</p>
           </div>`;

  const body = `
<div class="toolbar">
  <strong>${model.total.toLocaleString('en-US')}</strong>
  <span class="count">record${model.total === 1 ? '' : 's'}${filters.q ? ` matching “${escapeHtml(filters.q)}”` : ''}${
    filters.q && filters.derived ? ', including AI-derived readings' : ''
  }</span>
  ${channelNote}
  <span class="modes">${modes}</span>
</div>
${model.upcoming.length ? `<h2 class="count" style="margin:22px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Upcoming</h2>${dayGroups(model.upcoming, filters, true)}` : ''}
${model.past.length ? `${model.upcoming.length ? `<h2 class="count" style="margin:34px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Already happened</h2>` : ''}${dayGroups(model.past, filters, false)}` : ''}
${empty}
${
  model.past.length >= model.pageSize || filters.page > 1
    ? `<div class="pager">
        ${filters.page > 1 ? `<a href="${escapeHtml(href(filters, { page: filters.page - 1 }))}">← Newer</a>` : ''}
        ${model.past.length >= model.pageSize ? `<a href="${escapeHtml(href(filters, { page: filters.page + 1 }))}">Older →</a>` : ''}
      </div>`
    : ''
}`;

  return layout({
    title: filters.channel
      ? `${CHANNEL_LABELS[filters.channel as Channel] ?? filters.channel} — townCivic`
      : `townCivic — ${model.town.label}`,
    town: model.town,
    filters,
    sampleData: model.sampleData,
    body,
    aside,
    feedUrl: model.feedUrl,
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/** The parsed meeting notice, as stored on the attachment row. */
export interface NoticeView {
  location?: string | null;
  timeText?: string | null;
  agendaItems?: string[];
  postedAt?: string | null;
  postingAuthority?: string | null;
  remoteLink?: string | null;
  structured?: boolean;
}

export interface EventViewModel {
  row: EventRow;
  sampleData: boolean;
  town: TownView;
  notice?: NoticeView | null;
  /** The matters this record belongs to, so a reader can jump to the timeline. */
  matters?: (MatterRow & { stage: string })[];
  /** Model-derived readings of the document. Never the record itself. */
  interpretations?: InterpretationView[];
  account?: string | null;
}

export function renderEvent(model: EventViewModel): string {
  const { row, sampleData, town } = model;
  const notice = model.notice ?? null;
  const subjects = parseJsonArray(row.subjects);
  const tags = parseJsonArray(row.tags);
  const kind = EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type;

  const rows: [string, string][] = [
    ['Channel', CHANNEL_LABELS[row.channel as Channel] ?? row.channel],
    ['Record type', kind],
    ['Body', row.body ?? row.agency],
    ['Agency', row.agency],
    ['Level', row.level],
    [
      'Meets',
      formatDate(
        row.occurred_at,
        hasRealTime(row.occurred_at)
          ? { weekday: 'long', hour: 'numeric', minute: '2-digit' }
          : { weekday: 'long' },
      ) || '—',
    ],
    ...(notice?.location ? ([['Location', notice.location]] as [string, string][]) : []),
    ['Posted by clerk', formatDate(row.published_at, { hour: 'numeric', minute: '2-digit' }) || '—'],
    ...(notice?.postingAuthority
      ? ([['Posting authority', notice.postingAuthority]] as [string, string][])
      : []),
    ['First seen', formatDate(row.first_seen_at, { hour: 'numeric', minute: '2-digit' })],
    ['Last seen', formatDate(row.last_seen_at, { hour: 'numeric', minute: '2-digit' })],
    ['Revision', String(row.revision)],
    ['Source', row.source_label ?? row.source_id],
    ['Subjects', subjects.length ? subjects.join(', ') : '—'],
    ['Tags', tags.length ? tags.join(', ') : '—'],
  ];

  // The agenda is the point: it is what the meeting is actually about, and it
  // exists only inside the notice PDF.
  const agenda = notice?.agendaItems?.length
    ? `<section class="agenda">
         <h2>Agenda <span class="pill">read from the notice</span></h2>
         <ol>${notice.agendaItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
       </section>`
    : row.extracted_at
      ? `<p class="count" style="margin-top:18px">No agenda items were listed in the document.</p>`
      : `<p class="count" style="margin-top:18px">Document not read yet — run <code>npm run extract</code>.</p>`;

  // Where this record sits in a longer story. The chip carries the stage, so a
  // reader sees "continued" without opening the timeline.
  const matters = model.matters?.length
    ? `<section class="agenda">
         <h2>Part of ${model.matters.length === 1 ? 'a timeline' : 'these timelines'}</h2>
         <ul class="matterlinks">${model.matters
           .map(
             (matter) =>
               `<li><a href="/matter/${escapeHtml(matter.id)}">${escapeHtml(matter.label)}</a>
                ${stageBadge(matter.stage)}
                <span class="count">${matter.event_count} record${matter.event_count === 1 ? '' : 's'}</span></li>`,
           )
           .join('')}</ul>
       </section>`
    : '';

  const body = `<div class="detail">
  <div class="meta" style="margin-bottom:10px">${badge(row)}<span class="badge kind">${escapeHtml(kind)}</span>
    ${subjects.map((s) => `<span class="badge subject">${escapeHtml(s)}</span>`).join('')}</div>
  <h1>${escapeHtml(row.title)}</h1>
  ${row.summary ? `<p>${escapeHtml(row.summary)}</p>` : ''}
  <div class="actions">
    <a href="${escapeHtml(row.url)}" rel="noopener noreferrer">Open primary source ↗</a>
    ${row.document_url && row.document_url !== row.url ? `<a href="${escapeHtml(row.document_url)}" rel="noopener noreferrer">Open document ↗</a>` : ''}
    ${notice?.remoteLink ? `<a href="${escapeHtml(notice.remoteLink)}" rel="noopener noreferrer">Join remotely ↗</a>` : ''}
  </div>
  ${agenda}
  ${matters}
  ${renderInterpretations(model.interpretations ?? [])}
  <dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
</div>`;

  return layout({
    title: `${row.title} — townCivic`,
    town,
    filters: EMPTY_FILTERS,
    sampleData,
    body,
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/* ----------------------------------------------------- derived readings (AI) */

export interface InterpretationView {
  kind: string;
  provider: string;
  model: string | null;
  text: string;
  data: unknown;
  created_at: string;
}

/**
 * Model-derived readings, kept visually and structurally apart from the record.
 *
 * The rule the whole project runs on is that the document is the authority and
 * anything derived is an index over it. So this renders in its own block, says
 * which provider produced it, and never replaces the record's own summary.
 */
function renderInterpretations(items: InterpretationView[]): string {
  if (!items.length) return '';

  const blocks = items
    .map(
      (item) => `<div class="derived-item">
  <div class="meta">
    <span class="badge kind">${escapeHtml(item.kind)}</span>
    <span class="dot">·</span><span>${escapeHtml(item.provider)}${item.model ? ` / ${escapeHtml(item.model)}` : ''}</span>
    <span class="dot">·</span><span>${escapeHtml(formatDate(item.created_at))}</span>
  </div>
  <p>${escapeHtml(item.text)}</p>
</div>`,
    )
    .join('');

  return `<section class="derived">
  <h2>Derived reading <span class="pill warn">not the record</span></h2>
  <p class="count">Produced by an indexer reading the stored document, so that prose the parsers cannot
     structure is still searchable. It can be wrong. The primary source above is what the town published.</p>
  ${blocks}
</section>`;
}

/* ---------------------------------------------------------------- timelines */

function stageBadge(stage: string): string {
  const label = isStage(stage) ? STAGE_LABELS[stage] : stage;
  return `<span class="badge stage stage-${escapeHtml(stage)}">${escapeHtml(label)}</span>`;
}

function matterCard(matter: MatterRow): string {
  const bodies = parseJsonArray(matter.bodies);
  const span =
    matter.first_at && matter.last_at && matter.first_at !== matter.last_at
      ? `${formatDate(matter.first_at)} → ${formatDate(matter.last_at)}`
      : formatDate(matter.last_at ?? matter.first_at);

  return `<article class="event matter">
  <h4><a href="/matter/${escapeHtml(matter.id)}">${escapeHtml(matter.label)}</a></h4>
  <div class="meta">
    <span class="badge kind">${escapeHtml(MATTER_KIND_LABELS[matter.kind as MatterKind] ?? matter.kind)}</span>
    ${matter.status ? stageBadge(matter.status) : ''}
    <span class="dot">·</span><span>${matter.event_count} record${matter.event_count === 1 ? '' : 's'}</span>
    ${span ? `<span class="dot">·</span><span>${escapeHtml(span)}</span>` : ''}
    ${bodies.length ? `<span class="dot">·</span><span>${escapeHtml(bodies.join(', '))}</span>` : ''}
  </div>
</article>`;
}

export interface MattersViewModel {
  matters: MatterRow[];
  total: number;
  kinds: { value: string; n: number }[];
  kind?: string;
  q?: string;
  /** Whether single-record matters are being shown. */
  includeSingletons: boolean;
  linked: boolean;
  sampleData: boolean;
  town: TownView;
  account?: string | null;
}

export function renderMatters(model: MattersViewModel): string {
  const params = (patch: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const merged = {
      town: isMultiTown(model.town) ? model.town.id : undefined,
      kind: model.kind,
      q: model.q,
      all: model.includeSingletons ? '1' : undefined,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged)) if (value) search.set(key, value);
    const qs = search.toString();
    return qs ? `/matters?${qs}` : '/matters';
  };

  const kindTabs = [{ value: '', n: model.total }, ...model.kinds]
    .map((entry) => {
      const on = (model.kind ?? '') === entry.value;
      const label = entry.value
        ? (MATTER_KIND_LABELS[entry.value as MatterKind] ?? entry.value)
        : 'All matters';
      return `<a class="${on ? 'on' : ''}" href="${escapeHtml(params({ kind: entry.value || undefined }))}">${escapeHtml(label)}</a>`;
    })
    .join('');

  const empty = !model.linked
    ? `<div class="empty"><p>Nothing has been linked yet.</p>
         <p>Run <code>npm run link</code> to group records into matters. It reads only what is already
            in the database — no network, no re-fetching.</p></div>`
    : !model.matters.length
      ? `<div class="empty"><p>No matters match.</p>
           ${model.includeSingletons ? '' : '<p>Only matters with more than one record are shown by default.</p>'}</div>`
      : '';

  const body = `<div class="detail" style="margin-bottom:6px">
  <h1>Timelines</h1>
  <p>A <em>matter</em> is the thing the town is deciding about — a property, a warrant article, a procurement —
     as opposed to any one meeting about it. The town publishes no case number, so these are grouped by
     normalizing the subject the extractor read out of the notice. Every entry links back to the record it
     came from, and the phrase each stage was read from is shown on the timeline.</p>
</div>
<div class="toolbar">
  <strong>${model.total.toLocaleString('en-US')}</strong>
  <span class="count">matter${model.total === 1 ? '' : 's'}</span>
  <span class="modes">${kindTabs}</span>
</div>
<form class="search" action="/matters" method="get" style="margin:14px 0">
  <input type="search" name="q" value="${escapeHtml(model.q ?? '')}" placeholder="Find an address or article" aria-label="Find a matter">
  ${isMultiTown(model.town) ? `<input type="hidden" name="town" value="${escapeHtml(model.town.id)}">` : ''}
  ${model.kind ? `<input type="hidden" name="kind" value="${escapeHtml(model.kind)}">` : ''}
  ${model.includeSingletons ? '<input type="hidden" name="all" value="1">' : ''}
  <button type="submit">Go</button>
</form>
<p class="count"><a href="${escapeHtml(params({ all: model.includeSingletons ? undefined : '1' }))}">${
    model.includeSingletons ? 'Hide matters with only one record' : 'Show matters with only one record too'
  }</a></p>
${model.matters.map(matterCard).join('\n')}
${empty}`;

  return layout({
    title: 'Timelines — townCivic',
    town: model.town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

export interface MatterViewModel {
  matter: MatterRow;
  timeline: TimelineRow[];
  place?: { lat: number; lon: number; matched: string | null } | null;
  watched?: boolean;
  signedIn?: boolean;
  csrfToken?: string;
  sampleData: boolean;
  town: TownView;
  account?: string | null;
}

export function renderMatter(model: MatterViewModel): string {
  const { matter } = model;
  const bodies = parseJsonArray(matter.bodies);

  const steps = model.timeline
    .map((row) => {
      const when = row.occurred_at ?? row.published_at ?? row.first_seen_at;
      const kind = EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type;
      return `<li class="step step-${escapeHtml(row.stage)}">
  <div class="when">${escapeHtml(formatDate(when))}</div>
  <div class="what">
    ${stageBadge(row.stage)}
    <a href="/event/${escapeHtml(row.id)}">${escapeHtml(row.title)}</a>
    <div class="meta">
      <span class="badge kind">${escapeHtml(kind)}</span>
      ${row.body ? `<span class="dot">·</span><span>${escapeHtml(row.body)}</span>` : ''}
      <span class="dot">·</span><span>${escapeHtml(row.source_label ?? row.source_id)}</span>
    </div>
    ${row.evidence ? `<blockquote class="evidence">${escapeHtml(row.evidence)}</blockquote>` : ''}
  </div>
</li>`;
    })
    .join('\n');

  const watch = model.signedIn
    ? `<form method="post" action="/my/watch" class="inline">
         <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken ?? '')}">
         <input type="hidden" name="matter" value="${escapeHtml(matter.id)}">
         <input type="hidden" name="action" value="${model.watched ? 'unwatch' : 'watch'}">
         <button type="submit">${model.watched ? 'Stop watching' : 'Watch this matter'}</button>
       </form>`
    : `<a href="/login?next=${encodeURIComponent(`/matter/${matter.id}`)}">Sign in to watch this</a>`;

  const body = `<div class="detail">
  <div class="meta" style="margin-bottom:10px">
    <span class="badge kind">${escapeHtml(MATTER_KIND_LABELS[matter.kind as MatterKind] ?? matter.kind)}</span>
    ${matter.status ? stageBadge(matter.status) : ''}
  </div>
  <h1>${escapeHtml(matter.label)}</h1>
  <p class="count">${matter.event_count} record${matter.event_count === 1 ? '' : 's'}${
    bodies.length ? ` · ${escapeHtml(bodies.join(', '))}` : ''
  }${matter.first_at ? ` · first seen ${escapeHtml(formatDate(matter.first_at))}` : ''}</p>
  <div class="actions">
    ${watch}
    <a href="${escapeHtml(withTown('/', model.town, { q: matter.label }))}">Search records for this</a>
    ${model.place ? `<a href="${escapeHtml(withTown('/map', model.town, { matter: matter.id }))}">Show on the map</a>` : ''}
  </div>
  ${
    matter.event_count === 1
      ? `<p class="count" style="margin-top:16px">Only one record mentions this so far, so there is no sequence
           to show yet. It will grow as the town publishes more.</p>`
      : ''
  }
  <ol class="timeline">${steps}</ol>
  <p class="count" style="margin-top:20px">Stages are read from the words in the record — the quoted phrase under each
     step is the evidence. Nothing here is a legal determination; the linked primary source is.</p>
</div>`;

  return layout({
    title: `${matter.label} — townCivic`,
    town: model.town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}

/* ----------------------------------------------------------------- accounts */

export interface AuthViewModel {
  mode: 'login' | 'signup';
  error?: string | undefined;
  email?: string | undefined;
  next?: string | undefined;
  sampleData: boolean;
  town: TownView;
}

export function renderAuth(model: AuthViewModel): string {
  const signup = model.mode === 'signup';
  const action = signup ? '/signup' : '/login';

  const body = `<div class="detail authform">
  <h1>${signup ? 'Create an account' : 'Sign in'}</h1>
  <p class="count">An account exists for one reason: to keep a list of what you want to be told about —
     a property, a board, a search — so the feed can be yours rather than the whole town's.</p>
  ${model.error ? `<p class="formerror">${escapeHtml(model.error)}</p>` : ''}
  <form method="post" action="${action}">
    ${model.next ? `<input type="hidden" name="next" value="${escapeHtml(model.next)}">` : ''}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(model.email ?? '')}">
    ${
      signup
        ? `<label for="name">Display name <span class="count">(optional)</span></label>
           <input id="name" name="displayName" type="text" autocomplete="nickname">`
        : ''
    }
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required
           autocomplete="${signup ? 'new-password' : 'current-password'}"
           ${signup ? 'minlength="10"' : ''}>
    ${signup ? '<p class="count" style="margin:6px 0 0">At least 10 characters.</p>' : ''}
    <button type="submit">${signup ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="count" style="margin-top:20px">
    ${
      signup
        ? 'Already have one? <a href="/login">Sign in</a>.'
        : 'No account yet? <a href="/signup">Create one</a>.'
    }
  </p>
  <p class="count" style="margin-top:16px">This is a proof of concept. There is no email verification and no
     password reset — if you lose the password, the account is gone. Do not reuse a password you care about.</p>
</div>`;

  return layout({
    title: `${signup ? 'Create an account' : 'Sign in'} — townCivic`,
    town: model.town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
  });
}

export interface ProfileSubscription {
  kind: string;
  value: string;
  label: string;
  alerts: string;
  /** The town it was followed in, or `*` for every town. */
  jurisdiction: string;
  /** How that town says its name. */
  townLabel: string;
}

export interface ProfileViewModel {
  email: string;
  displayName: string | null;
  subscriptions: ProfileSubscription[];
  recent: EventRow[];
  bodies: Facet[];
  feedUrl: string;
  csrfToken: string;
  notice?: string | undefined;
  sampleData: boolean;
  town: TownView;
  account: string;
}

const SUBSCRIPTION_KIND_LABELS: Record<string, string> = {
  matter: 'Timeline',
  body: 'Board or department',
  channel: 'Channel',
  search: 'Search',
};

export function renderProfile(model: ProfileViewModel): string {
  const rows = model.subscriptions
    .map(
      (subscription) => `<div class="subscription">
  <span>
    <span class="badge kind">${escapeHtml(SUBSCRIPTION_KIND_LABELS[subscription.kind] ?? subscription.kind)}</span>
    ${
      subscription.kind === 'matter'
        ? `<a href="/matter/${escapeHtml(subscription.value)}">${escapeHtml(subscription.label)}</a>`
        : escapeHtml(subscription.label)
    }
    <span class="badge subject">${escapeHtml(subscription.townLabel)}</span>
  </span>
  <form method="post" action="/my/unsubscribe">
    <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
    <input type="hidden" name="kind" value="${escapeHtml(subscription.kind)}">
    <input type="hidden" name="value" value="${escapeHtml(subscription.value)}">
    <input type="hidden" name="town" value="${escapeHtml(subscription.jurisdiction)}">
    <button type="submit">Remove</button>
  </form>
</div>`,
    )
    .join('');

  const bodyOptions = model.bodies
    .map((facet) => `<option value="${escapeHtml(facet.value)}">${escapeHtml(facet.value)}</option>`)
    .join('');

  const channelOptions = CHANNELS.map(
    (channel) => `<option value="${escapeHtml(channel)}">${escapeHtml(CHANNEL_LABELS[channel])}</option>`,
  ).join('');

  const body = `<div class="detail">
  <h1>${escapeHtml(model.displayName || model.email)}</h1>
  <p class="count">${escapeHtml(model.email)}</p>
  ${model.notice ? `<p class="count" style="color:var(--accent)">${escapeHtml(model.notice)}</p>` : ''}
  <div class="actions">
    <a href="${escapeHtml(model.feedUrl)}">Your feed (Atom)</a>
    <form method="post" action="/logout" class="inline">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      <button type="submit">Sign out</button>
    </form>
  </div>
  <p class="count" style="margin-top:10px">That feed URL contains a token that stands in for your password.
     Treat it as a secret; anyone with it can read your feed.</p>

  <section class="agenda">
    <h2>Following</h2>
    ${rows || '<p class="count">Nothing yet. Add something below, or press “Watch this matter” on any timeline.</p>'}
  </section>

  <section class="agenda">
    <h2>Follow something</h2>
    <form method="post" action="/my/subscribe" class="search" style="align-items:center">
      <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
      <input type="hidden" name="town" value="${escapeHtml(model.town.id)}">
      <select name="kind" aria-label="What to follow">
        <option value="body">A board or department</option>
        <option value="channel">A channel</option>
        <option value="search">A search</option>
      </select>
      <input type="text" name="value" placeholder="Name, channel or search terms" aria-label="What to follow" required
             list="follow-options">
      <datalist id="follow-options">${bodyOptions}${channelOptions}</datalist>
      <button type="submit">Follow</button>
    </form>
    <p class="count" style="margin-top:4px">For a channel, use its id — ${CHANNELS.slice(0, 4)
      .map((c) => `<code>${escapeHtml(c)}</code>`)
      .join(', ')} and so on. Whatever you follow is followed
      <strong>in ${escapeHtml(model.town.label)}</strong>: a board's name means a different board in
      each town, so switch towns first to follow one there.</p>
  </section>

  <section class="agenda">
    <h2>Alerts</h2>
    <p class="count">Not built. Subscriptions are recorded and the feed is live, but nothing sends mail or a
       push yet — so the honest description of alerts today is “an Atom feed you can point anything at”.
       The database column that would carry a digest preference exists; the sender does not.</p>
  </section>
</div>

${
  model.recent.length
    ? `<h2 class="count" style="margin:30px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.07em;">Latest in your feed</h2>
       ${model.recent.map((row) => eventCard(row, EMPTY_FILTERS)).join('\n')}`
    : ''
}`;

  return layout({
    title: 'Your feed — townCivic',
    town: model.town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    account: model.account,
  });
}

export function renderSources(sources: SourceRow[], sampleData: boolean, town: TownView): string {
  const rows = sources
    .map(
      (source) => `<tr>
  <td><strong>${escapeHtml(source.label)}</strong><br><span class="badge kind">${escapeHtml(source.adapter)}</span> <span class="pill">tier ${source.tier}</span></td>
  <td class="url"><a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${escapeHtml(source.url)}</a></td>
  <td>${escapeHtml(CHANNEL_LABELS[source.channel as Channel] ?? source.channel)}</td>
  <td><span class="pill ${source.confidence === 'verified' ? 'ok' : ''}">${escapeHtml(source.confidence)}</span>
      ${source.enabled ? '' : '<span class="pill off">disabled</span>'}</td>
  <td>${source.last_fetch_at ? `${escapeHtml(formatDate(source.last_fetch_at, { hour: 'numeric', minute: '2-digit' }))}${source.last_status ? ` · ${source.last_status}` : ''}` : 'never'}
      ${source.last_error ? `<br><span style="color:#a1483f">${escapeHtml(source.last_error)}</span>` : ''}</td>
</tr>`,
    )
    .join('');

  const body = `<div class="detail">
  <h1>Source registry</h1>
  <p>Every record in townCivic comes from one of these. <em>Confidence</em> says whether the URL has been confirmed
     against the live site — run <code>npm run verify</code> to check them all, and <code>npm run discover</code>
     to find boards and feeds the registry does not know about yet.</p>
  <table class="sources">
    <thead><tr><th>Source</th><th>URL</th><th>Default channel</th><th>Status</th><th>Last fetch</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

  return layout({
    title: 'Sources — townCivic',
    town,
    filters: EMPTY_FILTERS,
    sampleData,
    body,
  });
}

export function renderFeedIndex(sampleData: boolean, town: TownView, baseUrl: string): string {
  const items = [
    { value: 'all', label: 'Everything' },
    ...CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
  ]
    .map(
      (entry) => `<tr>
      <td><strong>${escapeHtml(entry.label)}</strong><br><span class="count" style="font-size:12.5px;color:var(--muted)">${escapeHtml(
        entry.value === 'all'
          ? 'Every channel except routine administration.'
          : CHANNEL_DESCRIPTIONS[entry.value as Channel],
      )}</span></td>
      <td class="url"><a href="${escapeHtml(withTown(`/feeds/${entry.value}.atom`, town))}">${escapeHtml(baseUrl)}${escapeHtml(withTown(`/feeds/${entry.value}.atom`, town))}</a></td>
      <td class="url"><a href="${escapeHtml(withTown(`/feeds/${entry.value}.json`, town))}">JSON Feed</a></td>
    </tr>`,
    )
    .join('');

  const body = `<div class="detail">
  <h1>Feeds</h1>
  <p>Atom and JSON Feed for each channel. Add <code>?source=</code>, <code>?body=</code> or <code>?q=</code> to any feed
     URL to narrow it the same way the web filters do.</p>
  ${
    isMultiTown(town)
      ? `<p class="count">These are ${escapeHtml(town.label)}'s feeds. Every feed is one town: add
           <code>?town=&lt;id&gt;</code> for another, and a feed URL without one is always the default town —
           a subscription should never quietly change which town it is about.</p>`
      : ''
  }
  <table class="sources">
    <thead><tr><th>Channel</th><th>Atom</th><th>JSON</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
</div>`;

  return layout({
    title: 'Feeds — townCivic',
    town,
    filters: EMPTY_FILTERS,
    sampleData,
    body,
  });
}

/* -------------------------------------------------------------------- towns */

export interface TownsViewModel {
  town: TownView;
  towns: {
    id: string;
    label: string;
    events: number;
    matters: number;
    sources: number;
    enabledSources: number;
    lastFetchAt: string | null;
    registered: boolean;
    boundary: boolean;
    notes: string | null;
  }[];
  sampleData: boolean;
  account?: string | null;
}

/**
 * Every town this install carries, and how real each one is.
 *
 * The numbers are the point. A town in the registry with no enabled sources has
 * been *written down*, not ingested, and saying so plainly here is what keeps
 * the switcher from implying coverage that does not exist.
 */
export function renderTowns(model: TownsViewModel): string {
  const rows = model.towns
    .map((town) => {
      const state = !town.registered
        ? '<span class="pill off">not in the registry</span>'
        : town.enabledSources === 0
          ? '<span class="pill off">registered, nothing enabled</span>'
          : town.events === 0
            ? '<span class="pill">enabled, never ingested</span>'
            : '<span class="pill ok">live</span>';

      return `<tr>
  <td><strong><a href="${escapeHtml(switchTownHref('/', town.id))}">${escapeHtml(town.label)}</a></strong>
      <br><span class="count">${escapeHtml(town.id)}</span>
      ${town.notes ? `<br><span class="count">${escapeHtml(town.notes)}</span>` : ''}</td>
  <td>${state}</td>
  <td>${town.events.toLocaleString('en-US')}</td>
  <td>${town.matters.toLocaleString('en-US')}</td>
  <td>${town.enabledSources} of ${town.sources}</td>
  <td>${town.boundary ? 'yes' : '<span class="count">no outline</span>'}</td>
  <td>${town.lastFetchAt ? escapeHtml(formatDate(town.lastFetchAt)) : '<span class="count">never</span>'}</td>
</tr>`;
    })
    .join('');

  const body = `<div class="detail">
  <h1>Towns</h1>
  <p>One database, one schema, one row per town. Everything else — the channels, the timelines, the map, the
     feeds — works the same way in each of them, which is the reason a new town is a registry file rather than
     a deployment.</p>
  <table class="sources">
    <thead><tr><th>Town</th><th>State</th><th>Records</th><th>Matters</th><th>Sources on</th><th>Outline</th><th>Last fetch</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="count" style="margin-top:14px">A town listed as <em>registered, nothing enabled</em> has its URL shapes
     written down but nothing confirmed against the live site. Run <code>npm run discover</code> for its board ids and
     <code>npm run verify</code> before enabling anything — an unverified claim does not get to make requests.</p>
</div>`;

  return layout({
    title: 'Towns — townCivic',
    town: model.town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    body,
    ...(model.account !== undefined ? { account: model.account } : {}),
  });
}
