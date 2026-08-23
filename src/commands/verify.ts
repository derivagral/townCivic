import type { Db } from '../db/index.ts';
import { syncSources } from '../registry/index.ts';
import { fetchSource } from '../fetch/http.ts';
import { parseWithSource } from '../adapters/index.ts';

export interface VerifyResult {
  sourceId: string;
  label: string;
  url: string;
  confidence: string;
  enabled: boolean;
  status: number;
  ok: boolean;
  items: number;
  contentType: string | null;
  error?: string;
  /** Answered and parsed cleanly, but the source publishes no items. */
  empty: boolean;
  /** What the registry should say, given what actually came back. */
  suggestedConfidence?: 'verified' | 'unverified';
}

export interface VerifyOptions {
  jurisdiction?: string;
  sourceIds?: string[];
  includeDisabled?: boolean;
  fetchImpl?: typeof fetch;
  onResult?: (result: VerifyResult) => void;
}

/**
 * Check every registered URL against the live site.
 *
 * This is the command that turns a guessed CivicPlus module id into a fact. It
 * writes nothing to `events` — it only reports what answered, what parsed, and
 * which registry entries are claiming more confidence than they have earned.
 */
export async function verify(db: Db, options: VerifyOptions = {}): Promise<VerifyResult[]> {
  const sources = syncSources(db, options.jurisdiction).filter((source) => {
    if (options.sourceIds?.length) return options.sourceIds.includes(source.id);
    return source.enabled || options.includeDisabled;
  });

  const results: VerifyResult[] = [];

  for (const source of sources) {
    const response = await fetchSource(source.id, source.url, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    const result: VerifyResult = {
      sourceId: source.id,
      label: source.label,
      url: source.url,
      confidence: source.confidence,
      enabled: source.enabled,
      status: response.status,
      ok: response.ok,
      items: 0,
      contentType: response.contentType,
      empty: false,
    };

    if (!response.ok) {
      result.error = response.error ?? `HTTP ${response.status}`;
    } else {
      try {
        result.items = parseWithSource(source, response.body).length;
      } catch (error) {
        result.ok = false;
        result.error = `parse failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // "Answered but empty" and "wrong URL" look alike from a distance but mean
    // different things: several of Milton's feeds are correctly addressed and
    // simply unpopulated. Only a failure to answer or parse touches confidence.
    result.empty = result.ok && result.items === 0;
    if (result.ok && result.items > 0 && source.confidence !== 'verified') {
      result.suggestedConfidence = 'verified';
    }
    if (!result.ok && source.confidence === 'verified') result.suggestedConfidence = 'unverified';

    results.push(result);
    options.onResult?.(result);
  }

  return results;
}
