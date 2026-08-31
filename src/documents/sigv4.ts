import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for the four requests this repo makes.
 *
 * Hand-written rather than pulled in, for the same reason `accounts/supabase.ts`
 * talks to PostgREST directly: townCivic's default install stores documents on
 * the local disk and needs none of this, and the alternative — `@aws-sdk/client-s3`
 * — is several dozen packages to sign a PUT.
 *
 * Signing is the one place in that argument where "write it yourself" deserves
 * a second look, because a subtly wrong signature is not something you can eyeball.
 * So it is pinned: `test/sigv4.test.ts` runs the `get-vanilla` case from AWS's own
 * signature test suite and checks the whole `Authorization` header, byte for byte,
 * against the value AWS publishes. An implementation that reproduces a specific
 * published 256-bit signature is not accidentally close to right.
 *
 * The failure mode is loud in any case: a bad signature is a 403
 * `SignatureDoesNotMatch` on the first upload, which `towncivic documents` will
 * report before any pipeline run depends on it.
 *
 * Scope is deliberately narrow — single-shot requests with a known payload. No
 * chunked upload signing, no presigned URLs, no STS session tokens beyond
 * passing one through as a header.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');

/** The empty body's digest, which is most of our requests. */
export const EMPTY_SHA256 = sha256Hex('');

/**
 * Percent-encode one path segment per RFC 3986.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so those are
 * finished off by hand. The keys this repo signs are hex and slashes, so none of
 * it comes up in practice — but a signer that is only right for the inputs it
 * happens to see is a trap for whoever adds the next one.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical URI.
 *
 * Each segment is encoded and the slashes are kept. S3 signs the path exactly
 * once — unlike most AWS services, which encode it a second time — and this is
 * the S3 spelling.
 *
 * The decode is not redundant. `URL` hands back a pathname that is *partly*
 * encoded already: it escapes a space to `%20` but leaves `&` alone, because
 * both are legal there. Encoding that directly turns `%20` into `%2520` and
 * signs a path the server never saw. So each segment is brought back to its
 * literal form first, and encoded exactly once from there.
 */
function canonicalUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => {
      let literal = segment;
      try {
        literal = decodeURIComponent(segment);
      } catch {
        // A stray `%` that is not an escape. Sign what is actually there.
      }
      return encodeSegment(literal);
    })
    .join('/');
}

/** Query parameters, sorted by name then value, encoded the way AWS expects. */
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [...url.searchParams].map(([name, value]) => [
    encodeSegment(name),
    encodeSegment(value),
  ]);
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

export interface SignInput {
  method: string;
  url: URL;
  /**
   * Every header to sign, `host` included. Exactly these are signed, so the
   * caller decides what goes in — which is what lets the test reproduce AWS's
   * own vectors, whose signed set does not include the S3-only headers.
   */
  headers: Record<string, string>;
  /** Hex sha256 of the request body. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`. The caller formats it so a test can pin the clock. */
  amzDate: string;
}

/** The `Authorization` header value, and the pieces it was built from. */
export interface Signature {
  authorization: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
}

export function signV4(input: SignInput): Signature {
  const date = input.amzDate.slice(0, 8);

  // Lower-cased names, collapsed whitespace in values, sorted by name. The
  // sorted order is shared between the canonical headers and the signed-headers
  // list, so they are derived from one array rather than two.
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  // The signing key is derived once per date/region/service rather than from
  // the secret directly, which is what makes it safe to cache and scope.
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization:
      `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
    stringToSign,
  };
}

/** `YYYYMMDDTHHMMSSZ`, which is an ISO timestamp with the punctuation removed. */
export function amzDate(when: Date): string {
  return `${when.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}
