import type { ErrorHandler, MiddlewareHandler } from 'hono';

/**
 * What the server says about the requests it served.
 *
 * There was nothing here until a sign-up failed in production and the only
 * evidence anywhere was a `400` in somebody's browser. The page itself rendered
 * the reason — the form comes back with the error printed on it — but a reason
 * that exists only in a response body is a reason nobody can go back and read.
 * Fly showed an empty log, which invited exactly the wrong conclusion: that the
 * request never arrived.
 *
 * So: one line per request, on stdout, with the four things that turn "signing
 * up is broken" into a bug report — what was asked for, what came back, how long
 * it took, and (for a throw) the stack.
 *
 * Deliberately not a log framework, not JSON, and not a request id. This is a
 * single machine serving a town's public records; `fly logs` is the reader, and
 * a line a person can scan beats a structure a person has to parse. The moment
 * there is somewhere to ship logs *to*, this is the one file that has to change.
 */

/** Where a line goes. `status` so the default can pick stdout or stderr. */
export type LogSink = (line: string, status: number) => void;

const toConsole: LogSink = (line, status) => {
  // 5xx on stderr so a platform that separates the two shows them apart, and so
  // `fly logs` colours them. Everything else is ordinary traffic.
  if (status >= 500) console.error(line);
  else console.log(line);
};

/**
 * Paths that are quiet while they work.
 *
 * The Fly health check hits `/healthz` every 30 seconds and every page pulls
 * `/styles.css`, so logging both would bury the requests somebody actually
 * cares about under a few thousand a day that say nothing. They are only
 * skipped while they succeed: a health check that starts failing, or a
 * stylesheet that 500s, is exactly the thing this file exists to show.
 */
const QUIET = new Set(['/healthz', '/styles.css']);

/**
 * A personal feed is addressed by a bearer token in its own URL, which is the
 * one thing on this server that must never be written down. Redact the token
 * and keep the shape, so the line still says "somebody read a personal feed".
 */
export function scrubPath(path: string): string {
  return path.startsWith('/feeds/my/') ? '/feeds/my/[token].atom' : path;
}

export interface AccessLogOptions {
  /** Where lines go. Defaults to the console. */
  write?: LogSink;
  /** Log `/healthz` and `/styles.css` too, even when they succeed. */
  verbose?: boolean;
}

/**
 * One line per request: `[http] POST /signup 503 5452ms`.
 *
 * The query string is kept — which filter produced a slow page is most of the
 * question on this site — and the path is scrubbed of feed tokens first.
 */
export function accessLog(options: AccessLogOptions = {}): MiddlewareHandler {
  const write = options.write ?? toConsole;

  return async (c, next) => {
    const started = performance.now();
    // If the handler throws, this is what the reader gets: `onError` below
    // turns a throw into a 500, and the line should say so rather than claim
    // whatever `c.res` happened to hold.
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      const url = new URL(c.req.url);
      if (!(QUIET.has(url.pathname) && status < 400) || options.verbose) {
        const ms = Math.round(performance.now() - started);
        write(`[http] ${c.req.method} ${scrubPath(url.pathname)}${url.search} ${status} ${ms}ms`, status);
      }
    }
  };
}

/**
 * What a throw out of a handler looks like.
 *
 * Hono's own default answers 500 and says nothing anywhere, which is the same
 * silence the access log above was written to end. The stack goes to the
 * operator; the reader gets a sentence, because a stack trace on a public page
 * is both useless to them and a gift to everybody else.
 */
export function logErrors(write: LogSink = toConsole): ErrorHandler {
  return (error, c) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    write(`[http] ${c.req.method} ${scrubPath(new URL(c.req.url).pathname)} threw: ${detail}`, 500);
    return c.text('Something went wrong on our end. The records are still here — try again.', 500);
  };
}
