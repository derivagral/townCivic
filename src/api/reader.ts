import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type {
  Catalog,
  EventSummary,
  EventDetail,
  EventPage,
  MatterSummary,
  MatterDetail,
  Page,
  Session,
  Following,
  LoginResponse,
} from '../../packages/api-contracts/src/index.ts';
import type { Db } from '../db/index.ts';
import {
  countEvents,
  countMatters,
  facetCounts,
  getEvent,
  getMatter,
  listMatters,
  mattersForEvent,
  matterTimeline,
  queryEvents,
  searchEvidenceForEvents,
  type EventRow,
  type MatterRow,
} from '../db/repo.ts';
import { AccountsUnavailableError, readerName, type AccountStore, type Identity } from '../accounts/index.ts';
import { hasSampleData } from '../commands/seed.ts';
import { readMeetings } from '../read-models/meetings.ts';
import { EVENT_TYPE_LABELS } from '../taxonomy.ts';
import { transcriptFromRaw, transcriptVideoUrl } from '../transcripts.ts';

const PAGE_SIZE = 30;
const querySchema = z.object({
  town: z.string().optional(),
  q: z.string().trim().max(300).default(''),
  body: z.string().trim().max(200).default(''),
  view: z.enum(['transcripts', 'meetings', 'activity']).default('transcripts'),
  when: z.enum(['all', 'past', 'upcoming']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024),
});

function summary(row: EventRow, passage?: string): EventSummary {
  return {
    id: row.id,
    town: row.jurisdiction,
    title: row.title,
    body: row.body ?? row.agency,
    type: row.event_type,
    typeLabel: EVENT_TYPE_LABELS[row.event_type as keyof typeof EVENT_TYPE_LABELS] ?? row.event_type,
    date: row.occurred_at ?? row.published_at ?? row.first_seen_at,
    source: row.source_label ?? row.agency,
    excerpt:
      passage?.replace(/\[\[|\]\]/g, '') ?? row.summary?.slice(0, 300) ?? row.doc_text?.slice(0, 300) ?? null,
    matchingPassage: passage !== undefined,
    url: row.url,
  };
}
function matterSummary(row: MatterRow): MatterSummary {
  return {
    id: row.id,
    town: row.jurisdiction,
    label: row.label,
    kind: row.kind,
    status: row.status,
    eventCount: row.event_count,
    lastAt: row.last_at,
  };
}

/** Explicit DTOs keep publisher raw blobs, storage paths and account credentials out of public JSON. */
export function readerApi(db: Db, accounts: AccountStore, catalog: Catalog) {
  const api = new Hono<{ Variables: { identity: Identity } }>();
  api.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof AccountsUnavailableError
            ? 'Accounts are temporarily unavailable. Please try again.'
            : 'Unable to complete this request. Please try again.',
      },
      error instanceof AccountsUnavailableError ? 503 : 500,
    ),
  );
  api.notFound((c) => c.json({ error: 'Not found' }, 404));
  // Public clients may call the API; no cookie credentials are accepted. This
  // also permits Expo's browser preview without weakening web-form CSRF checks.
  api.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['x-towncivic-session'],
      credentials: false,
    }),
  );
  api.use('*', bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request too large' }, 413) }));
  api.get('/catalog', (c) => c.json(catalog));

  api.get('/events', (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid search filters' }, 400);
    const filters = parsed.data;
    const town = filters.town ?? catalog.defaultTown;
    if (!catalog.towns.some((t) => t.id === town)) return c.json({ error: 'Unknown town' }, 400);
    const model =
      filters.view !== 'activity'
        ? readMeetings(
            db,
            town,
            { ...filters, kind: filters.view === 'transcripts' ? 'transcripts' : 'all' },
            PAGE_SIZE,
          )
        : (() => {
            const base = { jurisdiction: town, q: filters.q, when: filters.when };
            const query = { ...base, ...(filters.body ? { bodies: [filters.body] } : {}) };
            const rows = queryEvents(db, {
              ...query,
              limit: PAGE_SIZE,
              offset: (filters.page - 1) * PAGE_SIZE,
            });
            return {
              rows,
              total: countEvents(db, query),
              boards: facetCounts(db, 'body', base),
              evidence: Object.fromEntries(
                searchEvidenceForEvents(
                  db,
                  rows.map((r) => r.id),
                  filters.q,
                ).map((e) => [e.eventId, e]),
              ),
            };
          })();
    const result: EventPage = {
      items: model.rows.map((r) => summary(r, model.evidence[r.id]?.text)),
      total: model.total,
      page: filters.page,
      pageSize: PAGE_SIZE,
      nextPage: filters.page * PAGE_SIZE < model.total ? filters.page + 1 : null,
      sampleData: hasSampleData(db, town),
      boards: model.boards,
    };
    return c.json(result);
  });

  api.get('/events/:id', (c) => {
    const row = getEvent(db, c.req.param('id'));
    if (!row || !catalog.towns.some((t) => t.id === row.jurisdiction))
      return c.json({ error: 'Record not found' }, 404);
    const transcript = row.event_type === 'meeting_transcript' ? transcriptFromRaw(row.raw) : null;
    const result: EventDetail = {
      ...summary(row),
      sampleData: hasSampleData(db, row.jurisdiction),
      summary: row.summary,
      documentUrl: row.document_url,
      text: transcript ? null : row.doc_text,
      transcript: transcript
        ? {
            origin: transcript.origin,
            videoUrl: transcriptVideoUrl(transcript.videoId),
            segments: transcript.segments,
          }
        : null,
      matters: mattersForEvent(db, row.id).map(matterSummary),
    };
    return c.json(result);
  });

  api.get('/matters', (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid search filters' }, 400);
    const { q, page } = parsed.data;
    const town = parsed.data.town ?? catalog.defaultTown;
    if (!catalog.towns.some((t) => t.id === town)) return c.json({ error: 'Unknown town' }, 400);
    const query = { jurisdiction: town, q, minEvents: 2 };
    const total = countMatters(db, query);
    const result: Page<MatterSummary> = {
      items: listMatters(db, {
        ...query,
        order: 'recent',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }).map(matterSummary),
      total,
      page,
      pageSize: PAGE_SIZE,
      nextPage: page * PAGE_SIZE < total ? page + 1 : null,
      sampleData: hasSampleData(db, town),
    };
    return c.json(result);
  });
  api.get('/matters/:id', (c) => {
    const row = getMatter(db, c.req.param('id'));
    if (!row || !catalog.towns.some((t) => t.id === row.jurisdiction))
      return c.json({ error: 'Record not found' }, 404);
    const result: MatterDetail = {
      ...matterSummary(row),
      sampleData: hasSampleData(db, row.jurisdiction),
      events: matterTimeline(db, row.id).map((e) => ({
        ...summary(e),
        stage: e.stage,
        evidence: e.evidence,
      })),
    };
    return c.json(result);
  });

  api.use('/session', async (c, next) => {
    c.header('cache-control', 'private, no-store');
    await next();
  });
  api.post('/session', async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Enter an email address and password.' }, 400);
    const session = await accounts.signIn(parsed.data.email, parsed.data.password);
    if (!session) return c.json({ error: 'Email or password did not match.' }, 401);
    return c.json({ token: session.value } satisfies LoginResponse);
  });

  // API authentication accepts an explicitly supplied bearer only, never ambient
  // browser cookies. Browser form CSRF protection remains in the web routes.
  const authenticated = new Hono<{ Variables: { identity: Identity } }>();
  authenticated.use('*', async (c, next) => {
    c.header('cache-control', 'private, no-store');
    const auth = c.req.header('authorization');
    const token = auth?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || token.length > 16000) return c.json({ error: 'Please sign in.' }, 401);
    const identity = await accounts.resolve(token);
    if (!identity) return c.json({ error: 'Please sign in again.' }, 401);
    c.set('identity', identity);
    if (identity.refreshedCookie) c.header('x-towncivic-session', identity.refreshedCookie.value);
    await next();
  });
  authenticated.get('/session', (c) => {
    const reader = c.get('identity').reader;
    return c.json({ name: readerName(reader), email: reader.email } satisfies Session);
  });
  authenticated.delete('/session', async (c) => {
    await accounts.signOut(c.get('identity'));
    return c.json({ ok: true });
  });
  authenticated.get('/following', async (c) => {
    const subscriptions = await accounts.listSubscriptions(c.get('identity'));
    const items = subscriptions
      .filter((s) => s.kind === 'matter')
      .flatMap((s) => {
        const row = getMatter(db, s.value);
        return row && catalog.towns.some((t) => t.id === row.jurisdiction) ? [matterSummary(row)] : [];
      });
    return c.json({ items } satisfies Following);
  });
  authenticated.put('/following/:id', async (c) => {
    const row = getMatter(db, c.req.param('id'));
    if (!row || !catalog.towns.some((t) => t.id === row.jurisdiction))
      return c.json({ error: 'Record not found' }, 404);
    await accounts.addSubscription(c.get('identity'), {
      kind: 'matter',
      value: row.id,
      label: row.label,
      jurisdiction: row.jurisdiction,
    });
    return c.json({ ok: true });
  });
  authenticated.delete('/following/:id', async (c) => {
    const row = getMatter(db, c.req.param('id'));
    if (!row || !catalog.towns.some((t) => t.id === row.jurisdiction))
      return c.json({ error: 'Record not found' }, 404);
    await accounts.removeSubscription(c.get('identity'), 'matter', row.id, row.jurisdiction);
    return c.json({ ok: true });
  });
  api.route('/', authenticated);
  return api;
}
