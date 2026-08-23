/**
 * The seam where a model is allowed in.
 *
 * townCivic's rule is that the document is the authority and nothing derived
 * ever becomes the record. Minutes are the one place that rule costs something:
 * agendas are structured data, but minutes are prose, so "approved 4–1" and
 * "continued to September 9 subject to a drainage condition" are facts the town
 * published that no parser here can reach.
 *
 * This interface is how that gap gets filled without giving the gap authority.
 * An interpreter reads a stored document and returns *searchable prose*. It is
 * written to its own table, shown in its own visibly-separate block, and
 * indexed separately from the record. Deleting every row changes nothing about
 * what townCivic reports the town did.
 *
 * Two implementations ship:
 *   rules      deterministic, no model, no cost, no network — the default
 *   anthropic  a real model, off unless a key is present
 *
 * The rules provider is not a placeholder for the model one. It is the floor:
 * whatever a model adds has to beat what regular expressions already get, and
 * having both makes that comparable.
 */

export const INTERPRETATION_KINDS = ['votes', 'decisions', 'summary'] as const;
export type InterpretationKind = (typeof INTERPRETATION_KINDS)[number];

export interface InterpretRequest {
  eventId: string;
  title: string;
  body: string | null;
  eventType: string;
  occurredAt: string | null;
  /** The stored document's text. Never re-fetched — this reads what was kept. */
  text: string;
}

export interface Interpretation {
  kind: InterpretationKind;
  /** Prose. This is the part that gets indexed, so it has to read like English. */
  text: string;
  /** Whatever structure the provider managed to extract. Stored verbatim. */
  data: Record<string, unknown>;
}

export interface Interpreter {
  /** Stored on every row, so a reading can always be traced to what produced it. */
  name: string;
  model: string | null;
  /** Bump when the prompt or the rules change; old readings stay identifiable. */
  promptVersion: string;
  /** Roughly how many documents per run this provider is comfortable with. */
  suggestedLimit: number;
  interpret(request: InterpretRequest): Promise<Interpretation[]>;
}

export class InterpreterUnavailableError extends Error {}
