import type { Adapter, AdapterContext, AdapterName, RawItem, SourceDef } from '../types.ts';
import { rssAdapter } from './rss.ts';
import { wordpressTranscriptsAdapter } from './wordpress-transcripts.ts';
import { matvTranscriptsAdapter } from './matv-transcripts.ts';
import { civicPlusAgendaCenterAdapter } from './civicplus-agenda-center.ts';
import { civicPlusBidsAdapter } from './civicplus-bids.ts';
import { htmlLinksAdapter } from './html-links.ts';

export const adapters: Record<AdapterName, Adapter> = {
  rss: rssAdapter,
  'matv-transcripts': matvTranscriptsAdapter,
  'wordpress-transcripts': wordpressTranscriptsAdapter,
  'civicplus-agenda-center': civicPlusAgendaCenterAdapter,
  'civicplus-bids': civicPlusBidsAdapter,
  'html-links': htmlLinksAdapter,
};

export function getAdapter(name: AdapterName): Adapter {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`Unknown adapter: ${name}`);
  return adapter;
}

export function makeContext(source: SourceDef): AdapterContext {
  return {
    source,
    resolve(href: string) {
      try {
        return new URL(href, source.url).toString();
      } catch {
        return href;
      }
    },
  };
}

export function parseWithSource(source: SourceDef, body: string): RawItem[] {
  return getAdapter(source.adapter).parse(body, makeContext(source));
}

export { extractAgendaCategories } from './civicplus-agenda-center.ts';
