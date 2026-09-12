import type { Hono, Context } from 'hono';
import type { Db } from '../db/index.ts';
import type { AccountStore, Identity, SubscriptionInput } from '../accounts/store.ts';
import { readCookie } from '../accounts/cookies.ts';
import { facetCounts, getMatter, personalFeed } from '../db/repo.ts';
import { CHANNELS, CHANNEL_LABELS, isChannel } from '../taxonomy.ts';
import { hasSampleData } from '../commands/seed.ts';
import { escapeHtml as esc, eventCard, layout, EMPTY_FILTERS, withTown } from './views.ts';
import type { TownView } from './views.ts';

const STARTS: Record<string, string> = {
  activity: '/',
  nearby: '/nearby',
  timelines: '/matters',
  personal: '/for-me',
};

/** Public previews and private follows use exactly the same subscription query. */
export function registerAwareness(
  app: Hono,
  db: Db,
  accounts: AccountStore,
  currentUser: (c: Context) => Promise<Identity | null>,
  townFor: (c: Context) => TownView,
  secureCookies: boolean,
): void {
  const choice = (kind: string, value: string, town: TownView): SubscriptionInput | null => {
    if (!value || value.length > 160) return null;
    if (kind === 'channel' && isChannel(value)) {
      return { kind, value, label: CHANNEL_LABELS[value], jurisdiction: town.id };
    }
    if (
      kind === 'body' &&
      facetCounts(db, 'body', { jurisdiction: town.id }).some((b) => b.value === value)
    ) {
      return { kind, value, label: value, jurisdiction: town.id };
    }
    if (kind === 'search') return { kind, value, label: value, jurisdiction: town.id };
    if (kind === 'matter') {
      const matter = getMatter(db, value);
      if (matter?.jurisdiction === town.id)
        return { kind, value, label: matter.label, jurisdiction: town.id };
    }
    return null;
  };
  const page = (body: string, town: TownView, current: Identity | null) =>
    layout({
      title: 'Your local awareness — townCivic',
      town,
      filters: EMPTY_FILTERS,
      sampleData: hasSampleData(db, town.id),
      body,
      activeView: 'for-me',
      account: current?.reader.displayName || current?.reader.email || null,
    });
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;

  app.get('/start', (c) => {
    const start = readCookie(c.req.header('cookie'), 'towncivic_start') ?? '';
    c.header('cache-control', 'private, no-store');
    return c.redirect(withTown(Object.hasOwn(STARTS, start) ? STARTS[start]! : '/', townFor(c)), 302);
  });

  app.get('/interests', async (c) => {
    const town = townFor(c);
    const current = await currentUser(c);
    c.header('cache-control', 'private, no-store');
    const url = new URL(c.req.url);
    const selected = choice(
      url.searchParams.get('kind') ?? '',
      url.searchParams.get('value')?.trim() ?? '',
      town,
    );
    const subscriptions = current ? await accounts.listSubscriptions(current) : [];
    const followed =
      selected &&
      subscriptions.some(
        (s) => s.kind === selected.kind && s.value === selected.value && s.jurisdiction === town.id,
      );
    const preview = selected ? personalFeed(db, [selected], { limit: 12 }) : [];
    const topics = CHANNELS.filter((channel) => channel !== 'admin')
      .map(
        (channel) =>
          `<a class="interest-choice" href="${esc(withTown('/interests', town, { kind: 'channel', value: channel }))}">${esc(CHANNEL_LABELS[channel])}</a>`,
      )
      .join('');
    const boards = facetCounts(db, 'body', { jurisdiction: town.id })
      .map((b) => `<option value="${esc(b.value)}">${esc(b.value)}</option>`)
      .join('');
    const selectionUrl = selected
      ? withTown('/interests', town, { kind: selected.kind, value: selected.value })
      : '/interests';
    const action = selected
      ? current
        ? `<form method="post" action="${esc(withTown('/interests/follow', town))}" class="search">
          ${hidden('csrf', current.csrfToken)}${hidden('kind', selected.kind)}${hidden('value', selected.value)}
          ${hidden('remove', followed ? '1' : '0')}
          <button type="submit">${followed ? 'Unfollow' : 'Follow in this town'}</button>
        </form>`
        : `<p><a href="/login?next=${encodeURIComponent(selectionUrl)}">Sign in to save this interest</a></p>`
      : '';
    return c.html(
      page(
        `<section class="view-intro"><p class="eyebrow">Set up your interests</p>
      <h1>What would you like to keep up with?</h1>
      <p>Choose a topic or board, or search for a place or concern. Preview records before following.
      Choices apply to ${esc(town.label)}; switch towns to add interests elsewhere.</p></section>
      <div class="interest-grid">${topics}</div>
      <h2>Follow a board</h2>
      <form action="/interests" method="get" class="search">${hidden('town', town.id)}${hidden('kind', 'body')}
        <select name="value" aria-label="Board or department" required><option value="">Choose a board</option>${boards}</select>
        <button>Preview</button></form>
      <h2>Find a place or subject</h2>
      <form action="/interests" method="get" class="search">${hidden('town', town.id)}${hidden('kind', 'search')}
        <input type="search" name="value" maxlength="160" required aria-label="Place or search terms" placeholder="Street, facility, or subject">
        <button>Preview</button></form>
      <p>A saved search follows words in official records. To follow a specific property timeline,
        open it from <a href="${esc(withTown('/nearby', town))}">Nearby</a>.
        Topics can include records without a map location.</p>
      ${
        selected
          ? `<section class="detail"><h2>${esc(selected.label)}</h2>
        <p>Preview: up to 12 records, ordered by event date. Following saves this in the app and your Atom feed; it does not send email.</p>
        ${action}${
          preview.map((row) => eventCard(row, { ...EMPTY_FILTERS, town: town.id })).join('') ||
          '<p>No matching records have been collected. You can still follow this interest, or browse another topic.</p>'
        }</section>`
          : ''
      }
      <p><a href="/for-me">See your followed activity</a> · <a href="/my">Manage follows</a></p>`,
        town,
        current,
      ),
    );
  });

  app.post('/interests/follow', async (c) => {
    const current = await currentUser(c);
    if (!current) return c.redirect('/login?next=%2Finterests', 303);
    const form = await c.req.parseBody();
    if (!accounts.verifyCsrf(current, String(form['csrf'] ?? '')))
      return c.text('Reload this form and try again.', 403);
    const town = townFor(c);
    const selected = choice(String(form['kind'] ?? ''), String(form['value'] ?? '').trim(), town);
    if (!selected) return c.text('Choose a valid topic, board, search, or matter.', 400);
    if (form['remove'] === '1')
      await accounts.removeSubscription(current, selected.kind, selected.value, town.id);
    else await accounts.addSubscription(current, selected);
    return c.redirect(withTown('/interests', town, { kind: selected.kind, value: selected.value }), 303);
  });

  app.get('/for-me', async (c) => {
    const town = townFor(c);
    const current = await currentUser(c);
    c.header('cache-control', 'private, no-store');
    if (!current)
      return c.html(
        page(
          `<section class="view-intro"><p class="eyebrow">For me</p>
      <h1>Build your picture of local life</h1><p>Start with a few topics, a board, or a place you care about.</p></section>
      <p><a href="${esc(withTown('/interests', town))}">Explore interests and preview records</a></p>
      <p><a href="/login?next=%2Ffor-me">Sign in to see your follows</a>, or browse
      <a href="${esc(withTown('/nearby', town))}">Nearby</a> without an account.</p>`,
          town,
          current,
        ),
      );
    const subscriptions = await accounts.listSubscriptions(current);
    const rows = personalFeed(db, subscriptions, { limit: 40 });
    const reasons = new Map<string, string[]>();
    for (const subscription of subscriptions) {
      for (const row of personalFeed(db, [subscription], { eventIds: rows.map((r) => r.id), limit: 40 })) {
        reasons.set(row.id, [
          ...(reasons.get(row.id) ?? []),
          `${subscription.label} (${subscription.jurisdiction === '*' ? 'all towns' : subscription.jurisdiction})`,
        ]);
      }
    }
    const cards = rows
      .map(
        (row) => `<section><p class="match-reason">Following: ${esc(reasons.get(row.id)?.join(' · '))}</p>
      ${eventCard(row, { ...EMPTY_FILTERS, town: row.jurisdiction })}</section>`,
      )
      .join('');
    const start = readCookie(c.req.header('cookie'), 'towncivic_start') ?? 'activity';
    return c.html(
      page(
        `<section class="view-intro"><p class="eyebrow">For me</p><h1>Your followed activity</h1>
      <p>Up to 40 matching records across your followed towns, ordered by event date.
      This is not a list of changes since your last visit.</p></section>
      <p><a href="${esc(withTown('/interests', town))}">Add an interest</a> · <a href="/my">Manage follows</a> ·
      <a href="${esc(withTown('/', town))}">Explore all activity</a></p>
      <form method="post" action="/interests/start" class="search">
        ${hidden('csrf', current.csrfToken)}
        <label for="starting-view">Start here on this browser</label>
        <select name="view" id="starting-view">${Object.keys(STARTS)
          .map(
            (key) =>
              `<option value="${key}"${key === start ? ' selected' : ''}>${key === 'personal' ? 'For me' : key[0]!.toUpperCase() + key.slice(1)}</option>`,
          )
          .join('')}</select>
        <button>Save starting view</button>
      </form><p class="count">Used when you open the townCivic home link. Direct Activity and Nearby links keep their destination.</p>
      ${cards || '<div class="empty"><p>No matching records yet. Add an interest or browse all activity; an empty feed does not mean nothing is happening.</p></div>'}`,
        town,
        current,
      ),
    );
  });

  app.post('/interests/start', async (c) => {
    const current = await currentUser(c);
    const form = await c.req.parseBody();
    if (!accounts.verifyCsrf(current, String(form['csrf'] ?? '')))
      return c.text('Reload this form and try again.', 403);
    const view = String(form['view'] ?? '');
    if (!Object.hasOwn(STARTS, view)) return c.text('Invalid starting view.', 400);
    c.header(
      'set-cookie',
      `towncivic_start=${view}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`,
      { append: true },
    );
    return c.redirect('/start', 303);
  });
}
