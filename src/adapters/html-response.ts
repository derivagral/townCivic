import type { CheerioAPI } from 'cheerio';
import { clean } from '../util/text.ts';

/** Some access-denial pages arrive with HTTP 200. They are not empty listings. */
export function rejectAccessPage($: CheerioAPI): void {
  // Only inspect page-level headings and challenge markup, never agenda/bid
  // prose: a legitimate notice can discuss access denied or browser checks.
  const blockedHeading =
    /^(?:just a moment\.{0,3}|checking your browser(?:\.{0,3})?|access denied|request rejected|pardon our interruption|attention required!?\s*\|\s*cloudflare)$/i;
  const blocked = $('title, h1')
    .toArray()
    .some((el) => blockedHeading.test(clean($(el).text())));
  if (blocked || $('#challenge-form, #cf-challenge-running, #cf-error-details').length) {
    throw new Error('Received an access-denial or browser-challenge page instead of a municipal listing');
  }
}
