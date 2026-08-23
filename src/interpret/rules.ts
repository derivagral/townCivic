import { clean, truncate } from '../util/text.ts';
import type { Interpretation, Interpreter, InterpretRequest } from './provider.ts';

/**
 * The deterministic interpreter: no model, no key, no network, no cost.
 *
 * It reads the things minutes say in a small number of stock phrasings — a
 * recorded vote, a continuance to a named date, a granted or denied
 * application. That is a fraction of what a model would find, and it is the
 * fraction that can be checked by reading this file.
 *
 * It exists for three reasons. It makes the whole stage runnable and testable
 * with nothing configured. It is the baseline a model has to beat. And on a
 * corpus of a few thousand documents it costs nothing to run over all of them,
 * which is a real advantage over anything metered.
 */

/** "approved 4-1", "voted 5–0 in favor", "denied, 3 to 2". */
const TALLY_RE =
  /\b(approv\w+|den\w+|grant\w+|reject\w+|adopt\w+|pass\w+|fail\w+|vot\w+)\b[^.;\n]{0,60}?\b(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\b/gi;

/** "voted unanimously to approve", "approved unanimously". */
const UNANIMOUS_RE = /\b(unanimous(?:ly)?)\b[^.;\n]{0,60}|[^.;\n]{0,60}\bunanimous(?:ly)?\b/gi;

/** "continued to September 9, 2026", "continued to the meeting of October 1". */
const CONTINUED_RE = /\bcontinu(?:ed|ance)\b[^.;\n]{0,80}?\b(?:to|until)\b([^.;\n]{0,60})/gi;

const DECISION_RE =
  /\b(?:the (?:board|committee|commission)|it was)\s+(?:voted|moved|resolved)\b[^.;\n]{0,140}/gi;

interface Vote {
  outcome: string;
  inFavor: number;
  opposed: number;
  sentence: string;
}

/** Sentences, kept whole across the initials that litter minutes ("Mr. A. Smith"). */
function sentences(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(/(?<=[.;])(?<![A-Z]\.)\s+/))
    .map((part) => clean(part))
    .filter(Boolean);
}

export function findVotes(text: string): Vote[] {
  const votes: Vote[] = [];
  for (const sentence of sentences(text)) {
    for (const match of sentence.matchAll(TALLY_RE)) {
      const inFavor = Number(match[2]);
      const opposed = Number(match[3]);
      // A date range or a setback dimension is not a vote tally. Boards are
      // small, so a plausible one is small on both sides.
      if (inFavor > 15 || opposed > 15) continue;
      votes.push({
        outcome: match[1]!.toLowerCase(),
        inFavor,
        opposed,
        sentence: truncate(sentence, 240),
      });
    }
  }
  return votes;
}

export function findContinuances(text: string): { to: string; sentence: string }[] {
  const found: { to: string; sentence: string }[] = [];
  for (const sentence of sentences(text)) {
    for (const match of sentence.matchAll(CONTINUED_RE)) {
      const to = clean(match[1] ?? '');
      if (to) found.push({ to, sentence: truncate(sentence, 240) });
    }
  }
  return found;
}

export const rulesInterpreter: Interpreter = {
  name: 'rules',
  model: null,
  promptVersion: 'rules-1',
  // No cost and no rate limit, so the only reason to cap a run is patience.
  suggestedLimit: 5_000,

  async interpret(request: InterpretRequest): Promise<Interpretation[]> {
    const out: Interpretation[] = [];
    const votes = findVotes(request.text);

    if (votes.length) {
      // Written as prose because the point is that a search for "approved 4-1"
      // or "denied 3-2" reaches it.
      const lines = votes.map((v) => `${v.outcome} ${v.inFavor}–${v.opposed}`);
      out.push({
        kind: 'votes',
        text: `Recorded vote${votes.length === 1 ? '' : 's'}: ${lines.join('; ')}. ${votes
          .map((v) => v.sentence)
          .join(' ')}`,
        data: { votes },
      });
    } else {
      const unanimous = [...request.text.matchAll(UNANIMOUS_RE)]
        .map((m) => clean(m[0]))
        .filter(Boolean)
        .slice(0, 3);
      if (unanimous.length) {
        out.push({
          kind: 'votes',
          text: `Recorded as unanimous. ${unanimous.join(' ')}`,
          data: { unanimous },
        });
      }
    }

    const continuances = findContinuances(request.text);
    const decisions = [...request.text.matchAll(DECISION_RE)].map((m) => clean(m[0])).slice(0, 5);

    if (continuances.length || decisions.length) {
      out.push({
        kind: 'decisions',
        text: [...continuances.map((c) => `Continued to ${c.to}.`), ...decisions.map((d) => `${d}.`)].join(
          ' ',
        ),
        data: { continuances, decisions },
      });
    }

    return out;
  },
};
