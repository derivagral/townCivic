import { createHash } from 'node:crypto';
// Imported for its side effect: installing the proxy dispatcher on the global
// `fetch`. Its own `fetchSource` is not used — that one waits a second between
// requests to the same host, which is right for a town's web server and wrong
// for an object store.
import '../fetch/http.ts';
import { config } from '../config.ts';
import { EMPTY_SHA256, amzDate, sha256Hex, signV4 } from './sigv4.ts';
import {
  DocumentStoreUnavailableError,
  contentTypeFor,
  type DocumentStore,
  type StoreCheck,
  type StoredObject,
} from './store.ts';

/**
 * The archive in any S3-compatible object store.
 *
 * Deliberately not a provider integration. Cloudflare R2, Tigris, Backblaze B2,
 * MinIO and AWS all speak the same four verbs, and the reason to use an object
 * store rather than a platform's bundled storage add-on is precisely that the
 * bucket outlives the decision about where the app runs. So the configuration
 * is an endpoint and a key pair, and nothing here knows or cares which of them
 * is on the other end.
 *
 * No SDK, for the reason `accounts/supabase.ts` has none: the default install
 * writes to a local directory and needs none of this, and `@aws-sdk/client-s3`
 * is several dozen packages to sign a PUT. Signing is in `sigv4.ts`, pinned
 * against AWS's own published test vectors.
 *
 * Addressing follows one rule rather than a flag. With `S3_ENDPOINT` set, paths
 * are `<endpoint>/<bucket>/<key>` — which is what R2, Tigris, B2 and MinIO all
 * want. Without it, the bucket goes in the hostname, which is what AWS wants
 * for buckets created since 2020.
 */

export interface S3DocumentOptions {
  bucket?: string | undefined;
  /** `https://<account>.r2.cloudflarestorage.com`, etc. Omit for AWS proper. */
  endpoint?: string | undefined;
  region?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** For temporary credentials; passed through as `x-amz-security-token`. */
  sessionToken?: string | undefined;
  /** Injected by tests. Production uses the global, proxy-aware `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected by tests, so a signature can be pinned to a fixed clock. */
  now?: () => Date;
}

export function createS3Documents(options: S3DocumentOptions = {}): DocumentStore {
  const bucket = options.bucket ?? config.s3Bucket;
  const endpoint = (options.endpoint ?? config.s3Endpoint ?? '').replace(/\/+$/, '');
  // R2 wants `auto`; AWS wants a real region. Both are just a string in the
  // signature's credential scope, and it has to match what the server expects.
  const region = options.region ?? config.s3Region ?? 'auto';
  const accessKeyId = options.accessKeyId ?? config.s3AccessKeyId;
  const secretAccessKey = options.secretAccessKey ?? config.s3SecretAccessKey;
  const sessionToken = options.sessionToken ?? config.s3SessionToken;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  if (!bucket) {
    throw new DocumentStoreUnavailableError(
      'The s3 document store needs S3_BUCKET. Unset TOWNCIVIC_DOCUMENTS to fall back to local files.',
    );
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new DocumentStoreUnavailableError(
      'The s3 document store needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    );
  }

  /** Where one key lives: path-style against an endpoint, virtual-host on AWS. */
  const urlFor = (key: string): URL =>
    endpoint
      ? new URL(`${endpoint}/${bucket}/${key}`)
      : new URL(`https://${bucket}.s3.${region}.amazonaws.com/${key}`);

  async function send(
    method: string,
    key: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response | null> {
    const url = urlFor(key);
    const date = amzDate(now());
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': date,
      // S3 requires the payload digest as a header as well as in the signature,
      // so the server can verify the body it received is the body that was signed.
      'x-amz-content-sha256': payloadHash,
      ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
      ...extraHeaders,
    };

    const { authorization } = signV4({
      method,
      url,
      headers,
      payloadHash,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      region,
      service: 's3',
      amzDate: date,
    });

    try {
      return await doFetch(url, {
        method,
        // `host` is set by the runtime and is forbidden as an explicit fetch
        // header, but it still has to be *signed* — hence signing the full set
        // above and sending it minus that one.
        headers: { ...omitHost(headers), authorization },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch {
      return null;
    }
  }

  const omitHost = (headers: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));

  const describeTarget = endpoint ? `${endpoint}/${bucket}` : `s3://${bucket} (${region})`;

  return {
    kind: 's3',

    describe() {
      return `s3 — ${describeTarget}, so the pipeline needs no persistent disk`;
    },

    async put(key, body, contentType) {
      const id = createHash('sha256').update(body).digest('hex');

      // Content-addressed, so an object that is already there is byte-identical
      // and re-uploading it would only cost a request. One HEAD is cheaper than
      // one PUT of a 300 KB PDF, and most runs re-see documents they have.
      if (await this.has(key)) return { id, key, bytes: body.byteLength, isNew: false };

      const response = await send('PUT', key, body, {
        'content-type': contentType ?? contentTypeFor(key),
        'content-length': String(body.byteLength),
      });
      if (!response?.ok) {
        throw new DocumentStoreUnavailableError(
          `could not store ${key}: ${response ? `HTTP ${response.status} ${await safeText(response)}` : 'unreachable'}`,
        );
      }
      return { id, key, bytes: body.byteLength, isNew: true } satisfies StoredObject;
    },

    async has(key) {
      const response = await send('HEAD', key);
      return response?.ok ?? false;
    },

    async get(key) {
      const response = await send('GET', key);
      if (!response?.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    },

    async check(): Promise<StoreCheck> {
      const findings: StoreCheck['findings'] = [
        { label: 'backend', ok: true, detail: `s3 — ${describeTarget}` },
      ];

      // A round trip through a key nothing else uses. This is the only probe
      // that proves the credentials, the signature, the region and the bucket
      // policy are all simultaneously right — any one of them wrong and the
      // pipeline would fail on its first real upload instead.
      const key = '_towncivic/check';
      const payload = new TextEncoder().encode(`towncivic ${new Date().toISOString()}`);

      const written = await send('PUT', key, payload, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(payload.byteLength),
      });
      findings.push({
        label: 'write',
        ok: Boolean(written?.ok),
        detail: written?.ok
          ? 'wrote a probe object'
          : written
            ? `HTTP ${written.status} ${await safeText(written)}`
            : 'unreachable — check S3_ENDPOINT',
      });

      if (written?.ok) {
        const read = await send('GET', key);
        const same = read?.ok && Buffer.from(await read.arrayBuffer()).equals(Buffer.from(payload));
        findings.push({
          label: 'read',
          ok: Boolean(same),
          detail: same ? 'read it back byte for byte' : 'wrote, but could not read the same bytes back',
        });

        const removed = await send('DELETE', key);
        findings.push({
          label: 'delete',
          // Not fatal: a write-only bucket policy is a legitimate way to run
          // this, since the pipeline never deletes anything either.
          ok: true,
          detail: removed?.ok
            ? 'cleaned the probe up'
            : 'left the probe behind — no delete permission, which the pipeline does not need',
        });
      }

      return { ok: findings.every((finding) => finding.ok), findings };
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    // S3 errors are XML; the useful part is the <Code>, so pull that out when
    // it is there rather than printing a document at somebody.
    const text = (await response.text()).slice(0, 500);
    return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? text;
  } catch {
    return '';
  }
}
