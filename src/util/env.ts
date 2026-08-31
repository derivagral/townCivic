import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` from the repository root, if there is one.
 *
 * This exists because the obvious thing to do with a `.env` is `source .env`,
 * and that quietly does not work. `source` on a file of `KEY=value` lines sets
 * *shell* variables, not *environment* variables — so `echo $S3_BUCKET` prints
 * the value while every child process, `npm run documents` included, sees
 * nothing. The symptom is a command that insists it is configured one way while
 * the shell insists it is configured another, and there is no error anywhere
 * because from Node's side the variable was simply never set.
 *
 * `set -a; source .env; set +a` is the shell answer. Doing it here is the answer
 * that does not have to be remembered.
 *
 * Two properties worth stating, because they are what make this safe rather
 * than merely convenient:
 *
 *   **A real environment variable always wins.** `process.loadEnvFile` does not
 *   overwrite anything already set, so a stray `.env` cannot quietly override
 *   what Fly, systemd or GitHub Actions passed in. The file is a fallback for a
 *   developer's shell, never a source of truth in a deployment.
 *
 *   **Only the CLI loads it.** This is imported by `cli.ts` and nothing else, so
 *   the test suite and anything importing `config.ts` as a library are
 *   unaffected by whatever happens to be in a working copy.
 *
 * Imported for its side effect, and imported *before* `config.ts`: that module
 * reads `process.env` when it is evaluated, and ES module imports are evaluated
 * in order, so loading the file after it would be loading it too late.
 */

/** The repository root — this file is `src/util/env.ts`. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Returns the file it loaded, or null when there was nothing to load. */
export function loadDotEnv(dir: string = ROOT): string | null {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return null;
  try {
    process.loadEnvFile(file);
    return file;
  } catch {
    // A malformed file should not stop the command from running: everything in
    // it is optional, and the environment may already carry what is needed.
    return null;
  }
}

loadDotEnv();
