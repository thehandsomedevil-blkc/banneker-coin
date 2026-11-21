// F-03 regression coverage: /api/node and /health must report a real build id
// and source commit derived from platform env vars or the checked-out git HEAD.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { gitHeadCommit, resolveBuildIdentity } from './buildIdentity.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = '0123456789abcdef0123456789abcdef01234567';

test('gitHeadCommit parses and validates the git output', () => {
  const exec = (command, args) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['rev-parse', 'HEAD']);
    return `${COMMIT_A}\n`;
  };
  assert.equal(gitHeadCommit({ cwd: '/repo', exec }), COMMIT_A);
  assert.equal(gitHeadCommit({ exec: () => { throw new Error('not a repo'); } }), null);
  assert.equal(gitHeadCommit({ exec: () => 'not-a-commit\n' }), null);
});

test('resolveBuildIdentity applies the documented commit precedence', () => {
  const exec = () => COMMIT_B;
  assert.deepEqual(
    resolveBuildIdentity({ env: { RENDER_GIT_COMMIT: COMMIT_A, SOURCE_COMMIT: COMMIT_B }, exec }),
    { buildId: `${COMMIT_A.slice(0, 12)}-unversioned`, sourceCommit: COMMIT_A }
  );
  assert.equal(resolveBuildIdentity({ env: { SOURCE_COMMIT: COMMIT_B }, exec }).sourceCommit, COMMIT_B);
  assert.equal(resolveBuildIdentity({ env: { BANNEKER_SOURCE_COMMIT: COMMIT_B }, exec }).sourceCommit, COMMIT_B);
  assert.equal(resolveBuildIdentity({ env: { GIT_COMMIT: COMMIT_B }, exec }).sourceCommit, COMMIT_B);
  assert.equal(resolveBuildIdentity({ env: {}, exec }).sourceCommit, COMMIT_B);
});

test('invalid commit values are ignored and an explicit build id always wins', () => {
  const exec = () => COMMIT_B;
  const identity = resolveBuildIdentity({
    env: {
      RENDER_GIT_COMMIT: 'not-a-commit',
      SOURCE_COMMIT: 'short',
      BANNEKER_BUILD_ID: 'build-42',
      TURSO_AUTH_TOKEN: 'secret-value-must-never-appear'
    },
    exec
  });
  assert.deepEqual(identity, { buildId: 'build-42', sourceCommit: COMMIT_B });
  assert.equal(JSON.stringify(identity).includes('secret-value-must-never-appear'), false);
  assert.equal(Object.isFrozen(identity), true);
});

test('a missing git HEAD still yields the documented placeholder', () => {
  assert.deepEqual(
    resolveBuildIdentity({ env: {}, exec: () => { throw new Error('no git'); } }),
    { buildId: 'dev-unversioned', sourceCommit: null }
  );
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('node and health endpoints expose the resolved provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-buildid-test-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: origin,
      BANNEKER_DB: path.join(directory, 'bannekercoin.db'),
      BANNEKER_PEERS: '',
      SOURCE_COMMIT: COMMIT_A,
      BANNEKER_BUILD_ID: 'build-verify',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      try {
        const response = await fetch(`${origin}/health`);
        ready = response.status === 200 || response.status === 503;
      } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `server did not start: ${output}`);

    const node = await (await fetch(`${origin}/api/node`)).json();
    assert.equal(node.buildId, 'build-verify');
    assert.equal(node.sourceCommit, COMMIT_A);

    const health = await (await fetch(`${origin}/health`)).json();
    assert.equal(health.buildId, 'build-verify');
    assert.equal(health.sourceCommit, COMMIT_A);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
