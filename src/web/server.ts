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
import type { EventQuery, EventRow } from '../db/repo.ts';
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
import {
  acceptSuggestion,
  addAlertRule,
  getPreferences,
  getProposalRow,
  knownInstitutions,
  listAlertRules,
  listProposals,
  rankContextFor,
  removeAlertRule,
  resolveProposal,
  saveProposal,
  savePreferences,
  setAlertRuleEnabled,
  suggestInterests,
} from '../profile/store.ts';
import { impactsForEvent, impactsForEvents } from '../pipeline/impacts.ts';
import { rankEvents } from '../profile/score.ts';
import { evaluateAlerts, suggestedRules, validateRule } from '../profile/alerts.ts';
import { acceptProposal, applyAnswers, proposeFromText } from '../profile/setup.ts';
import type { Proposal } from '../profile/setup.ts';
import { TEMPLATES, pendingQuestions } from '../profile/templates.ts';
import {
  DEFAULT_RADIUS_METERS,
  TREATMENTS,
  defaultPreferences,
  removeInterest,
  setScope,
  upsertInterest,
} from '../profile/preferences.ts';
import type { GeoScope, Preferences, Treatment } from '../profile/preferences.ts';
import { GEO_SCOPES } from '../profile/preferences.ts';
import { SCHOOL_SCOPES, allImpactKeys } from '../profile/impacts.ts';
import type { SchoolScope } from '../profile/impacts.ts';
import { geocodeAddress } from '../pipeline/geocode.ts';
import { renderAlerts, renderForYou, renderPreferences, renderSetup } from './profile-views.ts';
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
        impacts: impactsForEvent(db, row.id),
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
  /**
   * The two curated views, as feeds.
   *
   * Registered before the plain personal feed so the more specific path wins,
   * and every entry carries the sentence that put it there — a ranked record
   * with no reason attached is exactly the thing this design set out not to
   * ship, and a feed reader is where most people will actually meet it.
   */
  app.get('/feeds/my/:view{(?:for-you|alerts)}/:token{.+\\.atom}', (c) => {
    const view = c.req.param('view');
    const name = c.req.param('token');
    const user = getUserByFeedToken(db, name.slice(0, name.lastIndexOf('.')));
    if (!user) return c.notFound();

    const notes = new Map<string, string>();
    let rows: EventRow[] = [];

    if (view === 'alerts') {
      const { hits } = alertHitsFor(user.id);
      for (const hit of hits.slice(0, FEED_SIZE)) {
        if (notes.has(hit.row.id)) continue;
        notes.set(hit.row.id, `${hit.rule.label}: ${hit.reason}`);
        rows.push(hit.row);
      }
    } else {
      const preferences = getPreferences(db, user.id);
      const candidates = queryEvents(db, recentWindow());
      const ranked = rankEvents(
        candidates,
        impactsForEvents(
          db,
          candidates.map((row) => row.id),
        ),
        preferences,
        rankContextFor(db, user.id, candidates),
      ).slice(0, FEED_SIZE);
      rows = ranked.map((item) => item.row);
      for (const item of ranked) notes.set(item.row.id, item.explanation);
    }

    return c.body(
      renderAtom(rows, {
        title: `townCivic — ${nameFor(user)} — ${view === 'alerts' ? 'alerts' : 'for you'}`,
        subtitle:
          view === 'alerts'
            ? 'Records matching the alert rules you wrote down.'
            : 'Ranked against your declared preferences. Every entry says why.',
        selfUrl: `${baseUrl}/feeds/my/${view}/${name}`,
        htmlUrl: `${baseUrl}/${view === 'alerts' ? 'alerts' : 'for-you'}`,
        baseUrl,
        updated: rows[0]?.last_seen_at ?? null,
        notes,
      }),
      200,
      {
        'content-type': 'application/atom+xml; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    );
  });

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

  /* ---------------------------------------------- for you, and alerts */

  /**
   * How many records the ranker is allowed to look at.
   *
   * For You is a re-ordering of a recent window, not a search over the archive.
   * Ranking the whole corpus would put a six-month-old record above this week's
   * hearing whenever the preferences matched it better, which is not what a
   * civic feed is for — and the raw record at `/` is the place to go back in
   * time anyway.
   */
  const RANK_WINDOW = 400;
  const RANK_DAYS = 120;

  const recentWindow = (): EventQuery => ({
    jurisdiction,
    since: new Date(Date.now() - RANK_DAYS * 86_400_000).toISOString(),
    limit: RANK_WINDOW,
  });

  app.get('/for-you', (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login?next=%2Ffor-you', 302);

    const preferences = getPreferences(db, current.user.id);
    const rows = queryEvents(db, recentWindow());
    const impacts = impactsForEvents(
      db,
      rows.map((row) => row.id),
    );
    const context = rankContextFor(db, current.user.id, rows);
    const ranked = rankEvents(rows, impacts, preferences, context);

    // Upcoming first, because a hearing you can still attend is worth more than
    // a better-matching record about a meeting that already happened.
    const now = new Date().toISOString();
    const isUpcoming = (row: EventRow) => (row.occurred_at ?? row.published_at ?? '') > now;

    return c.html(
      renderForYou({
        upcoming: ranked.filter((item) => isUpcoming(item.row)).slice(0, 25),
        scored: ranked.filter((item) => !isUpcoming(item.row)).slice(0, 40),
        considered: rows.length,
        muted: rows.length - ranked.length,
        preferences,
        suggestions: suggestInterests(db, current.user.id, preferences),
        csrfToken: current.session.csrfToken,
        feedUrl: `${baseUrl}/feeds/my/for-you/${current.user.feed_token}.atom`,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: nameFor(current.user),
        ...(new URL(c.req.url).searchParams.get('saved') ? { notice: 'Saved.' } : {}),
      }),
    );
  });

  /** Every record in the window that satisfies at least one of a reader's rules. */
  const alertHitsFor = (userId: string) => {
    const preferences = getPreferences(db, userId);
    const rules = listAlertRules(db, userId, { enabledOnly: true });
    if (!rules.length) return { preferences, rules, hits: [] };

    const rows = queryEvents(db, recentWindow());
    const impacts = impactsForEvents(
      db,
      rows.map((row) => row.id),
    );
    const context = rankContextFor(db, userId, rows);
    const hits = rows.flatMap((row) =>
      evaluateAlerts(rules, row, impacts.get(row.id) ?? [], preferences, context),
    );
    return { preferences, rules, hits };
  };

  app.get('/alerts', (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login?next=%2Falerts', 302);

    const { preferences, hits } = alertHitsFor(current.user.id);
    const url = new URL(c.req.url);

    return c.html(
      renderAlerts({
        rules: listAlertRules(db, current.user.id),
        hits: hits.slice(0, 50),
        suggested: suggestedRules(preferences),
        hasHome: Boolean(preferences.home),
        csrfToken: current.session.csrfToken,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: nameFor(current.user),
        ...(url.searchParams.get('error') ? { error: url.searchParams.get('error')! } : {}),
      }),
    );
  });

  app.post('/alerts/rules', async (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }

    const action = String(form['action'] ?? '');
    const id = String(form['id'] ?? '');

    if (action === 'remove') removeAlertRule(db, current.user.id, id);
    else if (action === 'pause') setAlertRuleEnabled(db, current.user.id, id, false);
    else if (action === 'resume') setAlertRuleEnabled(db, current.user.id, id, true);
    else if (action === 'add') {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(String(form['params'] ?? '{}')) as Record<string, unknown>;
      } catch {
        return c.redirect('/alerts?error=' + encodeURIComponent('Those parameters are not valid JSON.'), 303);
      }
      // Validated before storage rather than at firing time: a rule that is
      // saved but can never match looks configured and is silently useless.
      const checked = validateRule(String(form['kind'] ?? ''), params);
      if (!checked.ok) return c.redirect('/alerts?error=' + encodeURIComponent(checked.error), 303);

      addAlertRule(db, current.user.id, {
        kind: String(form['kind']),
        label: String(form['label'] ?? '').trim() || 'Unnamed rule',
        params: checked.params,
      });
    }
    return c.redirect('/alerts', 303);
  });

  /* --------------------------------------------------- profile setup */

  const setupPage = (
    c: Context,
    user: UserRow,
    session: Session,
    proposal: Proposal | null,
    proposalId: string | null,
  ) =>
    c.html(
      renderSetup({
        templates: [...TEMPLATES],
        proposal,
        proposalId,
        preferences: getPreferences(db, user.id),
        history: listProposals(db, user.id, 5).map((row) => ({
          request: row.request,
          status: row.status,
          createdAt: row.created_at,
        })),
        csrfToken: session.csrfToken,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: nameFor(user),
      }),
    );

  app.get('/my/setup', (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login?next=%2Fmy%2Fsetup', 302);
    return setupPage(c, current.user, current.session, null, null);
  });

  /**
   * Turn a sentence into a *proposal*, and stop.
   *
   * The whole argument for natural-language setup is that it stays a preview.
   * This handler stores what it would do and renders it; nothing reaches the
   * profile until the reader posts to `/my/setup/accept`.
   */
  app.post('/my/setup', async (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }

    const request = String(form['request'] ?? '')
      .trim()
      .slice(0, 1_000);
    if (!request) return c.redirect('/my/setup', 303);

    const proposal = proposeFromText(request, getPreferences(db, current.user.id));
    const id = saveProposal(db, current.user.id, request, proposal);
    return setupPage(c, current.user, current.session, proposal, id);
  });

  app.post('/my/setup/accept', async (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody({ all: true });
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }

    const row = getProposalRow(db, current.user.id, String(form['proposal'] ?? ''));
    if (!row) return c.redirect('/my/setup', 303);

    if (String(form['action'] ?? '') !== 'accept') {
      resolveProposal(db, current.user.id, row.id, 'declined');
      return c.redirect('/my/setup', 303);
    }

    // Answers to the template's questions arrive as `answer:<question id>`, and
    // are the only route by which a school stage or a tenure ever gets set —
    // there is no path from the words "parent" or "retiree" to either.
    const choices: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(form)) {
      if (!key.startsWith('answer:')) continue;
      choices[key.slice('answer:'.length)] = (Array.isArray(value) ? value : [value]).map(String);
    }

    const proposal = JSON.parse(row.proposal) as Proposal;
    savePreferences(
      db,
      current.user.id,
      acceptProposal(getPreferences(db, current.user.id), proposal, choices),
    );
    resolveProposal(db, current.user.id, row.id, 'accepted');
    return c.redirect('/for-you?saved=1', 303);
  });

  /* --------------------------------------------- the preference editor */

  app.get('/my/preferences', (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login?next=%2Fmy%2Fpreferences', 302);
    const url = new URL(c.req.url);
    const preferences = getPreferences(db, current.user.id);

    return c.html(
      renderPreferences({
        preferences,
        suggestions: suggestInterests(db, current.user.id, preferences),
        pending: pendingQuestions(preferences),
        knownInstitutions: knownInstitutions(db, jurisdiction),
        csrfToken: current.session.csrfToken,
        sampleData: hasSampleData(db),
        jurisdictionLabel: label,
        account: nameFor(current.user),
        ...(url.searchParams.get('notice') ? { notice: url.searchParams.get('notice')! } : {}),
      }),
    );
  });

  app.post('/my/preferences', async (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody({ all: true });
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }

    const existing = getPreferences(db, current.user.id);
    let next: Preferences = { ...defaultPreferences(), templates: existing.templates };

    // Anything the reader touched here is theirs: a row edited on this page is
    // `declared`, which outranks whatever template proposed it. That is the
    // whole authority ladder, in one assignment.
    for (const key of allImpactKeys()) {
      const raw = form[`treatment:${key}`];
      const treatment = String(Array.isArray(raw) ? raw[0] : (raw ?? 'normal'));
      if (!(TREATMENTS as readonly string[]).includes(treatment)) continue;
      if (treatment === 'normal') {
        next = removeInterest(next, key);
        continue;
      }
      const previous = existing.interests.find((interest) => interest.key === key);
      next = upsertInterest(next, {
        key,
        treatment: treatment as Treatment,
        origin: previous?.treatment === treatment ? previous.origin : 'declared',
        ...(previous?.template ? { template: previous.template } : {}),
      });
    }

    for (const row of next.geography) {
      const raw = form[`scope:${row.channel}`];
      const scope = String(Array.isArray(raw) ? raw[0] : (raw ?? ''));
      if ((GEO_SCOPES as readonly string[]).includes(scope))
        next = setScope(next, row.channel, scope as GeoScope);
    }

    const stages = (Array.isArray(form['stage']) ? form['stage'] : form['stage'] ? [form['stage']] : [])
      .map(String)
      .filter((stage): stage is SchoolScope => (SCHOOL_SCOPES as readonly string[]).includes(stage));
    const institutions = String(form['institutions'] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    next.schools = { stages, institutions };

    const radius = Number(form['radius'] ?? DEFAULT_RADIUS_METERS);
    const address = String(form['home'] ?? '').trim();
    let notice = 'Saved.';

    if (!address) {
      // Clearing the field deletes it, rather than keeping the coordinates
      // around with the label removed.
      next.home = null;
    } else if (existing.home && existing.home.label === address) {
      next.home = {
        ...existing.home,
        radiusMeters: Number.isFinite(radius)
          ? Math.min(8_000, Math.max(100, radius))
          : DEFAULT_RADIUS_METERS,
      };
    } else {
      const match = await geocodeAddress(address, { jurisdiction });
      if (match) {
        next.home = {
          label: address,
          lat: match.lat,
          lon: match.lon,
          radiusMeters: Number.isFinite(radius)
            ? Math.min(8_000, Math.max(100, radius))
            : DEFAULT_RADIUS_METERS,
        };
      } else {
        // Refusing to store an unresolved home is the point: a near-home rule
        // with nothing to measure from would look configured and fire on
        // nothing, which is the failure mode nobody notices.
        next.home = null;
        notice = `Could not place “${address}” inside ${label}. Near-home rules stay off until an address resolves.`;
      }
    }

    savePreferences(db, current.user.id, next);
    return c.redirect(`/my/preferences?notice=${encodeURIComponent(notice)}`, 303);
  });

  /**
   * Answer a question that outlived the preview that raised it.
   *
   * Only questions the profile is actually still waiting on are honoured, which
   * is the same guard the proposal flow uses: a form field invented between
   * render and post cannot introduce a row nobody was asked about.
   */
  app.post('/my/questions', async (c) => {
    const current = currentUser(c);
    if (!current) return c.redirect('/login', 302);
    const form = await c.req.parseBody({ all: true });
    if (!checkCsrf(current.session, form['csrf'] ? String(form['csrf']) : undefined)) {
      return c.text('Bad request: this form has expired. Reload the page and try again.', 403);
    }

    const preferences = getPreferences(db, current.user.id);
    const choices: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(form)) {
      if (!key.startsWith('answer:')) continue;
      choices[key.slice('answer:'.length)] = (Array.isArray(value) ? value : [value]).map(String);
    }

    const questions = pendingQuestions(preferences).map((row) => row.question);
    savePreferences(db, current.user.id, applyAnswers(preferences, questions, choices));
    return c.redirect('/my/preferences?notice=' + encodeURIComponent('Answered.'), 303);
  });

  app.post('/my/suggestions', (c) =>
    guarded(c, (user, form) => {
      if (String(form['action'] ?? '') !== 'accept') return;
      const key = String(form['key'] ?? '');
      savePreferences(db, user.id, acceptSuggestion(getPreferences(db, user.id), key));
    }),
  );

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
