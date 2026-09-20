import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';
import { getConditionalHeaders, queryEvents } from '../src/db/repo.ts';
import { createLocalDocuments, setDocuments } from '../src/documents/index.ts';
import { ingest } from '../src/pipeline/ingest.ts';
import { status } from '../src/commands/status.ts';

vi.mock('../src/config.ts', async (original) => {
  const real = await original<typeof import('../src/config.ts')>();
  return { ...real, config: { ...real.config, perHostDelayMs: 0 } };
});

let db: Db;
let dir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-access-'));
  setDocuments(createLocalDocuments(dir));
});
afterEach(() => {
  setDocuments(undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('access failures through ingest', () => {
  it.each([200, 403])(
    'keeps existing records and retries without validators after an HTTP %i challenge',
    async (httpStatus) => {
      const sourceId = 'hull-ma:agenda:select-board';
      const valid = '<h1>Agenda Center</h1><a href="/AgendaCenter/ViewFile/Agenda/_09202026-123">Agenda</a>';
      const fetchImpl = vi.fn<typeof fetch>();
      const options = { jurisdiction: 'hull-ma', sourceIds: [sourceId], fetchImpl };
      fetchImpl.mockResolvedValueOnce(new Response(valid, { headers: { etag: 'good' } }));
      expect((await ingest(db, options))[0]).toMatchObject({ ok: true, created: 1 });
      expect(getConditionalHeaders(db, sourceId)).toEqual({ etag: 'good' });

      fetchImpl.mockResolvedValueOnce(
        new Response('<title>Just a moment...</title>', {
          status: httpStatus,
          headers: { etag: 'challenge' },
        }),
      );
      const [failed] = await ingest(db, options);
      expect(failed).toMatchObject({ ok: false, status: httpStatus, items: 0 });
      expect(failed!.error).toContain(httpStatus === 403 ? 'HTTP 403' : 'access-denial or browser-challenge');
      expect(queryEvents(db, { jurisdiction: 'hull-ma' })).toHaveLength(1);
      expect(getConditionalHeaders(db, sourceId)).toEqual({});
      expect(status(db, 'hull-ma').problems.some((p) => p.includes(sourceId))).toBe(true);

      fetchImpl.mockResolvedValueOnce(new Response(valid, { headers: { etag: 'recovered' } }));
      expect((await ingest(db, options))[0]).toMatchObject({ ok: true, unchanged: 1 });
      expect(fetchImpl.mock.calls[2]![1]!.headers).not.toHaveProperty('if-none-match');
      expect(getConditionalHeaders(db, sourceId)).toEqual({ etag: 'recovered' });
      expect(status(db, 'hull-ma').problems.some((p) => p.includes(sourceId))).toBe(false);
    },
  );
});
