// Bidirectional peer discovery / chain-sync integration coverage.
// Two fully isolated nodes are spawned with temp databases and loopback peering
// explicitly enabled. No repository .db file is ever opened.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import nacl from 'nacl';
import { hashBlock } from './ledger.js';
import { assertPeerHostAllowed, isPublicAdvertisedOrigin, parsePeerUrl } from './security.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function startNode({ directory, name, seedPeers }) {
  return (async () => {
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_URL: origin,
        DB_PATH: path.join(directory, `${name}.db`),
        SEED_PEERS: seedPeers,
        BANNEKER_PEERS: '',
        ALLOW_LOCAL_PEERS: 'true',
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

    return {
      origin,
      port,
      output: () => output,
      ready: () => waitFor(`${name} ready`, async () => {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
        return response.status === 200;
      }),
      stop: async () => {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    };
  })();
}

function mine(template) {
  let nonce = 0;
  while (true) {
    const block = { ...template, nonce };
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

async function getJson(origin, route) {
  const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status}: ${await response.text()}`);
  return response.json();
}

test('advertised origin helper rejects internal defaults before registration', () => {
  assert.equal(isPublicAdvertisedOrigin('https://banneker-coin.onrender.com'), true);
  assert.equal(isPublicAdvertisedOrigin('https://the-black-coin.onrender.com'), true);
  assert.equal(isPublicAdvertisedOrigin('http://0.0.0.0:10000'), false);
  assert.equal(isPublicAdvertisedOrigin('http://127.0.0.1:4174'), false);
  assert.equal(isPublicAdvertisedOrigin('http://localhost:4174'), false);
  assert.equal(isPublicAdvertisedOrigin('https://node.internal'), false);
  assert.equal(isPublicAdvertisedOrigin('https://example.com/path'), false);
  assert.equal(isPublicAdvertisedOrigin('not a url'), false);
});

test('public HTTPS peer origins pass SSRF screening, private ones still fail', async () => {
  const parsed = parsePeerUrl('https://banneker-coin.onrender.com');
  assert.equal(parsed.origin, 'https://banneker-coin.onrender.com');

  // Documentation and loopback ranges stay blocked even for a public hostname.
  await assert.rejects(
    assertPeerHostAllowed('banneker-coin.onrender.com', {
      lookup: async () => [{ address: '203.0.113.10', family: 4 }]
    }),
    /documentation range/
  );
  const allowed = await assertPeerHostAllowed('banneker-coin.onrender.com', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }]
  });
  assert.deepEqual(allowed, [{ address: '8.8.8.8', family: 4 }]);

  await assert.rejects(
    assertPeerHostAllowed('peer.internal', { lookup: async () => [{ address: '10.0.0.5', family: 4 }] }),
    /PEER_ADDRESS_BLOCKED|Refusing peer host/
  );
  await assert.rejects(
    assertPeerHostAllowed('peer.internal', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      allowPrivate: false
    }),
    /Refusing peer host/
  );
});

test('Node B bootstraps from Node A with bidirectional registration and chain sync',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-peer-discovery-'));
    let nodeA;
    let nodeB;
    try {
      nodeA = await startNode({ directory, name: 'node-a', seedPeers: '' });
      await nodeA.ready();

      // Give Node A a chain worth syncing before Node B boots.
      const miner = nacl.sign.keyPair();
      const minerAddress = Buffer.from(miner.publicKey).toString('base64');
      for (let height = 1; height <= 2; height += 1) {
        const template = await getJson(nodeA.origin, `/api/mining/template?miner=${encodeURIComponent(minerAddress)}`);
        const response = await fetch(`${nodeA.origin}/api/mining/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mine(template))
        });
        assert.equal(response.status, 201, `mining submit failed: ${await response.text()}`);
      }
      const chainAtA = await getJson(nodeA.origin, '/api/state');
      assert.equal(chainAtA.height, 2);

      // Node B boots with A as its seed. The bootstrap performs both halves of
      // discovery: A is added locally, and B registers itself with A.
      nodeB = await startNode({ directory, name: 'node-b', seedPeers: nodeA.origin });
      await nodeB.ready();

      await waitFor('bidirectional peer registration', async () => {
        const [peersAtA, peersAtB] = await Promise.all([
          getJson(nodeA.origin, '/api/peers'),
          getJson(nodeB.origin, '/api/peers')
        ]);
        return peersAtA.peers.some(peer => peer.url === nodeB.origin) &&
          peersAtB.peers.some(peer => peer.url === nodeA.origin);
      });

      // Force an immediate sync instead of waiting for the 30s interval.
      const syncResponse = await fetch(`${nodeB.origin}/api/peers/sync`, { method: 'POST' });
      assert.equal(syncResponse.status, 200);
      await waitFor('Node B tip matches Node A', async () => {
        const [stateA, stateB] = await Promise.all([
          getJson(nodeA.origin, '/api/state'),
          getJson(nodeB.origin, '/api/state')
        ]);
        return stateA.height === 2 && stateB.height === stateA.height &&
          stateB.latestBlock.hash === stateA.latestBlock.hash;
      });

      const [infoA, infoB, stateA, stateB] = await Promise.all([
        getJson(nodeA.origin, '/api/node'),
        getJson(nodeB.origin, '/api/node'),
        getJson(nodeA.origin, '/api/state'),
        getJson(nodeB.origin, '/api/state')
      ]);
      assert.equal(infoA.peers, 1);
      assert.equal(infoB.peers, 1);
      assert.equal(stateA.latestBlock.hash, stateB.latestBlock.hash);
      assert.equal(stateA.checkpointState, stateB.checkpointState);
      assert.notEqual(stateB.checkpointState, 'VIOLATED');
      assert.equal(stateB.accountsValid, true);
      assert.equal(stateB.supply, stateA.supply);

      const [peersAtA, peersAtB] = await Promise.all([
        getJson(nodeA.origin, '/api/peers'),
        getJson(nodeB.origin, '/api/peers')
      ]);
      assert.equal(peersAtA.peers.some(peer => isSelfUrl(peer.url, [nodeA.origin])), false,
        'Node A must not list itself as a peer');
      assert.equal(peersAtB.peers.some(peer => isSelfUrl(peer.url, [nodeB.origin])), false,
        'Node B must not list itself as a peer');
    } finally {
      if (nodeB) await nodeB.stop();
      if (nodeA) await nodeA.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });

function isSelfUrl(url, origins) {
  const normalized = String(url).replace(/\/+$/, '').toLowerCase();
  return origins.some(origin => origin.replace(/\/+$/, '').toLowerCase() === normalized);
}
