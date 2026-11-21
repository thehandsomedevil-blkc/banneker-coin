// F-06 regression coverage: a configured remote database is mandatory and an
// empty or unreachable remote never falls back to a fresh local genesis chain.
// Also verified: compiled checkpoints are enforced before any recovery write.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import nacl from 'nacl';
import {
  COMPILED_MAINNET_CHECKPOINTS,
  GENESIS_HASH,
  createLedger,
  hashBlock,
  resolveStorageTarget
} from './ledger.js';
import { deriveCheckpoint } from './checkpoints.js';
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
