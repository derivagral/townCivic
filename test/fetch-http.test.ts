import { describe, expect, it, vi } from 'vitest';
import { fetchSource } from '../src/fetch/http.ts';

vi.mock('../src/config.ts', async (original) => {
  const real = await original<typeof import('../src/config.ts')>();
  return { ...real, config: { ...real.config, perHostDelayMs: 0 } };
});

describe('HTTP challenge diagnostics', () => {
  it.each([200, 202, 403, 503])(
    'rejects an HTTP %i Cloudflare challenge without retries or reading its body',
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: {
          'cf-mitigated': 'challenge',
          'cf-ray': 'a3ed067abfbf74e4-DFW',
          'content-type': 'text/html',
          'set-cookie': 'secret-token',
        },
      });
      const read = vi.spyOn(response, 'text');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      const result = await fetchSource('test', 'https://example.test/agenda', { fetchImpl, maxRetries: 3 });
      expect(result).toMatchObject({
        ok: false,
        status,
        notModified: false,
        body: '',
        error: `HTTP ${status} — Cloudflare challenge (cf-ray: a3ed067abfbf74e4-DFW)`,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain('secret-token');
    },
  );

  it('does not attribute an ordinary 403 to a Cloudflare challenge', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Denied', {
        status: 403,
        headers: { server: 'cloudflare', 'cf-ray': 'a3ed067abfbf74e4-DFW' },
      }),
    );
    const result = await fetchSource('test', 'https://example.test/agenda', { fetchImpl });
    expect(result.error).toBe('HTTP 403 (cf-ray: a3ed067abfbf74e4-DFW)');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not copy arbitrary header content into the diagnostic', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'unexpected secret value' },
      }),
    );
    expect((await fetchSource('test', 'https://example.test/agenda', { fetchImpl })).error).toBe(
      'HTTP 403 — Cloudflare challenge',
    );
  });

  it('still returns successful Cloudflare-served content and honors conditional requests', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Agenda', { headers: { server: 'cloudflare' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await fetchSource('test', 'https://example.test/agenda', { fetchImpl })).toMatchObject({
      ok: true,
      status: 200,
      body: 'Agenda',
    });
    expect(
      await fetchSource('test', 'https://example.test/agenda', { fetchImpl, etag: 'good' }),
    ).toMatchObject({ ok: true, status: 304, notModified: true, body: '' });
    expect(fetchImpl.mock.calls[1]![1]!.headers).toHaveProperty('if-none-match', 'good');
  });
});
