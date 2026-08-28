import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.ts';

/**
 * Guards against documenting a command that does not exist.
 *
 * The README told people to run `npm run extract` for a release in which no
 * such script was defined — the CLI had the command, but the alias was never
 * added. Nothing caught it, because nothing checked the docs against the
 * package. These tests do.
 */

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');

/** Commands the CLI's switch actually handles. */
function cliCommands(): string[] {
  return [...cli.matchAll(/^\s*case '([a-z-]+)':/gm)].map((match) => match[1]!);
}

describe('documented commands exist', () => {
  it('every `npm run <script>` in the README is a real script', () => {
    const referenced = [...readme.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);

    const missing = [...new Set(referenced)].filter((name) => !(name in packageJson.scripts));
    expect(missing, `README references scripts that package.json does not define`).toEqual([]);
  });

  it('every `npx tsx src/cli.ts <command>` in the README is a real command', () => {
    const referenced = [...readme.matchAll(/npx tsx src\/cli\.ts ([a-z][a-z-]*)/g)].map((m) => m[1]!);
    const known = new Set(cliCommands());
    const missing = [...new Set(referenced)].filter((name) => !known.has(name));
    expect(missing, 'README references CLI commands that cli.ts does not handle').toEqual([]);
  });

  it('every script that wraps the CLI targets a command the CLI handles', () => {
    const known = new Set(cliCommands());
    const broken = Object.entries(packageJson.scripts)
      .map(([name, body]) => [name, /tsx (?:watch )?src\/cli\.ts ([a-z-]+)/.exec(body)?.[1]] as const)
      .filter(([, command]) => command && !known.has(command))
      .map(([name]) => name);

    expect(broken, 'package.json scripts point at CLI commands that do not exist').toEqual([]);
  });

  it('the pipeline commands people are told to run are all aliased', () => {
    // These are the ones the quick start walks through; a missing alias here is
    // the exact failure this file exists to prevent.
    for (const name of ['seed', 'ingest', 'extract', 'serve']) {
      expect(packageJson.scripts, `missing script: ${name}`).toHaveProperty(name);
    }
  });
});

describe('commands the UI tells people to run', () => {
  it('exist as scripts', () => {
    const views = fs.readFileSync(path.join(ROOT, 'src', 'web', 'views.ts'), 'utf8');
    const referenced = [...views.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((m) => m[1]!);
    const missing = [...new Set(referenced)].filter((name) => !(name in packageJson.scripts));
    expect(missing, 'the web UI suggests scripts that do not exist').toEqual([]);
  });
});

describe('console noise', () => {
  it('loads node:sqlite lazily, so the experimental warning can be filtered', () => {
    // Node emits the warning when the builtin is linked — before any module
    // body runs — so a static import here silently defeats util/quiet.ts and
    // puts a warning line above the output of every command.
    const db = fs.readFileSync(path.join(ROOT, 'src', 'db', 'index.ts'), 'utf8');
    expect(db).not.toMatch(/^import \{[^}]*\} from 'node:sqlite'/m);
    expect(db).toMatch(/createRequire\(import\.meta\.url\)\('node:sqlite'\)/);
  });

  it('keeps the warning filter as the CLI’s first import', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
    const firstImport = cli.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './util/quiet.ts';");
  });

  it('gives pdf.js its font assets, so extraction does not flood the console', () => {
    const pdf = fs.readFileSync(path.join(ROOT, 'src', 'extract', 'pdf.ts'), 'utf8');
    expect(pdf).toContain('standardFontDataUrl');
    expect(pdf).toContain('cMapUrl');
  });
});
