// Phase 4: compiled protocol parameters (Q-1, Q-2, Q-15, maturity), era-aware
// retargeting, and read-only verification of the compiled Mainnet Checkpoint 1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import {
  COIN,
  COMPILED_MAINNET_CHECKPOINTS,
  GENESIS_HASH,
  MAX_SUPPLY,
  createLedger,
  expectedDifficulty,
  rewardForHeight
} from './ledger.js';
import {
  deriveCheckpoint,
  verifyAncestry
} from './checkpoints.js';
import {
  COINBASE_MATURITY,
  HALVING_INTERVAL,
  MAX_SUPPLY_UNITS,
  TARGET_BLOCK_TIME_SECONDS,
  V2_ACTIVATION_HEIGHT,
  V2_EMISSION,
  targetBlockSecondsForHeight
} from '../shared/protocol.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('Q-1, Q-15, and maturity are compiled with the owner-selected values', () => {
  assert.equal(V2_ACTIVATION_HEIGHT, 2026);
  assert.equal(TARGET_BLOCK_TIME_SECONDS, 60);
  assert.equal(COINBASE_MATURITY, 53);
  assert.equal(HALVING_INTERVAL, 210_000);
  assert.equal(MAX_SUPPLY_UNITS, 21_000_000 * COIN);
  assert.equal(MAX_SUPPLY, MAX_SUPPLY_UNITS);

  assert.equal(V2_EMISSION.schedule, 'height-only');
  assert.equal(V2_EMISSION.changesAtV2, false);
  assert.equal(V2_EMISSION.halvingInterval, HALVING_INTERVAL);
  assert.equal(V2_EMISSION.maxSupplyUnits, MAX_SUPPLY);
});

test('the target cadence is era-aware: 15s Era 1 history, 60s V2', () => {
  assert.equal(targetBlockSecondsForHeight(1), 15);
  assert.equal(targetBlockSecondsForHeight(V2_ACTIVATION_HEIGHT - 1), 15);
  assert.equal(targetBlockSecondsForHeight(V2_ACTIVATION_HEIGHT), 60);
  assert.equal(targetBlockSecondsForHeight(10, 10), 60);
  assert.equal(targetBlockSecondsForHeight(9, 10), 15);

  const blocks = [];
  for (let height = 0; height <= 9; height += 1) {
    blocks.push({ height, difficulty: 1, timestamp: height * 15_000 });
  }
  // The same 135-second window stays at difficulty 1 under the frozen Era 1
  // target but is "fast" under the 60-second V2 target and raises difficulty.
  assert.equal(expectedDifficulty(blocks, 10, { v2ActivationHeight: 2026 }), 1);
  assert.equal(expectedDifficulty(blocks, 10, { v2ActivationHeight: 10 }), 2);
});

test('the halving schedule stays height-only and strictly capped at 21,000,000 BNKR', () => {
  assert.equal(rewardForHeight(1, 0), 50 * COIN);
  assert.equal(rewardForHeight(HALVING_INTERVAL, 0), 50 * COIN);
  assert.equal(rewardForHeight(HALVING_INTERVAL + 1, 0), 25 * COIN);
  assert.equal(rewardForHeight(2 * HALVING_INTERVAL + 1, 0), 12.5 * COIN);
  assert.equal(rewardForHeight(53 * HALVING_INTERVAL + 1, 0), 0);
  assert.equal(rewardForHeight(1, MAX_SUPPLY), 0);
  assert.equal(rewardForHeight(1, MAX_SUPPLY - 1), 1);
});

test('compiled Mainnet Checkpoint 1 is enforced by default and excluded from a testnet schedule', async () => {
  assert.equal(COMPILED_MAINNET_CHECKPOINTS.length, 1);
  const anchor = COMPILED_MAINNET_CHECKPOINTS[0];
  assert.equal(anchor.height, 731);
  assert.equal(anchor.protocolVersion, 1);
  assert.equal(anchor.blockHash,
    '000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8');
  assert.equal(anchor.chainWork, '212511536');
  assert.equal(anchor.genesisHash, GENESIS_HASH);

  const mainnet = await createLedger(':memory:');
  const testnet = await createLedger(':memory:', {
    v2ActivationHeight: 2,
    coinbaseMaturity: 5
  });
  try {
    const mainnetIdentity = mainnet.getChainIdentity();
    assert.equal(mainnetIdentity.checkpointCount, 1);
    assert.equal(mainnetIdentity.v2ActivationHeight, 2026);
    assert.equal(mainnetIdentity.coinbaseMaturity, 53);
    assert.equal(mainnetIdentity.targetBlockSeconds, 60);
    const mainnetState = await mainnet.validateStoredChain();
    assert.equal(mainnetState.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(mainnetState.checkpoints[0].height, 731);

    const testnetIdentity = testnet.getChainIdentity();
    assert.equal(testnetIdentity.checkpointCount, 0, 'a V2-era anchor would be the wrong era on testnet');
    assert.equal(testnetIdentity.v2ActivationHeight, 2);
    assert.equal(testnetIdentity.coinbaseMaturity, 5);
    const testnetState = await testnet.validateStoredChain();
    assert.equal(testnetState.checkpointState, 'UNCONFIGURED');
  } finally {
    mainnet.close();
    testnet.close();
  }
});

test('the compiled checkpoint matches a read-only derivation from bannekercoin.db (TE-63)', async (t) => {
  const source = path.join(projectRoot, 'bannekercoin.db');
  if (!existsSync(source)) {
    t.skip('bannekercoin.db is not present in this checkout');
    return;
  }

  // The source is copied before it is opened. No write handle is ever created
  // on the mainnet database, so its bytes cannot change.
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-phase4-derive-'));
  const snapshot = path.join(directory, 'snapshot.db');
  const client = createClient({ url: `file:${snapshot.replace(/\\/g, '/')}` });
  try {
    await copyFile(source, snapshot);
    for (const companion of ['-wal', '-shm']) {
      if (existsSync(`${source}${companion}`)) {
        await copyFile(`${source}${companion}`, `${snapshot}${companion}`);
      }
    }
    const rows = (await client.execute('SELECT json FROM blocks ORDER BY height')).rows;
    const blocks = rows.map(row => JSON.parse(row.json));
    assert.ok(blocks.length > 731, 'mainnet snapshot is below the checkpoint height');
    const anchor = COMPILED_MAINNET_CHECKPOINTS[0];
    const ancestry = verifyAncestry(blocks, anchor.height, { genesisHash: GENESIS_HASH });
    assert.equal(ancestry.verified, true);
    const derived = deriveCheckpoint(blocks, anchor.height, { genesisHash: GENESIS_HASH });
    assert.deepEqual(derived, anchor);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {});
  }
});
