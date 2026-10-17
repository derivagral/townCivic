import type { LoginResponse } from '@towncivic/api-contracts';

export interface TokenStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}
export class ApiFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export function validateApiUrl(value: string | undefined, development: boolean): string {
  if (!value)
    throw new Error('This build needs a TownCivic server address. Set EXPO_PUBLIC_API_URL and rebuild.');
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && !(development && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Use an HTTPS server origin, with no path, credentials, or query string. HTTP is allowed only in development.',
    );
  }
  return url.origin;
}

/** Serialize authenticated calls so rotated refresh credentials are persisted
 * before the next request, including a concurrent sign-in/sign-out. */
export function createClient(origin: string, storage: TokenStorage, fetcher: typeof fetch = fetch) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }
  async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(`${origin}/api/v1${path}`, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const rotated = response.headers.get('x-towncivic-session');
      if (token && rotated) await storage.set(rotated);
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new ApiFailure(
          'This server does not provide the mobile API yet. Deploy the feature-branch backend first.',
          response.status,
        );
      }
      const data = await response.json();
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'Unable to load this record.';
        throw new ApiFailure(message, response.status);
      }
      return data as T;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (controller.signal.aborted) throw new Error('The server took too long to respond. Please retry.');
      throw new Error('Could not reach TownCivic. Check your connection and retry.');
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    get: <T>(path: string) => request<T>(path),
    authenticated: <T>(path: string, method = 'GET') =>
      serial(async () => {
        const token = await storage.get();
        if (!token) throw new ApiFailure('Please sign in to follow timelines.', 401);
        return request<T>(path, { method }, token);
      }),
    signIn: (email: string, password: string) =>
      serial(async () => {
        const result = await request<LoginResponse>('/session', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        await storage.set(result.token);
      }),
    signOut: () =>
      serial(async () => {
        const token = await storage.get();
        // On transport failure retain the session so revocation can be retried.
        try {
          if (token) await request('/session', { method: 'DELETE' }, token);
        } catch (error) {
          if (!(error instanceof ApiFailure && error.status === 401)) throw error;
        }
        await storage.clear();
      }),
  };
}
export type ApiClient = ReturnType<typeof createClient>;
