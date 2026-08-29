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
  listJurisdictionRows,
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
import { getProfile, hasJurisdiction, listJurisdictions, loadSources } from '../registry/index.ts';
import {
  ALL_JURISDICTIONS,
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
  renderTowns,
  withTown,
} from './views.ts';
import type { Filters, NoticeView, TownView } from './views.ts';
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

/** Read filters off the query string, ignoring anything that is not a known value. */
function readFilters(url: URL, town: TownView): Filters {
  const get = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  const channel = get('channel');
  const whenRaw = get('when');
  const page = Number(get('page') ?? 1);

  return {
    // Carried on every link so a filtered page is shareable as one URL — and
    // omitted entirely on a single-town install, which keeps those URLs as they
    // were before any of this existed.
    ...(town.options.length > 1 ? { town: town.id } : {}),
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
  /** The town served when a request does not name one. */
  jurisdiction?: string;
  /** Every town this instance serves. Defaults to the whole registry. */
  jurisdictions?: string[];
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
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const secureCookies = options.secureCookies ?? config.secureCookies;

  /**
   * The towns this instance serves, and the one a bare URL means.
   *
   * Fixed at startup rather than read per request: which towns exist is a
   * property of the build, and a switcher whose contents could change between
   * two requests would be a strange thing to hand a reader.
   */
  const served = (options.jurisdictions ?? listJurisdictions()).filter(hasJurisdiction);
  const fallback = options.jurisdiction ?? config.defaultJurisdiction;
  const defaultJurisdiction = served.includes(fallback) ? fallback : (served[0] ?? fallback);
  const townOptions = served.map((id) => ({ id, label: getProfile(id).label }));

  // Outlines are committed files that change when a town's borders do, so they
  // are read once each and kept — per request would be silly, and per town
  // rather than one global means a four-town install does not read four files
  // to serve one page.
  const boundaries = new Map<string, ReturnType<typeof loadBoundary>>();
  const boundaryFor = (id: string) => {
    if (!boundaries.has(id)) boundaries.set(id, loadBoundary(id));
    return boundaries.get(id) ?? null;
  };

  /**
   * Which town a request is about.
   *
   * `?town=` and nothing else: no cookie, no session state, no `Accept`
   * negotiation. A URL is the whole answer to "what am I looking at", which is
   * what makes a link someone pastes into an email mean the same thing for the
   * person who opens it.
   */
  const townFor = (c: Context, override?: string): TownView => {
    const requested = override ?? new URL(c.req.url).searchParams.get('town')?.trim();
    const id = requested && served.includes(requested) ? requested : defaultJurisdiction;
    return { id, label: getProfile(id).label, options: townOptions, path: new URL(c.req.url).pathname };
  };

  /**
   * For a page addressed by record id, the town is whatever the row says it is
   * — including a town the registry has since dropped. An event page should
   * show the record it was asked for and name its town honestly, not silently
   * relabel it as the default one.
   */
  const townOfRow = (c: Context, jurisdiction: string): TownView => ({
    id: jurisdiction,
    label: getProfile(jurisdiction).label,
    options: townOptions,
    path: new URL(c.req.url).pathname,
  });

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
  app.get('/healthz', (c) => c.json({ ok: true, jurisdiction: defaultJurisdiction, jurisdictions: served }));

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    const town = townFor(c);
    const filters = readFilters(url, town);
    const current = currentUser(c);
    const base = toQuery(filters, town.id);

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
        sampleData: hasSampleData(db, town.id),
        town,
        pageSize: PAGE_SIZE,
        feedUrl: withTown(`/feeds/${filters.channel ?? 'all'}.atom`, town),
        hasDerived: countInterpretations(db, town.id) > 0,
        townDormant: !loadSources(town.id).some((source) => source.enabled),
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
        sampleData: hasSampleData(db, row.jurisdiction),
        town: townOfRow(c, row.jurisdiction),
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
    const town = townFor(c);
    const kindParam = url.searchParams.get('kind')?.trim();
    const kind = kindParam && (MATTER_KINDS as readonly string[]).includes(kindParam) ? kindParam : undefined;
    const q = url.searchParams.get('q')?.trim() || undefined;
    // Single-record matters are real, but they are not timelines — they would
    // bury the handful of sequences worth reading, so they are off by default.
    const includeSingletons = url.searchParams.get('all') === '1';

    const query = {
      jurisdiction: town.id,
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
        linked: countMatters(db, { jurisdiction: town.id }) > 0,
        sampleData: hasSampleData(db, town.id),
        town,
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
              watched: isWatching(db, current.user.id, 'matter', matter.id, matter.jurisdiction),
              csrfToken: current.session.csrfToken,
              account: nameFor(current.user),
            }
          : { signedIn: false, account: null }),
        sampleData: hasSampleData(db, matter.jurisdiction),
        town: townOfRow(c, matter.jurisdiction),
      }),
    );
  });

  app.get('/map', (c) => {
    const town = townFor(c);
    const highlight = new URL(c.req.url).searchParams.get('matter')?.trim();
    const placed = listPlacedMatters(db, town.id);
    const unplaced = listUnplacedMatters(db, town.id);

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
      boundary: boundaryFor(town.id),
      box: getProfile(town.id).bbox,
      ...(highlight ? { highlight } : {}),
    });

    return c.html(
      layout({
        title: `Map — ${town.label} — townCivic`,
        town,
        filters: EMPTY_FILTERS,
        sampleData: hasSampleData(db, town.id),
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
        sampleData: hasSampleData(db, defaultJurisdiction),
        town: townFor(c),
      }),
    );
  });

  app.get('/signup', (c) => {
    if (currentUser(c)) return c.redirect('/my', 302);
    return c.html(
      renderAuth({ mode: 'signup', sampleData: hasSampleData(db, defaultJurisdiction), town: townFor(c) }),
    );
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
          sampleData: hasSampleData(db, defaultJurisdiction),
          town: townFor(c),
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
          sampleData: hasSampleData(db, defaultJurisdiction),
          town: townFor(c),
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
    const town = townFor(c);

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
          jurisdiction: s.jurisdiction,
          townLabel: s.jurisdiction === ALL_JURISDICTIONS ? 'every town' : getProfile(s.jurisdiction).label,
        })),
        // The reader's feed spans every town they follow — an account is a
        // person, not a town — while the "follow something" list below is
        // scoped to the town they are looking at, because that is where the
        // board names on it come from.
        recent: personalFeed(db, subscriptions, { limit: 20 }),
        bodies: facetCounts(db, 'body', { jurisdiction: town.id }).slice(0, 40),
        feedUrl: `${baseUrl}/feeds/my/${current.user.feed_token}.atom`,
        csrfToken: current.session.csrfToken,
        ...(new URL(c.req.url).searchParams.get('saved') ? { notice: 'Saved.' } : {}),
        sampleData: hasSampleData(db),
        town,
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
      // The matter's own town, not the one in the URL: a matter belongs to
      // exactly one town and the row is the authority on which.
      if (String(form['action'] ?? 'watch') === 'unwatch') {
        removeSubscription(db, user.id, 'matter', matter.id, matter.jurisdiction);
      } else {
        addSubscription(db, user.id, {
          kind: 'matter',
          value: matter.id,
          label: matter.label,
          jurisdiction: matter.jurisdiction,
        });
      }
    }),
  );

  app.post('/my/subscribe', (c) =>
    guarded(c, (user, form) => {
      const kind = String(form['kind'] ?? '');
      const value = String(form['value'] ?? '').trim();
      if (!value || !isSubscriptionKind(kind)) return;
      const label = kind === 'channel' && isChannel(value) ? (CHANNEL_LABELS[value] ?? value) : value;
      const requested = String(form['town'] ?? '');
      addSubscription(db, user.id, {
        kind,
        value,
        label,
        jurisdiction: served.includes(requested) ? requested : defaultJurisdiction,
      });
    }),
  );

  app.post('/my/unsubscribe', (c) =>
    guarded(c, (user, form) => {
      const town = String(form['town'] ?? '');
      removeSubscription(
        db,
        user.id,
        String(form['kind'] ?? ''),
        String(form['value'] ?? ''),
        town || undefined,
      );
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
    // No jurisdiction filter: each subscription already carries its own town.
    const rows = personalFeed(db, subscriptions, { limit: FEED_SIZE });

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

  app.get('/sources', (c) => {
    const town = townFor(c);
    return c.html(renderSources(listSourceRows(db, town.id), hasSampleData(db, town.id), town));
  });

  app.get('/feeds', (c) => {
    const town = townFor(c);
    return c.html(renderFeedIndex(hasSampleData(db, town.id), town, baseUrl));
  });

  /**
   * Every town this install carries.
   *
   * Reached from the switcher, and the honest answer to "what else is in here":
   * it says which towns are live, which are registered but unconfirmed, and
   * which have records for a town the registry has since dropped.
   */
  app.get('/towns', (c) => {
    const town = townFor(c);
    const rows = listJurisdictionRows(db);
    return c.html(
      renderTowns({
        town,
        towns: rows.map((row) => ({
          id: row.id,
          label: row.label,
          events: row.events,
          matters: row.matters,
          sources: row.sources,
          enabledSources: row.enabled_sources,
          lastFetchAt: row.last_fetch_at,
          registered: hasJurisdiction(row.id),
          boundary: Boolean(boundaryFor(row.id)),
          notes: row.notes,
        })),
        sampleData: hasSampleData(db, town.id),
        account: currentUser(c) ? nameFor(currentUser(c)!.user) : null,
      }),
    );
  });

  app.get('/feeds/:name{.+\\.(atom|json)}', (c) => {
    const town = townFor(c);
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

    // A matter feed follows the matter's own town; everything else follows the
    // town the URL asked for.
    const scope = matter ? matter.jurisdiction : town.id;
    const query = { ...toQuery(filters, scope), ...(matter ? { matters: [matter.id] } : {}) };
    const rows = queryEvents(db, { ...query, limit: FEED_SIZE });
    const options = {
      title: matter ? `${matter.label} — townCivic` : feedTitle(channel, town.label),
      subtitle: matter
        ? `Every record townCivic has linked to ${matter.label}.`
        : channel === 'all'
          ? 'Primary-source records published by and about this jurisdiction.'
          : (CHANNEL_DESCRIPTIONS[channel] ?? ''),
      selfUrl: `${baseUrl}/feeds/${name}${url.search}`,
      htmlUrl: matter
        ? `${baseUrl}/matter/${matter.id}`
        : `${baseUrl}${withTown('/', town, channel === 'all' ? {} : { channel })}`,
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
