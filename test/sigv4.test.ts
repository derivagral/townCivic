import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, amzDate, signV4 } from '../src/documents/sigv4.ts';

/**
 * The signer, against AWS's own published vectors.
 *
 * This is the file that earns the decision not to install an SDK. A signature
 * cannot be reviewed by reading it, so the check has to be that an independent
 * implementation reproduces a value AWS published — matching a specific 256-bit
 * number is not something a nearly-correct implementation does.
 *
 * The credentials below are AWS's documented test credentials, not anybody's:
 * `AKIDEXAMPLE` and its secret appear verbatim in the signature test suite for
 * exactly this purpose.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
};

describe('sigv4, against the published test suite', () => {
  it('reproduces get-vanilla byte for byte', () => {
    const signature = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com', 'x-amz-date': CREDENTIALS.amzDate },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });

    expect(signature.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('builds the canonical request the suite describes', () => {
    const { canonicalRequest, stringToSign } = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com', 'x-amz-date': CREDENTIALS.amzDate },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });

    // Spelled out because every one of these newlines is load-bearing: the
    // canonical headers block ends with one, and the signed-headers line does not.
    expect(canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(stringToSign.split('\n')[2]).toBe('20150830/us-east-1/service/aws4_request');
  });

  it('sorts and lower-cases headers, and collapses their whitespace', () => {
    // AWS's `get-header-value-trim` case: the signature is over the trimmed,
    // whitespace-collapsed value, not the one on the wire.
    const spaced = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {
        HOST: 'example.amazonaws.com',
        'X-Amz-Date': CREDENTIALS.amzDate,
        'My-Header': '  a   b  c  ',
      },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });
    const tidy = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com', 'x-amz-date': CREDENTIALS.amzDate, 'my-header': 'a b c' },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });

    expect(spaced.signedHeaders).toBe('host;my-header;x-amz-date');
    expect(spaced.authorization).toBe(tidy.authorization);
  });

  it('sorts query parameters by name, then by value', () => {
    const { canonicalRequest } = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/?b=2&a=1&a=0'),
      headers: { host: 'example.amazonaws.com', 'x-amz-date': CREDENTIALS.amzDate },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });
    expect(canonicalRequest.split('\n')[2]).toBe('a=0&a=1&b=2');
  });

  it('encodes a key with characters a document store can produce', () => {
    // Our keys are hex and slashes today. This pins the behaviour for whoever
    // stores something with a space or an ampersand in it later.
    const { canonicalRequest } = signV4({
      method: 'PUT',
      url: new URL('https://bucket.example.com/docs/a b&c/d.pdf'),
      headers: { host: 'bucket.example.com', 'x-amz-date': CREDENTIALS.amzDate },
      payloadHash: EMPTY_SHA256,
      ...CREDENTIALS,
    });
    expect(canonicalRequest.split('\n')[1]).toBe('/docs/a%20b%26c/d.pdf');
  });

  it('formats the timestamp the way the scope line needs it', () => {
    expect(amzDate(new Date('2015-08-30T12:36:00.000Z'))).toBe('20150830T123600Z');
  });
});
