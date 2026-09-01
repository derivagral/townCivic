import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { createLocalDocuments } from '../src/documents/local.ts';
import { SNAPSHOT_DIGEST_KEY, SNAPSHOT_KEY, pullSnapshot, pushSnapshot } from '../src/commands/snapshot.ts';

/**
 * Moving the built database between the pipeline and the web tier.
 *
 * The pipeline runs in Actions and the server runs on Fly; this is the only
 * thing that carries a file across. What is worth testing is not the happy path
 * but the two ways it can quietly go wrong: installing a corrupt database, and
 * leaving SQLite's sidecar files beside one that was replaced wholesale.
 */

let store: ReturnType<typeof createLocalDocuments>;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towncivic-snap-'));
  store = createLocalDocuments(path.join(dir, 'store'));
  process.env['TOWNCIVIC_DB'] = path.join(dir, 'towncivic.db');
});

const writeDb = (contents: string) => fs.writeFileSync(config.dbPath, contents);

describe('snapshot', () => {
  it('publishes the database and installs it back byte for byte', async () => {
    writeDb('SQLite format 3 pretend');
    const pushed = await pushSnapshot(store);
    expect(pushed).toMatchObject({ action: 'push', key: SNAPSHOT_KEY, unchanged: false });

    fs.rmSync(config.dbPath);
    const pulled = await pullSnapshot(store);

    expect(pulled.sha256).toBe(pushed.sha256);
    expect(fs.readFileSync(config.dbPath, 'utf8')).toBe('SQLite format 3 pretend');
  });

  it('does not re-upload bytes the store already holds', async () => {
    // Not content-addressed — the key is fixed so the deploy can name it — so
    // the digest beside it is the only thing that can say nothing moved.
    writeDb('unchanged');
    await pushSnapshot(store);
    expect((await pushSnapshot(store)).unchanged).toBe(true);
  });

  it('refuses a snapshot whose checksum does not match', async () => {
    writeDb('the real database');
    await pushSnapshot(store);

    // A truncated transfer, which is what the digest is for. `overwrite` here
    // for the same reason the real push needs it: without it the store declines
    // to replace a key it already holds, and the corruption never lands.
    await store.put(SNAPSHOT_KEY, new TextEncoder().encode('the real datab'), 'application/vnd.sqlite3', {
      overwrite: true,
    });

    await expect(pullSnapshot(store)).rejects.toThrow(/corrupt/i);
    // And it did not install the bad copy over the good one.
    expect(fs.readFileSync(config.dbPath, 'utf8')).toBe('the real database');
  });

  it('clears the WAL and shared-memory files it just invalidated', async () => {
    // These describe transactions against the database that was there a moment
    // ago. SQLite would try to apply them over the top of the new one.
    writeDb('first');
    await pushSnapshot(store);
    fs.writeFileSync(`${config.dbPath}-wal`, 'stale');
    fs.writeFileSync(`${config.dbPath}-shm`, 'stale');

    await pullSnapshot(store);

    expect(fs.existsSync(`${config.dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${config.dbPath}-shm`)).toBe(false);
  });

  it('says where to get one when nothing is published', async () => {
    await expect(pullSnapshot(store)).rejects.toThrow(/snapshot/i);
  });

  it('writes a digest beside the database', async () => {
    writeDb('some database');
    const pushed = await pushSnapshot(store);
    const digest = await store.get(SNAPSHOT_DIGEST_KEY);
    expect(new TextDecoder().decode(digest!).trim()).toBe(pushed.sha256);
  });
});

describe('the deployment files', () => {
  const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

  it('keeps the raw archive out of the build context', () => {
    // 553 MB that nothing reads at serve time. Without this the remote builder
    // uploads all of it on every deploy.
    expect(read('.dockerignore')).toMatch(/^data\/documents$/m);
    expect(read('.dockerignore')).toMatch(/^node_modules$/m);
    // And never the configuration file.
    expect(read('.dockerignore')).toMatch(/^\.env$/m);
  });

  it('bakes the database rather than making it optional', () => {
    // An image that shipped without one would come up healthy, pass its checks
    // and serve an empty archive. A build error is the better failure.
    expect(read('Dockerfile')).toMatch(/COPY data\/towncivic\.db/);
  });

  it('keeps tsx available, since the source is what runs', () => {
    // Pruning devDependencies removes the thing that executes the TypeScript.
    //
    // This assertion used to be `not.toMatch(/--omit=dev/)` and was green while
    // the image was broken, because there is a second way to prune and the
    // Dockerfile was using it: `ENV NODE_ENV=production` makes `npm ci` omit
    // devDependencies with no flag on the line to see. So check both routes.
    const dockerfile = read('Dockerfile');
    const install = dockerfile.split('\n').find((line) => line.startsWith('RUN npm ci'));
    expect(install).toBeDefined();
    expect(install).not.toMatch(/--omit=dev/);
    if (/^ENV NODE_ENV=production/m.test(dockerfile)) {
      expect(
        install,
        'NODE_ENV=production prunes devDependencies unless --include=dev says otherwise',
      ).toMatch(/--include=dev/);
    }
  });

  it('starts the server without reaching for the registry', () => {
    // `npx` handed a package the image does not have downloads it rather than
    // failing, which put the npm registry on the boot path and ran a tsx the
    // lockfile does not pin. `node` can only use what `npm ci` installed.
    const cmd = read('Dockerfile')
      .split('\n')
      .find((line) => line.startsWith('CMD'));
    expect(cmd).toBeDefined();
    expect(cmd).not.toMatch(/npx|npm/);
    // And PID 1, so Fly's SIGTERM reaches the server rather than a wrapper.
    expect(cmd).toMatch(/^CMD \["node"/);
  });

  it('agrees with itself about HTTPS', () => {
    // `preflight` fails when these disagree; better to never ship them that way.
    const toml = read('fly.toml');
    const https = /TOWNCIVIC_BASE_URL = "https:/.test(toml);
    const secure = /TOWNCIVIC_SECURE_COOKIES = "1"/.test(toml);
    expect(https).toBe(secure);
  });

  it('spells auto_stop_machines as a bool', () => {
    // A string here is rejected outright by older flyctl:
    //   cannot unmarshal string into ... auto_stop_machines of type bool
    // `false` means the same thing in every version, and there is nothing for
    // auto-stop to do while `min_machines_running` keeps one up anyway.
    const line = read('fly.toml')
      .split('\n')
      .find((l) => l.trim().startsWith('auto_stop_machines'));
    expect(line).toBeDefined();
    expect(line).toMatch(/=\s*(true|false)\s*$/);
  });

  it('points the base URL at the app it actually deploys', () => {
    // The two are set in different places and a mismatch is invisible until
    // every Atom feed advertises a self-link that resolves nowhere. Only
    // checked for `.fly.dev`, so a custom domain is free to differ.
    const toml = read('fly.toml');
    const app = /^app = "([^"]+)"/m.exec(toml)?.[1];
    const base = /TOWNCIVIC_BASE_URL = "([^"]+)"/.exec(toml)?.[1] ?? '';
    expect(app).toBeDefined();
    if (base.endsWith('.fly.dev')) {
      expect(base).toBe(`https://${app}.fly.dev`);
    }
  });

  it('asks whether it can deploy before deploying', () => {
    // The whole reason preflight exists: a machine that starts, serves every
    // record, and cannot sign anybody in looks exactly like a healthy one.
    const deploy = read('.github', 'workflows', 'deploy.yml');
    expect(deploy.indexOf('npm run preflight')).toBeGreaterThan(-1);
    expect(deploy.indexOf('npm run preflight')).toBeLessThan(deploy.indexOf('flyctl deploy'));
  });

  it('never carries the deploy credential on a pull request', () => {
    const deploy = read('.github', 'workflows', 'deploy.yml');
    expect(deploy).not.toMatch(/^\s*pull_request:/m);
    expect(deploy).toMatch(/FLY_API_TOKEN/);
    // And the refresh job, which reaches out to town websites, must not hold it.
    expect(read('.github', 'workflows', 'refresh.yml')).not.toMatch(/FLY_API_TOKEN/);
  });

  it('does not give the web machine the archive credentials it never uses', () => {
    const setup = read('scripts', 'setup-fly.sh');
    const toml = read('fly.toml');
    expect(setup).not.toMatch(/^\s+S3_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|ENDPOINT)$/m);
    expect(toml).not.toMatch(/^\s+TOWNCIVIC_DOCUMENTS\s*=/m);
    expect(toml).not.toMatch(/^\s+S3_REGION\s*=/m);
  });

  it('keeps interpretation manual and deploys its published snapshot', () => {
    const refresh = read('.github', 'workflows', 'refresh.yml');
    const interpret = read('.github', 'workflows', 'interpret.yml');
    const deploy = read('.github', 'workflows', 'deploy.yml');

    expect(refresh).not.toMatch(/npm run interpret/);
    expect(interpret).toMatch(/^\s*workflow_dispatch:/m);
    expect(interpret).toMatch(/npm run interpret/);
    expect(interpret).toMatch(/npm run --silent snapshot/);
    expect(deploy).toMatch(/workflows: \['Refresh', 'Interpret'\]/);
  });

  it('caches the derived database rather than copying the R2 archive through Actions', () => {
    const refresh = read('.github', 'workflows', 'refresh.yml');
    expect(refresh).toMatch(/path: data\/towncivic\.db/g);
    expect(refresh).not.toMatch(/^\s+path: data$/m);
  });
});
