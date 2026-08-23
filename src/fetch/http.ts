import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { config } from '../config.ts';
import type { FetchResult } from '../types.ts';

/**
 * Route `fetch` through an HTTP proxy when the environment names one.
 *
 * Node's global fetch ignores `HTTPS_PROXY` unless the runtime was started with
 * `--use-env-proxy`, which a library cannot set for its caller. Wiring the
 * dispatcher explicitly means the crawler works the same on a laptop, in CI and
 * behind a corporate or sandbox proxy, with no flags to remember.
 */
function installProxy(): string | null {
  const proxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return null;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    return proxy;
  } catch {
    return null;
  }
}

export const activeProxy = installProxy();

const lastHitByHost = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep one request per host per `perHostDelayMs`. These are small town servers. */
async function politeWait(url: string): Promise<void> {
  const host = new URL(url).host;
  const last = lastHitByHost.get(host);
  if (last !== undefined) {
    const wait = config.perHostDelayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastHitByHost.set(host, Date.now());
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchOptions {
  etag?: string | undefined;
  lastModified?: string | undefined;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

/**
 * Conditional, retrying GET.
 *
 * A 304 comes back as `ok: true, notModified: true` with an empty body — the
 * caller decides whether that means "skip" or "reparse the stored document".
 */
export async function fetchSource(
  sourceId: string,
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? config.maxRetries;

  const headers: Record<string, string> = {
    'user-agent': config.userAgent,
    accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (options.etag) headers['if-none-match'] = options.etag;
  if (options.lastModified) headers['if-modified-since'] = options.lastModified;

  const base: Omit<FetchResult, 'ok' | 'status' | 'body'> = {
    sourceId,
    url,
    notModified: false,
    contentType: null,
    etag: null,
    lastModified: null,
  };

  let lastError = 'unknown error';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 500);
    await politeWait(url);

    try {
      const response = await doFetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      const meta = {
        ...base,
        contentType: response.headers.get('content-type'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };

      if (response.status === 304) {
        return { ...meta, ok: true, status: 304, notModified: true, body: '' };
      }
      if (RETRYABLE.has(response.status)) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      if (!response.ok) {
        return { ...meta, ok: false, status: response.status, body: '', error: `HTTP ${response.status}` };
      }
      return { ...meta, ok: true, status: response.status, body: await response.text() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ...base, ok: false, status: 0, body: '', error: lastError };
}
