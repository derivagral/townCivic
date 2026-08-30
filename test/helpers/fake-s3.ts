import { EMPTY_SHA256, sha256Hex, signV4 } from '../../src/documents/sigv4.ts';

/**
 * An S3-compatible bucket, in memory.
 *
 * The important thing about this fake is that it **verifies the signature** by
 * recomputing it from the request it received, exactly as a real endpoint does.
 * A fake that accepted any `Authorization` header would pass whatever we sent
 * and tell us nothing — and the signature is the one part of an S3 client that
 * cannot be checked by reading it.
 *
 * That check is only as good as the signer it shares, which is why
 * `test/sigv4.test.ts` pins that signer against AWS's own published vectors
 * first. Together they say: the signer computes what AWS says it should, and
 * the client feeds the signer the right request.
 */

export interface FakeS3Options {
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  /** Reject every request with this status; 0 means the connection fails. */
}

export interface FakeS3 {
  fetch: typeof fetch;
  /** Keys currently in the bucket. */
  keys(): string[];
  /** The raw bytes stored under a key. */
  body(key: string): Uint8Array | undefined;
  /** Content types, as the client set them. */
  contentType(key: string): string | undefined;
  /** Answer everything with this status; 0 means the connection fails. */
  fail(status: number): void;
  /** Refuse DELETE, the way a write-only bucket policy would. */
  denyDelete(): void;
  /** How many requests of each method have arrived. */
  counts(): Record<string, number>;
}

const DEFAULTS = {
  bucket: 'towncivic-test',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example-key',
  region: 'auto',
};

export function fakeS3(options: FakeS3Options = {}): FakeS3 {
  const settings = { ...DEFAULTS, ...options };
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const counts: Record<string, number> = {};
  let failStatus: number | null = null;
  let deleteDenied = false;

  const error = (code: string, status: number) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, {
      status,
      headers: { 'content-type': 'application/xml' },
    });

  /**
   * Recompute the signature from what actually arrived.
   *
   * The client omits `host` from the headers it hands to `fetch` — the runtime
   * sets that — so it is reconstructed from the URL here, which is also what a
   * real server does.
   */
  async function verify(request: Request, url: URL, body: Uint8Array | null): Promise<Response | null> {
    const authorization = request.headers.get('authorization');
    if (!authorization) return error('AccessDenied', 403);

    const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
    const amzDate = request.headers.get('x-amz-date');
    if (!amzDate) return error('AccessDenied', 403);

    const headers: Record<string, string> = {};
    for (const name of signedHeaders) {
      headers[name] = name === 'host' ? url.host : (request.headers.get(name) ?? '');
    }

    // S3 requires the body digest as a header, and requires it to be the real
    // one. Checking it here is what would catch a client that signed one body
    // and sent another.
    const declared = request.headers.get('x-amz-content-sha256');
    const actual = body ? sha256Hex(body) : EMPTY_SHA256;
    if (declared !== actual) return error('XAmzContentSHA256Mismatch', 400);

    const expected = signV4({
      method: request.method,
      url,
      headers,
      payloadHash: actual,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: settings.region,
      service: 's3',
      amzDate,
    });

    return expected.authorization === authorization ? null : error('SignatureDoesNotMatch', 403);
  }

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    counts[request.method] = (counts[request.method] ?? 0) + 1;

    const body = request.method === 'PUT' ? new Uint8Array(await request.clone().arrayBuffer()) : null;

    const rejection = await verify(request, url, body);
    if (rejection) return rejection;

    // Path-style addressing: /<bucket>/<key...>
    const [, bucket, ...rest] = url.pathname.split('/');
    if (bucket !== settings.bucket) return error('NoSuchBucket', 404);
    const key = rest.join('/');

    switch (request.method) {
      case 'PUT':
        objects.set(key, {
          body: body!,
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        });
        return new Response(null, { status: 200, headers: { etag: `"${sha256Hex(body!)}"` } });

      case 'HEAD': {
        const found = objects.get(key);
        return found
          ? new Response(null, { status: 200, headers: { 'content-length': String(found.body.byteLength) } })
          : new Response(null, { status: 404 });
      }

      case 'GET': {
        const found = objects.get(key);
        if (!found) return error('NoSuchKey', 404);
        return new Response(Buffer.from(found.body), {
          status: 200,
          headers: { 'content-type': found.contentType },
        });
      }

      case 'DELETE':
        if (deleteDenied) return error('AccessDenied', 403);
        objects.delete(key);
        return new Response(null, { status: 204 });

      default:
        return error('MethodNotAllowed', 405);
    }
  };

  return {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as Request, init);
      if (failStatus === 0) throw new TypeError('fetch failed');
      if (failStatus !== null) return error('InternalError', failStatus);
      return handle(request);
    }) as typeof fetch,

    keys: () => [...objects.keys()].sort(),
    body: (key) => objects.get(key)?.body,
    contentType: (key) => objects.get(key)?.contentType,
    fail(status) {
      failStatus = status;
    },
    denyDelete() {
      deleteDenied = true;
    },
    counts: () => ({ ...counts }),
  };
}

export const FAKE_S3_CREDENTIALS = DEFAULTS;
