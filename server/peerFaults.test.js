// F-05 regression coverage: invalid peer submissions must actually accumulate
// faults so the advertised peerBanning protection is enforced.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createFaultRecorder,
  registrationFaultIdentifiers,
  submissionFaultIdentifiers
} from './peerFaults.js';
import { PROTECTION_STATUS } from './security.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('submission identifiers cover registered peers and peer-route client IPs', () => {
  const source = 'peer:http://peer.example';
  const identifiers = submissionFaultIdentifiers(
    { path: '/api/peer/block', ip: '::ffff:127.0.0.1' },
    source
  );
  assert.deepEqual(identifiers, [source, 'ip:127.0.0.1']);

  // Inside app.use('/api/peer', ...) Express rewrites req.path to '/block'.
  assert.deepEqual(
    submissionFaultIdentifiers({ originalUrl: '/api/peer/block?x=1', path: '/block', ip: '127.0.0.1' }),
    ['ip:127.0.0.1']
  );

  const deduped = submissionFaultIdentifiers(
    { path: '/api/peer/tx', socket: { remoteAddress: '127.0.0.1' } },
    'ip:127.0.0.1'
  );
  assert.deepEqual(deduped, ['ip:127.0.0.1']);

  assert.deepEqual(submissionFaultIdentifiers({ path: '/api/tx', ip: '127.0.0.1' }), []);
});

test('registration identifiers cover the candidate peer and the submitting client', () => {
  assert.deepEqual(
    registrationFaultIdentifiers({ ip: '10.0.0.1' }, 'http://blocked.example'),
    ['peer:http://blocked.example', 'ip:10.0.0.1']
  );
  assert.deepEqual(registrationFaultIdentifiers({}), []);
});

test('fault recorder forwards scores and survives ledger failures', async () => {
  const calls = [];
  const ledger = {
    recordPeerFault: async (...args) => {
      calls.push(args);
      return { identifier: args[0], score: args[2] };
    }
  };
  const recorder = createFaultRecorder(() => ledger);
  await recorder.record('peer:x', 'checkpoint mismatch', 2);
  await recorder.recordMany(['peer:y', 'ip:1.2.3.4'], 'invalid signature');
  assert.deepEqual(calls, [
    ['peer:x', 'checkpoint mismatch', 2],
    ['peer:y', 'invalid signature', 1],
    ['ip:1.2.3.4', 'invalid signature', 1]
  ]);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const broken = createFaultRecorder({ recordPeerFault: async () => { throw new Error('db closed'); } });
    assert.equal(await broken.record('peer:z', 'fault'), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(await createFaultRecorder(null).record('peer:z', 'fault'), null);
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

test('repeated malformed peer payloads trigger the advertised peer ban', async () => {
  assert.equal(PROTECTION_STATUS.peerBanning, true);
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-peerban-test-'));
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

    let banned = null;
    for (let attempt = 0; attempt <= PROTECTION_STATUS.peerBanScore; attempt += 1) {
      const response = await fetch(`${origin}/api/peer/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not json'
      });
      if (response.status === 403) {
        banned = await response.json();
        break;
      }
      assert.equal(response.status, 400, `unexpected status on attempt ${attempt}`);
    }
    assert.ok(banned, 'a client sending 100 malformed peer blocks must be banned');
    assert.match(banned.error, /temporarily banned/i);
    assert.equal(banned.score, PROTECTION_STATUS.peerBanScore);

    const sameClient = await fetch(`${origin}/api/node`);
    assert.equal(sameClient.status, 403, 'all API routes gate a banned client');
    const otherClient = await fetch(`${origin}/api/node`, {
      headers: { 'x-forwarded-for': '198.51.100.7' }
    });
    assert.equal(otherClient.status, 200, 'the ban is scoped to the offending client IP');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
