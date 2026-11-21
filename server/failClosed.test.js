// F-06 regression coverage: a configured remote database is mandatory. An
// unreachable remote always fails closed; a completely empty remote may seed
// only the compiled genesis, and only when a seed peer (or explicit flag)
// exists so the rest of the chain can be synced. Compiled checkpoints are still
// verified before any rollback or account rebuild.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import nacl from 'nacl';
import {
  COMPILED_MAINNET_CHECKPOINTS,
  GENESIS_HASH,
  createLedger,
  hashBlock,
  remoteGenesisSeedingAllowed,
  resolveStorageTarget
} from './ledger.js';
import { deriveCheckpoint } from './checkpoints.js';
import { buildBlockPage, fetchPeerChain } from './paging.js';
import { V2_ACTIVATION_HEIGHT } from '../shared/protocol.js';

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
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

// Minimal libsql-client-shaped adapter backed by an in-memory SQLite database.
// It lets us exercise the real remote-storage branch without a Turso account.
function createMemoryClient() {
  const db = new Database(':memory:');
  let closed = false;

  const run = (statement, args = []) => {
    db.prepare(String(statement)).run(...args);
    return { rows: [] };
  };
  const read = (statement, args = []) => ({
    rows: db.prepare(String(statement)).all(...args)
  });
  const runBatch = statements => {
    for (const statement of statements) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const args = typeof statement === 'string' ? [] : (statement.args ?? []);
      run(sql, args);
    }
    return { rows: [] };
  };

  const client = {
    async execute(input) {
      const sql = typeof input === 'string' ? input : input?.sql;
      const args = typeof input === 'string' ? [] : (input?.args ?? []);
      return /^(?:SELECT|PRAGMA|WITH|EXPLAIN)/i.test(String(sql).trim())
        ? read(sql, args)
        : run(sql, args);
    },
    async batch(statements) {
      return db.transaction(() => runBatch(statements))();
    },
    async transaction() {
      db.exec('BEGIN');
      let settled = false;
      const finish = action => {
        if (settled) return;
        settled = true;
        db.exec(action);
      };
      return {
        execute: client.execute,
        batch: async statements => runBatch(statements),
        commit: async () => finish('COMMIT'),
        rollback: async () => finish('ROLLBACK')
      };
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  };
  return client;
}

async function startSeedPeer(blocks, identity) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/peer/blocks') {
      res.writeHead(404).end();
      return;
    }
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const pageIndex = Number(url.searchParams.get('page') ?? 0);
    const prev = url.searchParams.get('prev');
    const page = buildBlockPage({
      blocks,
      fromHeight: from,
      toHeight: Number.isSafeInteger(to) ? to : undefined,
      tipHeight: blocks.length ? blocks[blocks.length - 1].height : 0,
      networkId: identity.networkId,
      genesisHash: identity.genesisHash,
      protocolVersion: identity.protocolVersion,
      checkpointSetDigest: identity.checkpointSetDigest,
      pageIndex,
      prevPageHash: prev
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
}

test('resolveStorageTarget uses a local file only when no remote URL is configured', () => {
  const local = resolveStorageTarget({}, 'local.db');
  assert.equal(local.url, 'file:local.db');
  assert.equal(local.remote, false);
  assert.equal(Object.isFrozen(local), true);
});

test('resolveStorageTarget normalizes libsql and keeps the auth token out of the URL', () => {
  const remote = resolveStorageTarget({
    TURSO_DATABASE_URL: 'libsql://example.turso.io',
    TURSO_AUTH_TOKEN: 'not-a-real-token'
  }, 'ignored.db');
  assert.equal(remote.url, 'https://example.turso.io');
  assert.equal(remote.remote, true);
  assert.equal(remote.token, 'not-a-real-token');
  assert.match(remote.url, /^https:\/\//);
});

test('resolveStorageTarget fails closed on non-HTTPS URLs or a missing token', () => {
  assert.throws(
    () => resolveStorageTarget({ TURSO_DATABASE_URL: 'file:fallback.db' }, 'local.db'),
    error => error.code === 'REMOTE_STORAGE_CONFIG_INVALID' && /fallback is disabled/i.test(error.message)
  );
  assert.throws(
    () => resolveStorageTarget({ TURSO_DATABASE_URL: 'https://example.turso.io' }, 'local.db'),
    error => error.code === 'REMOTE_STORAGE_CONFIG_INVALID' && /TURSO_AUTH_TOKEN is required/i.test(error.message)
  );
  assert.throws(
    () => resolveStorageTarget({ TURSO_DATABASE_URL: 'http://example.turso.io', TURSO_AUTH_TOKEN: 'x' }, 'local.db'),
    error => error.code === 'REMOTE_STORAGE_CONFIG_INVALID'
  );
});

test('an unreachable configured remote is fatal and never creates a local chain', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-failclosed-remote-'));
  const databasePath = path.join(directory, 'local.db');
  const env = {
    TURSO_DATABASE_URL: 'https://127.0.0.1:1',
    TURSO_AUTH_TOKEN: 'not-a-real-token'
  };
  try {
    await assert.rejects(
      createLedger(databasePath, { checkpoints: [] }, env),
      error => error.code === 'REMOTE_STORAGE_UNAVAILABLE' && /refusing to start/i.test(error.message)
    );
    assert.equal(existsSync(databasePath), false, 'no local SQLite file may be created');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test('remoteGenesisSeedingAllowed requires a seed peer or explicit operator flag', () => {
  assert.equal(remoteGenesisSeedingAllowed({}), false);
  assert.equal(remoteGenesisSeedingAllowed({ SEED_PEERS: '   ' }), false);
  assert.equal(remoteGenesisSeedingAllowed({ SEED_PEERS: 'https://seed.example' }), true);
  assert.equal(remoteGenesisSeedingAllowed({ PEERS: 'https://seed.example' }), true);
  assert.equal(remoteGenesisSeedingAllowed({ ALLOW_REMOTE_GENESIS: 'true' }), true);
});

test('an empty remote without a seed peer still fails closed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-failclosed-empty-remote-'));
  const env = {
    TURSO_DATABASE_URL: 'https://empty.example.turso.io',
    TURSO_AUTH_TOKEN: 'not-a-real-token',
    SEED_PEERS: ''
  };
  try {
    await assert.rejects(
      createLedger(path.join(directory, 'node.db'), {
        checkpoints: [],
        clientFactory: createMemoryClient
      }, env),
      error => error.code === 'REMOTE_STORAGE_EMPTY' && /no seed peer is configured/i.test(error.message)
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test('an empty remote with SEED_PEERS seeds exact compiled genesis and syncs from the seed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-remote-genesis-sync-'));
  const miner = nacl.sign.keyPair();
  let reference;
  let source;
  let remote;
  let seed;
  try {
    reference = await createLedger(path.join(directory, 'reference.db'), { checkpoints: [] });
    const expectedGenesis = (await reference.getBlocks())[0];
    assert.equal(expectedGenesis.hash, GENESIS_HASH);

    source = await createLedger(path.join(directory, 'seed-node.db'), { checkpoints: [] });
    const minerAddress = base64(miner.publicKey);
    for (let height = 1; height <= 2; height += 1) {
      const template = await source.miningTemplate(minerAddress);
      await source.acceptBlock(mine(template));
    }
    const sourceBlocks = await source.getBlocks();
    assert.equal(sourceBlocks.length, 3);
    seed = await startSeedPeer(sourceBlocks, source.getChainIdentity());

    remote = await createLedger(path.join(directory, 'node-b.db'), {
      checkpoints: [],
      clientFactory: createMemoryClient
    }, {
      TURSO_DATABASE_URL: 'https://empty.example.turso.io',
      TURSO_AUTH_TOKEN: 'not-a-real-token',
      SEED_PEERS: seed.origin
    });

    const seededBlocks = await remote.getBlocks();
    assert.equal(seededBlocks.length, 1, 'only genesis may be auto-seeded');
    assert.equal(seededBlocks[0].height, 0);
    assert.equal(seededBlocks[0].hash, GENESIS_HASH);
    assert.deepEqual(seededBlocks[0], expectedGenesis);

    const identity = remote.getChainIdentity();
    const downloaded = await fetchPeerChain(seed.origin, {
      genesisHash: identity.genesisHash,
      networkId: identity.networkId,
      protocolVersion: identity.protocolVersion,
      checkpointSetDigest: identity.checkpointSetDigest,
      allowPrivate: true
    });
    assert.equal(downloaded.blocks.length, 3);

    const replaced = await remote.replaceChain(downloaded.blocks);
    assert.equal(replaced.replaced, true);
    assert.deepEqual(await remote.getBlocks(), sourceBlocks);
    assert.equal((await remote.networkState()).height, 2);
  } finally {
    if (remote) remote.close();
    if (seed) await seed.close();
    if (source) source.close();
    if (reference) reference.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test('startup verifies compiled checkpoints before rollback or account rebuild', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-failclosed-cp-'));
  const databasePath = path.join(directory, 'bannekercoin.db');
  const miner = nacl.sign.keyPair();
  let ledger;
  try {
    ledger = await createLedger(databasePath, { checkpoints: [] });
    for (let height = 1; height <= 3; height += 1) {
      const template = await ledger.miningTemplate(base64(miner.publicKey));
      await ledger.acceptBlock(mine(template));
    }
    const blocks = await ledger.getBlocks();
    assert.equal(blocks.length, 4);
    const good = deriveCheckpoint(blocks, 2, { genesisHash: GENESIS_HASH });
    const conflicting = { ...good, blockHash: '0'.repeat(64) };
    ledger.close();
    ledger = null;

    await assert.rejects(
      createLedger(databasePath, { checkpoints: [conflicting] }),
      /checkpoint/i
    );

    const intact = await createLedger(databasePath, { checkpoints: [] });
    try {
      assert.equal((await intact.getBlocks()).length, 4, 'checkpoint failure must not truncate the chain');
      const validation = await intact.validateStoredChain();
      assert.equal(validation.valid, true, 'checkpoint failure must not rebuild accounts');
    } finally {
      intact.close();
    }
  } finally {
    if (ledger) ledger.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test('guardrails: compiled anchors and V2 activation height remain unchanged', () => {
  assert.deepEqual(COMPILED_MAINNET_CHECKPOINTS.map(checkpoint => checkpoint.height), [731, 2500]);
  assert.equal(V2_ACTIVATION_HEIGHT, 5000);
});
