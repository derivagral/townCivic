import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Adapter, RawItem } from '../types.ts';
import { transcriptSchema } from '../transcripts.ts';
import type { TranscriptArtifact } from '../transcripts.ts';
import { dateOnlyToIso, parseFeedDate } from '../util/dates.ts';
import { clean } from '../util/text.ts';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name) => name === 'item',
});

function nodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
}

function seconds(timestamp: string): number {
  const parts = timestamp.split(':').map(Number);
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((p) => !Number.isInteger(p) || p < 0) ||
    parts.slice(1).some((p) => p >= 60)
  )
    throw new Error(`Invalid transcript time: ${timestamp}`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** MATV's public RSS carries the entire article in content:encoded, not just an excerpt. */
export function parseMatvContent(html: string): { board: string; transcript: TranscriptArtifact } {
  const $ = load(html);
  $('script, style').remove();
  const field = (name: string): string => {
    const label = $('p > strong')
      .filter((_, el) => clean($(el).text()) === `${name}:`)
      .first();
    return clean(label.parent().text().slice(label.text().length));
  };
  const board = field('Board');
  const meetingDate = field('Date');
  if (!board || !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
    throw new Error('MATV transcript is missing Board or ISO meeting Date');
  }
  const [year, month, day] = meetingDate.split('-').map(Number);
  if (dateOnlyToIso(year!, month!, day!).slice(0, 10) !== meetingDate) {
    throw new Error(`Invalid meeting date: ${meetingDate}`);
  }

  let videoId: string | undefined;
  for (const src of $('iframe[src], iframe[data-src]')
    .toArray()
    .flatMap((el) => [$(el).attr('src'), $(el).attr('data-src')])) {
    if (!src) continue;
    try {
      const url = new URL(src);
      if (
        url.protocol === 'https:' &&
        ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)
      ) {
        videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
        if (videoId) break;
      }
    } catch {
      /* Ignore non-video embeds; a missing usable video fails below. */
    }
  }
  const heading = $('h3')
    .filter((_, el) => clean($(el).text()) === 'Transcript')
    .first();
  if (!heading.length || !videoId) throw new Error('MATV transcript is missing Transcript heading or video');

  const segments: TranscriptArtifact['segments'] = [];
  for (const el of heading.nextUntil('h3').filter('h4').toArray()) {
    const block = $(el);
    const label = clean(block.text());
    const match =
      /^(Speaker\s+\d+)\s*\((\d{1,3}:\d{2}(?::\d{2})?)\s*[–—-]\s*(\d{1,3}:\d{2}(?::\d{2})?)\)$/.exec(label);
    if (!match) throw new Error(`Unrecognized MATV segment heading: ${label}`);
    // Keep wording and paragraph boundaries. No LLM cleanup or profanity filtering.
    const text = block
      .nextUntil('h4, h3, hr')
      .filter('p')
      .map((_, p) => clean($(p).text()))
      .get()
      .filter(Boolean)
      .join('\n\n');
    if (!text) throw new Error(`Empty MATV segment: ${label}`);
    segments.push({
      speakerLabel: match[1]!,
      startSeconds: seconds(match[2]!),
      endSeconds: seconds(match[3]!),
      text,
    });
  }
  return {
    board,
    transcript: transcriptSchema.parse({
      version: 1,
      origin: 'publisher-auto',
      videoId,
      meetingDate,
      segments,
    }),
  };
}

export const matvTranscriptsAdapter: Adapter = {
  name: 'matv-transcripts',
  parse(body, ctx): RawItem[] {
    // A bot challenge can be HTTP 200 HTML. Never report that as an empty feed.
    if (XMLValidator.validate(body) !== true) throw new Error('Expected valid MATV RSS XML');
    const doc = parser.parse(body);
    const channel = doc?.rss?.channel;
    if (!channel || !nodeText(channel.title).includes('Milton Access TV')) {
      throw new Error('Expected the Milton Access TV RSS channel; received another document');
    }
    const nodes = channel.item ?? [];
    return nodes.map((node: Record<string, unknown>): RawItem => {
      const link = nodeText(node.link);
      const url = new URL(link, ctx.source.url);
      if (!link || url.protocol !== 'https:' || url.hostname !== new URL(ctx.source.url).hostname) {
        throw new Error('MATV item is missing its publisher permalink');
      }
      const { board, transcript } = parseMatvContent(nodeText(node['content:encoded']));
      const [year, month, day] = transcript.meetingDate.split('-').map(Number);
      const published = parseFeedDate(nodeText(node.pubDate));
      const title = clean(load(nodeText(node.title)).text());
      return {
        // Use the publisher permalink, not a lowercased slug as a YouTube ID:
        // YouTube IDs are case-sensitive; the actual ID is read from the embed.
        externalId: `matv-transcript:${url.href}`,
        title: title || `${board}: ${transcript.meetingDate} — Transcript`,
        url: url.href,
        occurredAt: new Date(dateOnlyToIso(year!, month!, day!)),
        ...(published ? { publishedAt: new Date(published) } : {}),
        eventType: 'meeting_transcript',
        summary: `Automatic transcript published by Milton Access TV for the ${board} meeting.`,
        transcript,
        extra: { board, datePrecision: 'day' },
      };
    });
  },
};
