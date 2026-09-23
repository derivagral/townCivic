// One source, no retries or conditional headers, no database or object store.
// Run with: node --import tsx scripts/probe-hull.mjs
import { fetchSource, activeProxy } from '../src/fetch/http.ts';
import { config } from '../src/config.ts';
import { hullProfile } from '../src/registry/hull-ma.ts';
import { parseWithSource } from '../src/adapters/index.ts';

const source = hullProfile.sources.find((s) => s.id === 'hull-ma:agenda:select-board');
if (!source) throw new Error('Hull Select Board source is missing from the registry');
const requestedAt = new Date().toISOString();
const result = await fetchSource(source.id, source.url, { maxRetries: 0 });
let ok = result.ok;
let error = result.error;
let items = null;
if (ok) {
  try {
    items = parseWithSource(source, result.body).length;
  } catch (e) {
    ok = false;
    error = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
console.log(
  JSON.stringify(
    {
      requestedAt,
      sourceId: source.id,
      url: source.url,
      userAgent: config.userAgent,
      proxyConfigured: Boolean(activeProxy),
      status: result.status,
      contentType: result.contentType,
      ok,
      items,
      ...(error ? { error } : {}),
    },
    null,
    2,
  ),
);
process.exitCode = ok ? 0 : 1;
