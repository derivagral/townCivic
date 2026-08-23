import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function extensionFor(contentType: string | null): string {
  if (!contentType) return 'bin';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('text/')) return 'txt';
  return 'bin';
}

export interface StoredDocument {
  id: string;
  path: string;
  absolutePath: string;
  bytes: number;
  /** False when this exact body was already on disk. */
  isNew: boolean;
}

/**
 * Write a fetched body into the content-addressed store.
 *
 * The raw document is the authority; everything downstream is derived and can
 * be rebuilt from here. Identical bodies collapse to one file.
 */
export function storeDocument(
  body: string,
  contentType: string | null,
  dir = config.docStoreDir,
): StoredDocument {
  const id = sha256(body);
  const relative = path.join(id.slice(0, 2), `${id}.${extensionFor(contentType)}`);
  const absolute = path.join(dir, relative);
  const existed = fs.existsSync(absolute);
  if (!existed) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body, 'utf8');
  }
  return {
    id,
    path: relative,
    absolutePath: absolute,
    bytes: Buffer.byteLength(body, 'utf8'),
    isNew: !existed,
  };
}

export function readDocument(relativePath: string, dir = config.docStoreDir): string {
  return fs.readFileSync(path.join(dir, relativePath), 'utf8');
}
