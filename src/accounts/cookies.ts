import { createHash, timingSafeEqual } from 'node:crypto';
import type { StartedSession } from './store.ts';

/**
 * The session cookie, which is the same shape whichever backend issued it.
 *
 * What differs is only what is *inside* it — an opaque session id for the local
 * backend, a token envelope for the hosted one — and neither the browser nor
 * this file needs to know which. The flags do not vary: `HttpOnly` so scripts
 * cannot read it, `SameSite=Lax` so a cross-site form post does not carry it,
 * and `Secure` when asked.
 */

export const SESSION_COOKIE = 'towncivic_session';

/**
 * `Secure` is conditional because the documented way to run this is
 * `npm run serve` on localhost, where a Secure cookie is simply never sent and
 * login would appear to silently fail. Anything reachable over HTTPS should set
 * `TOWNCIVIC_SECURE_COOKIES=1`.
 */
export function sessionCookie(session: StartedSession, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${session.value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(session.maxAgeSeconds))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Pull one cookie out of a `Cookie` header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so both sides are hashed to a fixed width first.
 */
export function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
