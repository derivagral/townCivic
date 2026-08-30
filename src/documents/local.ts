import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { DocumentStore, StoreCheck, StoredObject } from './store.ts';

/**
 * The archive on the local filesystem.
 *
 * The code that has always been here, moved behind the port. Still the default,
 * because "npm install, npm run ingest" has to keep working with no account
 * anywhere — and because for one person on one machine, a directory is a
 * perfectly good object store.
 *
 * What it is not is durable in the places townCivic wants to run. A GitHub
 * Actions cache can be evicted; a container filesystem goes away on deploy.
 * That is what the S3 backend is for, not any shortcoming here.
 */
export function createLocalDocuments(dir = config.docStoreDir): DocumentStore {
  const absolute = (key: string) => path.join(dir, key);

  return {
    kind: 'local',

    describe() {
      return `local — ${dir}, which has to be a volume that survives a deploy`;
    },

    async put(key, body, _contentType) {
      const file = absolute(key);
      const existed = fs.existsSync(file);
      if (!existed) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
      }
      return {
        id: createHash('sha256').update(body).digest('hex'),
        key,
        bytes: body.byteLength,
        isNew: !existed,
      } satisfies StoredObject;
    },

    async has(key) {
      return fs.existsSync(absolute(key));
    },

    async get(key) {
      try {
        return new Uint8Array(fs.readFileSync(absolute(key)));
      } catch {
        return null;
      }
    },

    async check(): Promise<StoreCheck> {
      const findings: StoreCheck['findings'] = [
        { label: 'backend', ok: true, detail: `local (the default; nothing to configure)` },
      ];

      let objects = 0;
      let bytes = 0;
      try {
        for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
          if (!entry.isFile()) continue;
          objects += 1;
          bytes += fs.statSync(path.join(entry.parentPath ?? dir, entry.name)).size;
        }
        findings.push({
          label: 'archive',
          ok: true,
          detail: `${objects} object(s), ${(bytes / 1024 / 1024).toFixed(0)} MB in ${dir}`,
        });
      } catch {
        findings.push({
          label: 'archive',
          ok: true,
          detail: `${dir} does not exist yet — nothing has been ingested`,
        });
      }

      // Not a failure. It is the honest statement of what this backend is: the
      // only copy of a document a town has taken down lives on one disk.
      findings.push({
        label: 'durability',
        ok: true,
        detail:
          objects === 0
            ? 'nothing stored yet'
            : 'one disk — an evicted Actions cache or a redeployed container loses it',
      });

      return { ok: true, findings };
    },
  };
}
