import type { EventRow, SearchEvidence } from '../db/repo.ts';
import { EVENT_TYPE_LABELS } from '../taxonomy.ts';
import { transcriptFromRaw } from '../transcripts.ts';
import { formatDate, dayKey, formatDayHeading } from '../util/dates.ts';
import { escapeHtml as esc, layout, EMPTY_FILTERS, withTown } from './views.ts';
import type { TownView, Facet } from './views.ts';

export const MEETING_TYPES = [
  'meeting_transcript',
  'meeting_notice',
  'meeting_agenda',
  'meeting_minutes',
  'hearing_scheduled',
];
export interface MeetingFilters {
  q: string;
  body: string;
  kind: 'transcripts' | 'all';
  when: 'all' | 'past' | 'upcoming';
  page: number;
}
export interface MeetingsModel {
  town: TownView;
  filters: MeetingFilters;
  rows: EventRow[];
  total: number;
  boards: Facet[];
  evidence: Record<string, SearchEvidence>;
  pageSize: number;
  sampleData: boolean;
  account: string | null;
  locationPrompt: string;
}

export function renderMeetings(model: MeetingsModel): string {
  const { town, filters } = model;
  const link = (patch: Partial<MeetingFilters> = {}) => {
    const next = { ...filters, ...patch };
    return withTown('/meetings', town, {
      ...(next.q ? { q: next.q } : {}),
      ...(next.body ? { body: next.body } : {}),
      ...(next.kind === 'all' ? { kind: 'all' } : {}),
      ...(next.when !== 'all' ? { when: next.when } : {}),
      ...(next.page > 1 ? { page: String(next.page) } : {}),
    });
  };
  const groups = new Map<string, EventRow[]>();
  for (const row of model.rows) {
    const key = dayKey(row.occurred_at ?? row.published_at ?? row.first_seen_at);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const cards = [...groups]
    .map(
      ([day, rows]) =>
        `<section class="daygroup"><h2>${esc(formatDayHeading(day))}</h2>${rows
          .map((row) => {
            const transcript = row.event_type === 'meeting_transcript' ? transcriptFromRaw(row.raw) : null;
            const evidence = model.evidence[row.id];
            const excerpt = evidence
              ? evidence.text
                  .split(/(\[\[|\]\])/)
                  .map((part) => (part === '[[' ? '<mark>' : part === ']]' ? '</mark>' : esc(part)))
                  .join('')
              : transcript?.segments[0]
                ? esc(transcript.segments[0].text.slice(0, 260)) +
                  (transcript.segments[0].text.length > 260 ? '…' : '')
                : '';
            return `<article class="event meeting-card">
      <div class="meeting-meta"><span>${esc(row.body ?? row.agency)}</span><span class="badge ${transcript ? 'transcript-badge' : 'kind'}">${esc(EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type)}</span></div>
      <h3><a href="/event/${esc(row.id)}">${esc(row.title)}</a></h3>
      ${excerpt ? `<p class="${evidence ? 'search-evidence' : 'transcript-excerpt'}">${evidence ? '<span>Matching passage</span>' : ''}${excerpt}</p>` : ''}
      <div class="meeting-links"><a href="/event/${esc(row.id)}">${transcript ? 'Read transcript' : 'Open record'} →</a><span>${esc(row.source_label ?? row.agency)}${!row.occurred_at ? ` · posted ${esc(formatDate(row.published_at ?? row.first_seen_at))}` : ''}</span></div>
    </article>`;
          })
          .join('')}</section>`,
    )
    .join('');
  const empty = `<div class="empty"><p>${filters.q || filters.body || filters.when !== 'all' ? 'No meetings match these filters.' : filters.kind === 'transcripts' ? `No transcripts have been collected for ${esc(town.label)} yet.` : 'No meeting records have been collected yet.'}</p>
    <p>${filters.q || filters.body ? `<a href="${esc(withTown('/meetings', town))}">Clear search and filters</a> · ` : ''}<a href="${esc(link({ kind: 'all', page: 1 }))}">Browse all meeting records</a> · <a href="${esc(withTown('/activity', town))}">Open general feed</a></p>
    ${town.id !== 'milton-ma' && town.options.some((t) => t.id === 'milton-ma') ? '<p><a href="/meetings?town=milton-ma">Explore Milton transcripts</a></p>' : ''}</div>`;
  return layout({
    title: `Meetings — ${town.label} — townCivic`,
    town,
    filters: EMPTY_FILTERS,
    sampleData: model.sampleData,
    account: model.account,
    locationPrompt: model.locationPrompt,
    activeView: 'meetings',
    body: `<section class="view-intro"><h1>What’s being discussed?</h1><p>Search local meetings for the issues you care about.</p></section>
      <form class="browse-search" method="get" action="/meetings">
        <input type="hidden" name="town" value="${esc(town.id)}">
        <div class="search-line"><label class="sr-only" for="meeting-search">Search meeting text</label><input id="meeting-search" type="search" name="q" value="${esc(filters.q)}" placeholder="Search housing, school budgets, road safety…"><button type="submit">Search</button></div>
        <div class="meeting-filters">
          <label>Show<select name="kind"><option value="transcripts"${filters.kind === 'transcripts' ? ' selected' : ''}>Transcripts</option><option value="all"${filters.kind === 'all' ? ' selected' : ''}>All meeting records</option></select></label>
          <label>Board<select name="body"><option value="">All boards</option>${filters.body && !model.boards.some((b) => b.value === filters.body) ? `<option selected value="${esc(filters.body)}">${esc(filters.body)}</option>` : ''}${model.boards.map((b) => `<option value="${esc(b.value)}"${filters.body === b.value ? ' selected' : ''}>${esc(b.value)}</option>`).join('')}</select></label>
          <label>When<select name="when">${['all', 'past', 'upcoming'].map((when) => `<option value="${when}"${filters.when === when ? ' selected' : ''}>${when === 'all' ? 'Any time' : when === 'past' ? 'Past' : 'Upcoming'}</option>`).join('')}</select></label>
          <button type="submit">Apply</button>
        </div>
      </form>
      <div class="toolbar"><span class="count"><strong>${model.total.toLocaleString('en-US')}</strong> ${filters.kind === 'transcripts' ? 'transcript' : 'record'}${model.total === 1 ? '' : 's'}${filters.q ? ` matching “${esc(filters.q)}”` : ''} · ${filters.when === 'upcoming' ? 'soonest first' : 'newest first'}</span><a href="${esc(withTown('/matters', town))}">Explore issue timelines →</a></div>
      ${cards || empty}
      ${model.total > model.pageSize || filters.page > 1 ? `<nav class="pager" aria-label="Meeting pages">${filters.page > 1 ? `<a href="${esc(link({ page: filters.page - 1 }))}">← Previous</a>` : ''}<span>Page ${filters.page}</span>${filters.page * model.pageSize < model.total ? `<a href="${esc(link({ page: filters.page + 1 }))}">Next →</a>` : ''}</nav>` : ''}
      <p class="coverage-note">${town.id === 'milton-ma' ? 'Milton transcripts are automatic captions published by Milton Access TV; wording and speaker labels may contain errors.' : 'Transcript availability varies by town.'} These are the records collected so far, not a complete account of every meeting.</p>`,
  });
}
