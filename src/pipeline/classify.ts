import type { Channel, EventType, Priority } from '../taxonomy.ts';
import type { RawItem, SourceDef } from '../types.ts';

/**
 * Rule-based classification. No model in the loop.
 *
 * The source decides the default channel — a Planning Board listing is land-use
 * whatever the item says. Rules below only refine that: they add tags, sharpen
 * the event type, and reroute the handful of items that clearly belong
 * elsewhere (a bylaw article posted by the Select Board is `law`).
 *
 * Everything here is a pure function of text, so a surprising classification is
 * always reproducible and always fixable in one place.
 */

export interface Rule {
  id: string;
  pattern: RegExp;
  /** Move the item to this channel. Omit to leave the source's channel alone. */
  channel?: Channel;
  eventType?: EventType;
  priority?: Priority;
  tags?: string[];
}

export const RULES: Rule[] = [
  {
    id: 'public-hearing',
    pattern: /\bpublic hearing\b|\bhearing (?:on|for|scheduled|continued)\b/i,
    eventType: 'hearing_scheduled',
    tags: ['hearing'],
  },
  {
    id: 'zoning-relief',
    pattern:
      /special permit|variance|site plan review|subdivision|setback|rezon|zoning (?:amendment|relief|board)/i,
    channel: 'land-use',
    priority: 'high',
    tags: ['zoning'],
  },
  {
    id: 'wetlands',
    pattern: /wetland|notice of intent|order of conditions|conservation restriction/i,
    channel: 'land-use',
    tags: ['wetlands'],
  },
  {
    id: 'procurement',
    pattern:
      /\brfp\b|\brfq\b|invitation for bid|\bifb\b|request for proposal|award(?:ed)? (?:the )?contract/i,
    channel: 'money',
    eventType: 'bid_posted',
    priority: 'high',
    tags: ['procurement'],
  },
  {
    id: 'budget',
    pattern: /budget|appropriat|override|debt exclusion|bond|capital plan|free cash|tax rate|audit/i,
    channel: 'money',
    priority: 'high',
    tags: ['budget'],
  },
  {
    id: 'grant',
    pattern: /\bgrant (?:award|application|funding)|awarded a grant|grant program/i,
    channel: 'money',
    tags: ['grant'],
  },
  {
    id: 'bylaw',
    pattern: /\bby-?law\b|\bordinance\b|home rule petition|general by-?laws|zoning by-?law/i,
    channel: 'law',
    priority: 'high',
    tags: ['bylaw'],
  },
  {
    // "Warrant Committee" is Milton's finance committee, not a Town Meeting
    // article — matching a bare "warrant" would misfile its entire calendar.
    id: 'town-meeting',
    pattern: /town meeting|warrant article|\bwarrant\b(?!\s+committee)/i,
    channel: 'law',
    eventType: 'warrant_article',
    priority: 'high',
    tags: ['town-meeting'],
  },
  {
    id: 'elections',
    pattern:
      /\belection\b|ballot question|polling (?:place|location)|nomination papers|voter registration|early voting/i,
    channel: 'elections',
    eventType: 'election_notice',
    priority: 'high',
    tags: ['elections'],
  },
  {
    id: 'public-safety',
    pattern:
      /road closure|detour|water main|boil water|water restriction|hydrant flushing|snow emergency|parking ban|state of emergency|road work/i,
    channel: 'public-safety',
    tags: ['infrastructure'],
  },
  {
    id: 'schools',
    pattern: /school committee|superintendent|school district|school building/i,
    channel: 'schools',
    priority: 'high',
    tags: ['schools'],
  },
  {
    id: 'intergovernmental',
    pattern:
      /\bice\b|immigration and customs|\bepa\b|\bfema\b|massdot|massdep|\bdpu\b|\bhud\b|army corps|attorney general|\b287\(g\)\b|mbta communities/i,
    tags: ['intergovernmental'],
  },
  {
    id: 'routine-admin',
    pattern:
      /one-?day (?:liquor )?license|common victualler|license renewal|raffle permit|block party|proclamation|ceremonial/i,
    channel: 'admin',
    priority: 'low',
    tags: ['routine'],
  },
];

export interface Classification {
  channel: Channel;
  eventType: EventType;
  priority: Priority;
  tags: string[];
}

/**
 * Rules are ordered most-specific first, and the **first** rule to claim the
 * channel keeps it — later matches only contribute tags.
 *
 * That ordering is what makes a Planning Board hearing on a zoning by-law
 * amendment stay in `land-use` (where someone watching development will look)
 * while still carrying a `bylaw` tag, instead of being pulled into `law` by the
 * last rule that happened to match.
 */
export function classify(source: SourceDef, item: RawItem): Classification {
  const haystack = `${item.title} ${item.summary ?? ''}`;

  let channel: Channel = item.channel ?? source.channel;
  let eventType: EventType = item.eventType ?? source.eventType ?? 'document_posted';
  let priority: Priority = source.priority;
  // A source scoped to one board is authoritative about its channel: a Planning
  // Board agenda stays in land-use even when its text is all about a by-law, so
  // that someone following development never has to also watch /law.
  let channelClaimed = item.channel !== undefined || source.body !== undefined;
  let typeClaimed = item.eventType !== undefined;
  const tags = new Set<string>();

  // The adapter read the URL; a text rule should not overrule that for agendas
  // and minutes, which are structurally what their href says they are.
  const adapterWasCertain = item.eventType === 'meeting_agenda' || item.eventType === 'meeting_minutes';

  for (const rule of RULES) {
    if (!rule.pattern.test(haystack)) continue;
    for (const tag of rule.tags ?? []) tags.add(tag);

    if (rule.channel && !channelClaimed) {
      channel = rule.channel;
      channelClaimed = true;
    }
    if (rule.eventType && !typeClaimed && !adapterWasCertain) {
      eventType = rule.eventType;
      typeClaimed = true;
    }
    if (rule.priority === 'high') priority = 'high';
    else if (rule.priority === 'low' && priority !== 'high') priority = 'low';
  }

  return { channel, eventType, priority, tags: [...tags].sort() };
}
