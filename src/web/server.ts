import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import {
  countEvents,
  countInterpretations,
  countMatters,
  facetCounts,
  interpretationsForEvent,
  getAttachment,
  getEvent,
  getMatter,
  getPlace,
  latestEventTimestamp,
  listMatters,
  listPlacedMatters,
  listSourceRows,
  listUnplacedMatters,
  matterKindCounts,
  matterTimeline,
  mattersForEvent,
  personalFeed,
  queryEvents,
} from '../db/repo.ts';
import type { EventQuery } from '../db/repo.ts';
import { hasSampleData } from '../commands/seed.ts';
import { CHANNEL_DESCRIPTIONS, CHANNEL_LABELS, isChannel } from '../taxonomy.ts';
import { MATTER_KINDS } from '../matters/key.ts';
import {
  SESSION_COOKIE,
  addSubscription,
  authenticate,
  checkCsrf,
  clearedCookie,
  createSession,
  createUser,
  destroySession,
  getUser,
  getUserByFeedToken,
  isSubscriptionKind,
  isWatching,
  listSubscriptions,
  readCookie,
  readSession,
  removeSubscription,
  sessionCookie,
} from './accounts.ts';
import type { Session, UserRow } from './accounts.ts';
import { STYLES } from './styles.ts';
import {
  EMPTY_FILTERS,
  layout,
  renderAuth,
  renderEvent,
  renderFeedIndex,
  renderIndex,
  renderMatter,
  renderMatters,
  renderProfile,
  renderSources,
} from './views.ts';
import type { Filters, NoticeView } from './views.ts';
import { renderMapBody } from './map.ts';
import { loadBoundary } from '../geo/boundary.ts';
import { feedTitle, renderAtom, renderJsonFeed } from './feeds.ts';

const PAGE_SIZE = 60;
const FEED_SIZE = 50;
/**
 * Milton has 78 boards. Listing every one turns the filter rail into a wall, so
 * it shows the most active and says how many it left out.
 */
const FACET_LIMIT = 16;

const JURISDICTION_LABELS: Record<string, string> = {
  'milton-ma': 'Milton, Massachusetts',
};

function labelFor(jurisdiction: string): string {
  return JURISDICTION_LABELS[jurisdiction] ?? jurisdiction;
}

/** Read filters off the query string, ignoring anything that is not a known value. */
function readFilters(url: URL): Filters {
  const get = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  const channel = get('channel');
  const whenRaw = get('when');
  const page = Number(get('page') ?? 1);

  return {
    ...(channel && isChannel(channel) ? { channel } : {}),
    ...(get('source') ? { source: get('source') } : {}),
    ...(get('body') ? { body: get('body') } : {}),
    ...(get('level') ? { level: get('level') } : {}),
    ...(get('q') ? { q: get('q') } : {}),
    ...(url.searchParams.get('derived') === '1' ? { derived: true } : {}),
    when: whenRaw === 'upcoming' || whenRaw === 'past' ? whenRaw : 'all',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function toQuery(filters: Filters, jurisdiction: string): EventQuery {
  return {
    jurisdiction,
    ...(filters.channel ? { channels: [filters.channel] } : {}),
    ...(filters.source ? { sources: [filters.source] } : {}),
    ...(filters.body ? { bodies: [filters.body] } : {}),
    ...(filters.level ? { levels: [filters.level] } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.derived ? { includeDerived: true } : {}),
  };
}

export interface AppOptions {
  jurisdiction?: string;
  /** Absolute URL this instance is reachable at; used for feed self-links. */
  baseUrl?: string;
  /**
   * Mark the session cookie `Secure`. Off by default because the documented way
   * to run this is `npm run serve` over plain HTTP on localhost, where a Secure
   * cookie is never sent and signing in would appear to fail silently.
   */
  secureCookies?: boolean;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const app = new Hono();
  const jurisdiction = options.jurisdiction ?? config.defaultJurisdiction;
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const label = labelFor(jurisdiction);
  const secureCookies = options.secureCookies ?? config.secureCookies;
  // Read once at startup: it is a committed file that only changes when the
  // town's borders do, and re-reading it per request would be silly.
  const townBoundary = loadBoundary(jurisdiction);

  /**
   * Keep the selected value visible even when it falls outside the top slice,
   * so an active filter never disappears from the rail that set it.
   */
  const trim = (facets: { value: string; n: number }[], selected?: string) => {
    const head = facets.slice(0, FACET_LIMIT);
    if (selected && !head.some((f) => f.value === selected)) {
      const match = facets.find((f) => f.value === selected);
      if (match) head.push(match);
    }
    return { shown: head, hidden: Math.max(0, facets.length - FACET_LIMIT) };
  };

  /**
   * The signed-in reader, if any.
   *
   * Cheap enough to do per request — two indexed lookups against a local SQLite
   * file — and doing it inline keeps every handler's data flow visible rather
   * than hiding it in middleware state.
   */
  const currentUser = (c: Context): { session: Session; user: UserRow } | null => {
    const session = readSession(db, readCookie(c.req.header('cookie'), SESSION_COOKIE));
    if (!session) return null;
    const user = getUser(db, session.userId);
    return user ? { session, user } : null;
  };

  const nameFor = (user: UserRow) => user.display_name || user.email.split('@')[0] || user.email;

  app.get('/styles.css', (c) => c.body(STYLES, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/healthz', (c) => c.json({ ok: true, jurisdiction }));

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const filters = readFilters(url);
    const current = currentUser(c);
    const base = toQuery(filters, jurisdiction);

    // "All" shows what is coming up, then what already happened. Explicitly
    // choosing a mode collapses to just that half.
    const showUpcoming = filters.when !== 'past';
    const showPast = filters.when !== 'upcoming';

    const upcoming =
      showUpcoming && filters.page === 1 ? queryEvents(db, { ...base, when: 'upcoming', limit: 40 }) : [];
    const past = showPast
      ? queryEvents(db, {
          ...base,
          when: 'past',
          limit: PAGE_SIZE,
          offset: (filters.page - 1) * PAGE_SIZE,
        })
      : [];

    return c.html(
      renderIndex({
        filters,
        upcoming,
        past,
        total: countEvents(db, base),
        facets: {
          sources: trim(
            facetCounts(db, 'source_id', base).map((f) => ({ ...f, label: sourceLabel(db, f.value) })),
            filters.source,
          ),
          bodies: trim(facetCounts(db, 'body', base), filters.body),
          levels: trim(facetCounts(db, 'level', base), filters.level),
        },
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        pageSize: PAGE_SIZE,
        feedUrl: `/feeds/${filters.channel ?? 'all'}.atom`,
        hasDerived: countInterpretations(db) > 0,
        account: current ? nameFor(current.user) : null,
      }),
    );
  });

  app.get('/event/:id', (c) => {
    const row = getEvent(db, c.req.param('id'));
    if (!row) return c.notFound();
    const current = currentUser(c);

    const attachment = getAttachment(db, row.id);
    let notice: NoticeView | null = null;
    if (attachment?.notice) {
      try {
        notice = JSON.parse(attachment.notice) as NoticeView;
      } catch {
        notice = null;
      }
    }
    return c.html(
      renderEvent({
        row,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        notice,
        matters: mattersForEvent(db, row.id),
        interpretations: interpretationsForEvent(db, row.id).map((item) => ({
          kind: item.kind,
          provider: item.provider,
          model: item.model,
          text: item.text,
          data: item.data,
          created_at: item.created_at,
        })),
        account: current ? nameFor(current.user) : null,
      }),
    );
  });

  app.get('/matters', (c) => {
    const url = new URL(c.req.url);
    const kindParam = url.searchParams.get('kind')?.trim();
    const kind = kindParam && (MATTER_KINDS as readonly string[]).includes(kindParam) ? kindParam : undefined;
    const q = url.searchParams.get('q')?.trim() || undefined;
    // Single-record matters are real, but they are not timelines — they would
    // bury the handful of sequences worth reading, so they are off by default.
    const includeSingletons = url.searchParams.get('all') === '1';

    const query = {
      jurisdiction,
      ...(kind ? { kinds: [kind] } : {}),
      ...(q ? { q } : {}),
      ...(includeSingletons ? {} : { minEvents: 2 }),
    };

    return c.html(
      renderMatters({
        matters: listMatters(db, { ...query, limit: 200 }),
        total: countMatters(db, query),
        kinds: matterKindCounts(db, query),
        ...(kind ? { kind } : {}),
        ...(q ? { q } : {}),
        includeSingletons,
        linked: countMatters(db, { jurisdiction }) > 0,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: currentUser(c) ? nameFor(currentUser(c)!.user) : null,
      }),
    );
  });

  app.get('/matter/:id', (c) => {
    const matter = getMatter(db, c.req.param('id'));
    if (!matter) return c.notFound();
    const current = currentUser(c);
    return c.html(
      renderMatter({
        matter,
        timeline: matterTimeline(db, matter.id),
        place: getPlace(db, matter.id) ?? null,
        ...(current
          ? {
              signedIn: true,
              watched: isWatching(db, current.user.id, 'matter', matter.id),
              csrfToken: current.session.csrfToken,
              account: nameFor(current.user),
            }
          : { signedIn: false, account: null }),
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
      }),
    );
  });

  app.get('/map', (c) => {
    const highlight = new URL(c.req.url).searchParams.get('matter')?.trim();
    const placed = listPlacedMatters(db, jurisdiction);
    const unplaced = listUnplacedMatters(db, jurisdiction);

    const body = renderMapBody({
      points: placed.map((row) => ({
        matterId: row.id,
        label: row.label,
        lat: row.lat,
        lon: row.lon,
        eventCount: row.event_count,
        status: row.status,
        channel: row.channel,
        matched: row.matched,
      })),
      unplaced: unplaced.map((row) => ({ matterId: row.id, label: row.label, reason: row.failure })),
      totalAddresses: placed.length + unplaced.length,
      geocoded: placed.length > 0,
      boundary: townBoundary,
      ...(highlight ? { highlight } : {}),
    });

    return c.html(
      layout({
        title: 'Map — townCivic',
        jurisdictionLabel: label,
        filters: EMPTY_FILTERS,
        sampleData: hasSampleData(db),
        body,
        account: currentUser(c) ? nameFor(currentUser(c)!.user) : null,
      }),
    );
  });

  /* ------------------------------------------------------------- accounts */

  /**
   * Only same-site paths are accepted as a post-login destination. An
   * open redirect is the classic way a login form becomes a phishing tool.
   */
  const safeNext = (value: string | undefined): string | undefined =>
    value && value.startsWith('/') && !value.startsWith('//') ? value : undefined;

  app.get('/login', (c) => {
    if (currentUser(c)) return c.redirect('/my', 302);
    const next = safeNext(new URL(c.req.url).searchParams.get('next') ?? undefined);
    return c.html(
      renderAuth({
        mode: 'login',
        next,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
      }),
    );
  });

  app.get('/signup', (c) => {
    if (currentUser(c)) return c.redirect('/my', 302);
    return c.html(renderAuth({ mode: 'signup', sampleData: hasSampleData(db), jurisdictionLabel: label }));
  });

  const startSession = (c: Context, userId: string, next: string | undefined) => {
    const session = createSession(db, userId);
    c.header('set-cookie', sessionCookie(session, secureCookies));
    return c.redirect(next ?? '/my', 303);
  };

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form['email'] ?? '');
    const next = safeNext(form['next'] ? String(form['next']) : undefined);
    const user = authenticate(db, email, String(form['password'] ?? ''));

    if (!user) {
      // One message for both "no such account" and "wrong password": which of
      // the two it was is not the visitor's business to learn.
      return c.html(
        renderAuth({
          mode: 'login',
          error: 'That email and password did not match.',
          email,
          next,
          sampleData: hasSampleData(db),
          jurisdictionLabel: label,
        }),
        401,
      );
    }
    return startSession(c, user.id, next);
  });

  app.post('/signup', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form['email'] ?? '');
    const result = createUser(db, {
      email,
      password: String(form['password'] ?? ''),
      ...(form['displayName'] ? { displayName: String(form['displayName']) } : {}),
    });

    if (!result.ok || !result.user) {
      return c.html(
        renderAuth({
          mode: 'signup',
          ...(result.error ? { error: result.error } : {}),
          email,
          sampleData: hasSampleData(db),
          jurisdictionLabel: label,
        }),
        400,
      );
    }
    return startSession(c, result.user.id, undefined);
  });

  app.post('/logout', async (c) => {
    const current = currentUser(c);
    const form = await c.req.parseBody();
    if (current && checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      destroySession(db, current.session.id);
    }
    c.header('set-cookie', clearedCookie(secureCookies));
    return c.redirect('/', 303);
  });

  app.get('/my', (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login?next=%2Fmy', 302);

    const subscriptions = listSubscriptions(db, current.user.id);
    return c.html(
      renderProfile({
        email: current.user.email,
        displayName: current.user.display_name,
        subscriptions: subscriptions.map((s) => ({
          kind: s.kind,
          value: s.value,
          label: s.label,
          alerts: s.alerts,
        })),
        recent: personalFeed(db, subscriptions, { jurisdiction, limit: 20 }),
        bodies: facetCounts(db, 'body', { jurisdiction }).slice(0, 40),
        feedUrl: `${baseUrl}/feeds/my/${current.user.feed_token}.atom`,
        csrfToken: current.session.csrfToken,
        ...(new URL(c.req.url).searchParams.get('saved') ? { notice: 'Saved.' } : {}),
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: nameFor(current.user),
      }),
    );
  });

  /** Every state-changing post goes through the same gate. */
  const guarded = async (
    c: Context,
    handler: (user: UserRow, form: Record<string, unknown>) => void,
  ): Promise<Response> => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }
    handler(current.user, form);
    return c.redirect(safeNext(form['next'] ? String(form['next']) : undefined) ?? '/my?saved=1', 303);
  };

  app.post('/my/watch', (c) =>
    guarded(c, (user, form) => {
      const matter = getMatter(db, String(form['matter'] ?? ''));
      if (!matter) return;
      if (String(form['action'] ?? 'watch') === 'unwatch') {
        removeSubscription(db, user.id, 'matter', matter.id);
      } else {
        addSubscription(db, user.id, { kind: 'matter', value: matter.id, label: matter.label });
      }
    }),
  );

  app.post('/my/subscribe', (c) =>
    guarded(c, (user, form) => {
      const kind = String(form['kind'] ?? '');
      const value = String(form['value'] ?? '').trim();
      if (!value || !isSubscriptionKind(kind)) return;
      const label = kind === 'channel' && isChannel(value) ? (CHANNEL_LABELS[value] ?? value) : value;
      addSubscription(db, user.id, { kind, value, label });
    }),
  );

  app.post('/my/unsubscribe', (c) =>
    guarded(c, (user, form) => {
      removeSubscription(db, user.id, String(form['kind'] ?? ''), String(form['value'] ?? ''));
    }),
  );

  /**
   * A personal feed, authenticated by a token in the path.
   *
   * Feed readers do not hold cookies, so a bearer token is the only thing that
   * works. It is rotatable, it is not the password, and the page that shows it
   * says plainly that it is a secret.
   */
  app.get('/feeds/my/:token{.+\\.atom}', (c) => {
    const name = c.req.param('token');
    const user = getUserByFeedToken(db, name.slice(0, name.lastIndexOf('.')));
    if (!user) return c.notFound();

    const subscriptions = listSubscriptions(db, user.id);
    const rows = personalFeed(db, subscriptions, { jurisdiction, limit: FEED_SIZE });

    return c.body(
      renderAtom(rows, {
        title: `townCivic — ${nameFor(user)}`,
        subtitle: `Records matching ${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}.`,
        selfUrl: `${baseUrl}/feeds/my/${name}`,
        htmlUrl: `${baseUrl}/my`,
        baseUrl,
        updated: rows[0]?.last_seen_at ?? null,
      }),
      200,
      {
        'content-type': 'application/atom+xml; charset=utf-8',
        // A personal feed is not something a shared cache should keep.
        'cache-control': 'private, no-store',
      },
    );
  });

  app.get('/sources', (c) =>
    c.html(renderSources(listSourceRows(db, jurisdiction), hasSampleData(db), label)),
  );

  app.get('/feeds', (c) => c.html(renderFeedIndex(hasSampleData(db), label, baseUrl)));

  app.get('/feeds/:name{.+\\.(atom|json)}', (c) => {
    const name = c.req.param('name');
    const dot = name.lastIndexOf('.');
    const channel = name.slice(0, dot);
    const format = name.slice(dot + 1);
    if (channel !== 'all' && !isChannel(channel)) return c.notFound();

    const url = new URL(c.req.url);
    const filters: Filters = {
      ...EMPTY_FILTERS,
      ...(channel === 'all' ? {} : { channel }),
      ...(url.searchParams.get('source') ? { source: url.searchParams.get('source')! } : {}),
      ...(url.searchParams.get('body') ? { body: url.searchParams.get('body')! } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
    };

    // A matter feed is the point of the timelines: subscribe to one property
    // and get every future record about it, whichever board publishes it.
    const matterId = url.searchParams.get('matter')?.trim();
    const matter = matterId ? getMatter(db, matterId) : undefined;

    const query = { ...toQuery(filters, jurisdiction), ...(matter ? { matters: [matter.id] } : {}) };
    const rows = queryEvents(db, { ...query, limit: FEED_SIZE });
    const options = {
      title: matter ? `${matter.label} — townCivic` : feedTitle(channel, label),
      subtitle: matter
        ? `Every record townCivic has linked to ${matter.label}.`
        : channel === 'all'
          ? 'Primary-source records published by and about this jurisdiction.'
          : (CHANNEL_DESCRIPTIONS[channel] ?? ''),
      selfUrl: `${baseUrl}/feeds/${name}${url.search}`,
      htmlUrl: matter
        ? `${baseUrl}/matter/${matter.id}`
        : `${baseUrl}/${channel === 'all' ? '' : `?channel=${channel}`}`,
      baseUrl,
      updated: latestEventTimestamp(db, query),
    };

    return format === 'json'
      ? c.body(renderJsonFeed(rows, options), 200, {
          'content-type': 'application/feed+json; charset=utf-8',
        })
      : c.body(renderAtom(rows, options), 200, {
          'content-type': 'application/atom+xml; charset=utf-8',
        });
  });

  return app;
}

const labelCache = new Map<string, string>();
function sourceLabel(db: Db, sourceId: string): string {
  const cached = labelCache.get(sourceId);
  if (cached) return cached;
  const row = db.prepare('SELECT label FROM sources WHERE id = ?').get(sourceId) as
    { label: string } | undefined;
  const label = row?.label ?? sourceId;
  labelCache.set(sourceId, label);
  return label;
}
