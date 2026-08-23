import { truncate } from '../util/text.ts';
import { InterpreterUnavailableError } from './provider.ts';
import type { Interpretation, Interpreter, InterpretRequest } from './provider.ts';

/**
 * The model-backed interpreter.
 *
 * Off unless `ANTHROPIC_API_KEY` is set *and* the SDK is installed. Both are
 * deliberate: townCivic's quick start is "npm install, npm run ingest", with no
 * account to create and nothing metered, and adding a model dependency to the
 * default install would quietly end that. So `@anthropic-ai/sdk` is loaded
 * dynamically rather than imported, and its absence is a clear message rather
 * than a crash at startup.
 *
 * What it is asked to do is narrow on purpose. It does not summarize a meeting,
 * decide what mattered, or characterize anyone's position. It reads minutes and
 * reports the votes and dispositions they contain, in the town's own words
 * wherever possible, so that those become searchable. Everything it returns is
 * stored as derived, shown as derived, and never overwrites a parsed fact.
 */

const MODEL = 'claude-opus-5';
const PROMPT_VERSION = 'anthropic-1';

const SYSTEM = `You are an indexer for a civic records archive, not a journalist.

You are given the text of a public meeting document from one town. Report only
what the document itself records about decisions:

- recorded votes, with the tally and what was being voted on
- applications or petitions granted, denied, or withdrawn
- matters continued, and to when
- conditions attached to an approval

Rules:
- Quote the document's own wording for any outcome. Do not paraphrase a vote.
- Report nothing that is not in the text. If the document records no decision,
  say exactly: NONE
- Do not characterise, evaluate, or explain the significance of anything.
- Do not describe who argued for what, or how the discussion went.
- Write plain prose, at most 120 words. It is going into a search index.`;

interface AnthropicOptions {
  apiKey?: string | undefined;
  /** Injected by tests; production loads the SDK dynamically. */
  createMessage?: (request: InterpretRequest) => Promise<string>;
}

/**
 * Load the SDK only if it is actually installed.
 *
 * The specifier is built at runtime so TypeScript does not try to resolve a
 * package that is intentionally not a dependency. That is the cost of keeping
 * the default install free of it.
 */
async function loadSdk(): Promise<new (options: { apiKey: string }) => unknown> {
  const specifier = ['@anthropic-ai', 'sdk'].join('/');
  try {
    const module = (await import(specifier)) as { default: new (o: { apiKey: string }) => unknown };
    return module.default;
  } catch {
    throw new InterpreterUnavailableError(
      'The anthropic interpreter needs @anthropic-ai/sdk, which townCivic does not install by ' +
        'default. Run `npm install @anthropic-ai/sdk`, or use `--provider rules`.',
    );
  }
}

/** Minimal shape of what we call, so the dynamic import stays untyped at the edge. */
interface MessagesClient {
  beta: {
    messages: {
      create(request: Record<string, unknown>): Promise<{
        stop_reason?: string;
        stop_details?: { category?: string | null; explanation?: string } | null;
        content: { type: string; text?: string }[];
      }>;
    };
  };
}

export function createAnthropicInterpreter(options: AnthropicOptions = {}): Interpreter {
  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];

  const callModel =
    options.createMessage ??
    (async (request: InterpretRequest): Promise<string> => {
      if (!apiKey) {
        throw new InterpreterUnavailableError(
          'ANTHROPIC_API_KEY is not set. The anthropic interpreter is optional — ' +
            'the default `rules` provider needs no key.',
        );
      }

      const Anthropic = await loadSdk();
      const client = new Anthropic({ apiKey }) as MessagesClient;

      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        // Reading a document for stock phrases is not hard reasoning, and this
        // runs over thousands of documents. Low effort rather than thinking
        // disabled: on this model, disabling thinking costs more than it saves.
        output_config: { effort: 'low' },
        // A refusal on a public meeting record would be surprising, but these
        // are unreviewed documents from the open web; let the API retry on a
        // fallback model rather than dropping the document silently.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [
          {
            role: 'user',
            content: [
              `Town: Milton, Massachusetts`,
              `Body: ${request.body ?? 'unknown'}`,
              `Document: ${request.title}`,
              '',
              truncate(request.text, 60_000),
            ].join('\n'),
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error(`model declined: ${response.stop_details?.category ?? 'unspecified'}`);
      }

      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();
    });

  return {
    name: 'anthropic',
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    // Metered, so a run is capped low by default. Raise it deliberately.
    suggestedLimit: 50,

    async interpret(request: InterpretRequest): Promise<Interpretation[]> {
      const text = await callModel(request);
      // The prompt asks for a literal NONE rather than a hedge, so that "found
      // nothing" is distinguishable from "found something uninteresting".
      if (!text || /^none\b/i.test(text)) return [];

      return [
        {
          kind: 'decisions',
          text: truncate(text, 2_000),
          data: { model: MODEL, promptVersion: PROMPT_VERSION },
        },
      ];
    },
  };
}
