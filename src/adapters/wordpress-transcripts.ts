import { load } from 'cheerio';
import { z } from 'zod';
import type { Adapter, AdapterContext, RawItem } from '../types.ts';
import { parseMatvContent } from './matv-transcripts.ts';
import { dateOnlyToIso } from '../util/dates.ts';
import { clean } from '../util/text.ts';

const gmtDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  .refine((s) => Number.isFinite(Date.parse(`${s}Z`)));
export const wordpressPostSchema = z.object({
  id: z.number().int().positive(),
  link: z.string().url(),
  date_gmt: gmtDate,
  modified_gmt: gmtDate,
  categories: z.array(z.number().int()),
  title: z.object({ rendered: z.string() }),
  content: z.object({ rendered: z.string().min(1), protected: z.boolean().optional() }),
});
export type WordpressPost = z.infer<typeof wordpressPostSchema>;

export function parseWordpressPosts(body: string): WordpressPost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Expected WordPress JSON posts; received HTML, a bot challenge, or invalid JSON');
  }
  return z.array(wordpressPostSchema).parse(parsed);
}

export function wordpressTranscriptItem(post: WordpressPost, ctx: AdapterContext): RawItem {
  const url = new URL(post.link);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== new URL(ctx.source.url).hostname ||
    !post.categories.includes(Number(ctx.source.options['categoryId'])) ||
    post.content.protected
  ) {
    throw new Error(`Post ${post.id} is not a public transcript from the configured publisher/category`);
  }
  let parsed: ReturnType<typeof parseMatvContent>;
  try {
    parsed = parseMatvContent(post.content.rendered);
  } catch (error) {
    throw new Error(
      `MATV post ${post.id} (${post.link}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { board, transcript, meetingDateSource } = parsed;
  const [year, month, day] = transcript.meetingDate.split('-').map(Number);
  return {
    // Keep the RSS prototype's permalink identity so switching transports is idempotent.
    externalId: `matv-transcript:${url.href}`,
    title: clean(load(post.title.rendered).text()) || `${board}: ${transcript.meetingDate} — Transcript`,
    url: url.href,
    occurredAt: new Date(dateOnlyToIso(year!, month!, day!)),
    publishedAt: new Date(`${post.date_gmt}Z`),
    eventType: 'meeting_transcript',
    summary: `Automatic transcript published by Milton Access TV for the ${board} meeting.`,
    transcript,
    extra: {
      board,
      datePrecision: 'day',
      meetingDateSource,
      wordpressPostId: post.id,
      modifiedAt: `${post.modified_gmt}Z`,
    },
  };
}

export const wordpressTranscriptsAdapter: Adapter = {
  name: 'wordpress-transcripts',
  parse: (body, ctx) => parseWordpressPosts(body).map((post) => wordpressTranscriptItem(post, ctx)),
};
