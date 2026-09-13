import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { openDb } from '../src/db/index.ts';
import { createApp } from '../src/web/server.ts';
import { accessLog, logErrors } from '../src/web/logging.ts';
import { createSupabaseAccounts } from '../src/accounts/index.ts';
import { fakeSupabase } from './helpers/fake-supabase.ts';

/**
 * What the server says, and to whom.
 *
 * Written after a sign-up failed on the deployed site and left no trace: the
 * browser showed `POST /signup 400`, the page printed "Gateway timeout" under
 * the email field, and `fly logs` was empty — which reads like the request never
 * arrived at all. Both halves of that were wrong, and both are fixed here.
 */

function setup(options: { accessLog?: (line: string) => void } = {}) {
  const db = openDb(':memory:');
  const backend = fakeSupabase();
  const accounts = createSupabaseAccounts({
    url: 'https://project.supabase.test',
    anonKey: 'anon-key',
    sessionSecret: 'test-session-secret',
    fetchImpl: backend.fetch,
  });
  const app = createApp(db, {
    accounts,
    jurisdictions: ['milton-ma'],
    ...(options.accessLog ? { accessLog: options.accessLog } : {}),
  });
  return { db, app, backend };
}

const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values),
});

describe('the access log', () => {
  it('writes one line per request, with the status and how long it took', async () => {
    const lines: string[] = [];
    const { db, app } = setup({ accessLog: (line) => lines.push(line) });
    try {
      await app.request('/?town=milton-ma');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[http\] GET \/\?town=milton-ma 200 \d+ms$/);
    } finally {
      db.close();
    }
  });

  it('keeps a feed token out of the log', async () => {
    const lines: string[] = [];
    const { db, app } = setup({ accessLog: (line) => lines.push(line) });
    try {
      // A personal feed is addressed by a bearer token. Writing one down turns
      // the log into a set of credentials.
      await app.request('/feeds/my/deadbeefdeadbeefdeadbeef.atom');
      expect(lines[0]).toContain('/feeds/my/[token].atom');
      expect(lines[0]).not.toContain('deadbeef');
    } finally {
      db.close();
    }
  });

  it('stays quiet about the health check until it stops working', async () => {
    const lines: string[] = [];
    const { db, app } = setup({ accessLog: (line) => lines.push(line) });
    try {
      // Fly hits this every 30 seconds; at a line each it would be most of the
      // log and none of the information.
      await app.request('/healthz');
      await app.request('/styles.css');
      expect(lines).toEqual([]);

      // A path nobody routed, on the other hand, is worth knowing about.
      await app.request('/no-such-page');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('404');
    } finally {
      db.close();
    }
  });

  it('logs a handler that throws, and does not show the reader the stack', async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const app = new Hono();
    app.use('*', accessLog({ write }));
    app.onError(logErrors(write));
    app.get('/boom', () => {
      throw new Error('the database went away');
    });

    const response = await app.request('/boom');
    expect(response.status).toBe(500);

    // A stack trace on a public page is useless to the reader and a gift to
    // everybody else; it belongs in the log, which is where it now is.
    const page = await response.text();
    expect(page).not.toContain('the database went away');
    expect(lines.some((line) => line.includes('threw: Error: the database went away'))).toBe(true);
    // And the request itself is still accounted for, with the status the reader
    // actually got.
    expect(lines.some((line) => /GET \/boom 500 \d+ms/.test(line))).toBe(true);
  });
});

describe('a sign-up the hosted backend cannot answer', () => {
  it('says the store is down, rather than printing the gateway at the reader', async () => {
    const lines: string[] = [];
    const upstream = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, app, backend } = setup({ accessLog: (line) => lines.push(line) });
    try {
      // What Supabase's gateway actually returned: it gives up on GoTrue after
      // about five seconds, and sign-up is the request that waits on a mailer.
      backend.fail(504);

      const response = await app.request(
        '/signup',
        form({ email: 'reader@example.com', password: 'correct-horse-battery', displayName: '' }),
      );

      // Not a 400. The form was fine; the project was not.
      expect(response.status).toBe(503);
      const page = await response.text();
      expect(page).toContain('temporarily unavailable');
      expect(page).not.toContain('Gateway timeout');
      // The email survives the round trip, so nobody retypes it.
      expect(page).toContain('reader@example.com');

      // And the reason is written down twice: once as the request that failed,
      // once as the upstream call that failed it.
      expect(lines.some((line) => line.includes('POST /signup 503'))).toBe(true);
      expect(upstream).toHaveBeenCalledWith(expect.stringContaining('/auth/v1/signup'));
    } finally {
      upstream.mockRestore();
      db.close();
    }
  });

  it('still puts a rejected form back in front of the reader as a 400', async () => {
    const { db, app } = setup();
    try {
      const response = await app.request('/signup', form({ email: 'nope', password: 'short' }));
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/email address/i);
    } finally {
      db.close();
    }
  });
});
