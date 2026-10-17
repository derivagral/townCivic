import { describe, expect, it } from 'vitest';
import { createClient, validateApiUrl } from '../apps/mobile/src/lib/client.ts';

describe('mobile transport', () => {
  it('serializes refreshes and uses the rotated token for the next call', async () => {
    let token: string | null = 'old';
    const seen: (string | null)[] = [];
    const client = createClient(
      'https://example.test',
      {
        get: async () => token,
        set: async (t) => {
          await Promise.resolve();
          token = t;
        },
        clear: async () => {
          token = null;
        },
      },
      async (_url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        expect(init?.credentials).toBe('omit');
        expect(init?.redirect).toBe('error');
        return new Response('{}', {
          headers: { 'content-type': 'application/json', 'x-towncivic-session': 'new' },
        });
      },
    );
    await Promise.all([client.authenticated('/session'), client.authenticated('/following')]);
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    await client.get('/catalog');
    expect(seen[2]).toBeNull();
    await client.signOut();
    expect(token).toBeNull();
  });
  it('keeps credentials on transient failure and explains an older HTML-only backend', async () => {
    let token: string | null = 'saved';
    const storage = {
      get: async () => token,
      set: async (t: string) => {
        token = t;
      },
      clear: async () => {
        token = null;
      },
    };
    const failed = createClient('https://example.test', storage, async () => {
      throw new Error('offline');
    });
    await expect(failed.signOut()).rejects.toThrow('connection');
    expect(token).toBe('saved');
    const old = createClient(
      'https://example.test',
      storage,
      async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    await expect(old.get('/catalog')).rejects.toThrow('Deploy the feature-branch backend');
  });
  it('refuses insecure release endpoints, credentials and URL redirection', () => {
    expect(validateApiUrl('http://192.168.1.10:8787', true)).toBe('http://192.168.1.10:8787');
    expect(validateApiUrl('https://towncivic.example/', false)).toBe('https://towncivic.example');
    for (const url of [
      undefined,
      'http://example.test',
      'https://user:pass@example.test',
      'https://example.test/path',
      'https://example.test?token=secret',
    ]) {
      expect(() => validateApiUrl(url, false)).toThrow();
    }
  });
});
