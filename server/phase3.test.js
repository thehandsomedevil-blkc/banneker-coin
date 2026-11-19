// Phase 3: checkpoint authenticity/continuity, full account-state verification,
// and paged chain exchange with a DNS-pinned peer transport.
//
// These tests never open the live database files. Every ledger is either
// `:memory:` or a temporary file under the OS temp directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import nacl from 'nacl';
import {
  COIN,
  GENESIS_HASH,
  NETWORK_ID,
  createLedger,
  formatUnits,
  hashBlock,
  parseAmount,
  rewardForHeight,
  validateChain
} from './ledger.js';
import {
  assertCheckpointsForCandidate,
  compareCheckpointSets,
  computeCheckpointSetDigest,
  computeManifestDigest,
  deriveCheckpoint,
  evaluateCheckpointSet,
  validateCheckpointSet,
  verifyAncestry,
  verifyCheckpoint,
  CheckpointError
} from './checkpoints.js';
import {
  buildBlockPage,
  computePageHash,
  fetchPeerChain,
  verifyBlockPage,
  PageError
} from './paging.js';
import { fetchPeerJson } from './security.js';
import { buildCandidate } from '../src/miner.worker.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DAY_MS = 24 * 60 * 60 * 1000;

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function mine(template) {
  let nonce = 0;
  for (;;) {
    const block = buildCandidate(template, nonce);
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

async function mineNext(ledger, address) {
  const block = mine(await ledger.miningTemplate(address));
  await ledger.acceptBlock(block);
  return block;
}

/**
 * Builds a real in-memory chain with a real genesis. `blocks` includes genesis.
 */
async function buildChain(count, options = {}) {
  const ledger = await createLedger(':memory:', { coinbaseMaturity: 0, ...options });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  for (let index = 0; index < count; index += 1) {
    await mineNext(ledger, address);
  }
  return { ledger, miner, address, blocks: await ledger.getBlocks() };
}

function signedTransaction(pair, recipient, amount, nonce, fee = '0.001') {
  const payload = {
    sender: base64(pair.publicKey),
    recipient: base64(recipient),
    nonce,
    timestamp: Date.now()
  };
  const message = JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    String(parseAmount(amount)),
    String(parseAmount(fee)),
    nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    amount,
    fee,
    signature: base64(nacl.sign.detached(Buffer.from(message), pair.secretKey))
  };
}

function manifestFor(checkpoints, {
  sequence = 1,
  previousManifestDigest = null,
  publishedAt = null
} = {}) {
  return {
    version: 1,
    networkId: NETWORK_ID,
    genesisHash: GENESIS_HASH,
    sequence,
    previousManifestDigest,
    publishedAt,
    checkpoints
  };
}

function checkpointError(code, run) {
  assert.throws(run, error => {
    assert.ok(error instanceof CheckpointError, `expected CheckpointError, received ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function unusedPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function withHttpServer(handler, run) {
  const server = createHttpServer(handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// TE-63: recompute from canonical preimage, never trust a stored hash
// ---------------------------------------------------------------------------

test('checkpoint verification recomputes canonical hashes and ignores stored block.hash (TE-63)', async () => {
  const chain = await buildChain(3);
  const fork = await buildChain(3);
  try {
    const { blocks } = chain;
    const checkpoint = deriveCheckpoint(blocks, 2, { genesisHash: GENESIS_HASH });

    assert.equal(checkpoint.networkId, NETWORK_ID);
    assert.equal(checkpoint.protocolVersion, 1);
    assert.equal(checkpoint.height, 2);
    assert.equal(checkpoint.blockHash, hashBlock(blocks[2]));
    assert.equal(checkpoint.chainWork, blocks[2].chainWork);
    assert.equal(checkpoint.genesisHash, GENESIS_HASH);

    const verified = verifyCheckpoint(checkpoint, blocks, { genesisHash: GENESIS_HASH });
    assert.equal(verified.verified, true);
    assert.equal(verified.blockHash, hashBlock(blocks[2]));

    // A rewritten stored `hash` is ignored: the preimage is the evidence.
    const rewrittenStoredHash = blocks.map((block, index) =>
      index === 2 ? { ...block, hash: 'f'.repeat(64) } : block);
    assert.equal(verifyCheckpoint(checkpoint, rewrittenStoredHash, { genesisHash: GENESIS_HASH }).verified, true);

    // A forged preimage is rejected even when its stored hash is self-consistent.
    const forged = { ...blocks[2], message: 'forged history' };
    forged.hash = hashBlock(forged);
    const forgedChain = blocks.map((block, index) => index === 2 ? forged : block);
    checkpointError('CHECKPOINT_HASH_MISMATCH', () =>
      verifyCheckpoint(checkpoint, forgedChain, { genesisHash: GENESIS_HASH }));

    // Ancestry is a full walk, not a top-block check.
    const badWork = blocks.map((block, index) =>
      index === 2 ? { ...block, chainWork: '999' } : block);
    checkpointError('CHAINWORK_MISMATCH', () =>
      verifyAncestry(badWork, 2, { genesisHash: GENESIS_HASH }));

    // A block mined on a different parent cannot link to this ancestry, even
    // though its own PoW is valid.
    const brokenLink = blocks.map((block, index) =>
      index === 2 ? fork.blocks[2] : block);
    checkpointError('ANCESTRY_LINK_BROKEN', () =>
      verifyAncestry(brokenLink, 2, { genesisHash: GENESIS_HASH }));

    const badPow = blocks.map((block, index) =>
      index === 2 ? { ...block, difficulty: 6 } : block);
    checkpointError('POW_INVALID', () =>
      verifyAncestry(badPow, 2, { genesisHash: GENESIS_HASH }));

    checkpointError('GENESIS_MISMATCH', () =>
      verifyAncestry(blocks, 2, { genesisHash: 'a'.repeat(64) }));
    checkpointError('GENESIS_MISMATCH', () =>
      verifyCheckpoint({ ...checkpoint, genesisHash: 'a'.repeat(64) }, blocks, { genesisHash: GENESIS_HASH }));
  } finally {
    chain.ledger.close();
    fork.ledger.close();
  }
});

// ---------------------------------------------------------------------------
// K-1 … K-12
// ---------------------------------------------------------------------------

test('checkpoint continuity rules K-1 … K-12 reject removal, mutation, insertion, and unchained manifests', async () => {
  const chain = await buildChain(4);
  const other = await buildChain(4);
  try {
    const { blocks } = chain;
    const cp1 = deriveCheckpoint(blocks, 1, { genesisHash: GENESIS_HASH });
    const cp2 = deriveCheckpoint(blocks, 2, { genesisHash: GENESIS_HASH });
    const cp3 = deriveCheckpoint(blocks, 3, { genesisHash: GENESIS_HASH });

    const prior = manifestFor([cp1]);
    const priorDigest = computeManifestDigest(prior);
    const current = manifestFor([cp1, cp2], {
      sequence: 2,
      previousManifestDigest: priorDigest
    });

    const accepted = validateCheckpointSet(current, {
      genesisHash: GENESIS_HASH,
      priorManifest: prior,
      blocks
    });
    assert.equal(accepted.checkpoints.length, 2);
    assert.deepEqual(accepted.underived, []);
    assert.equal(accepted.manifestDigest, computeManifestDigest(current));
    assert.equal(
      accepted.checkpointSetDigest,
      computeCheckpointSetDigest([cp1, cp2])
    );

    // K-1 append-only.
    checkpointError('CHECKPOINT_REMOVED', () => validateCheckpointSet(
      manifestFor([cp2], { sequence: 2, previousManifestDigest: priorDigest }),
      { genesisHash: GENESIS_HASH, priorManifest: prior }
    ));

    // K-2 immutable values.
    checkpointError('CHECKPOINT_VALUE_CHANGED', () => validateCheckpointSet(
      manifestFor([{ ...cp1, blockHash: 'a'.repeat(64) }, cp2], {
        sequence: 2,
        previousManifestDigest: priorDigest
      }),
      { genesisHash: GENESIS_HASH, priorManifest: prior }
    ));

    // K-3 no retroactive insertion below the prior maximum.
    const priorMax = manifestFor([cp2]);
    checkpointError('CHECKPOINT_HEIGHT_ORDER', () => validateCheckpointSet(
      manifestFor([cp1, cp2], {
        sequence: 2,
        previousManifestDigest: computeManifestDigest(priorMax)
      }),
      { genesisHash: GENESIS_HASH, priorManifest: priorMax }
    ));

    // K-4 ancestry: a different chain cannot satisfy the tuple.
    checkpointError('CHECKPOINT_HASH_MISMATCH', () =>
      verifyCheckpoint(cp2, other.blocks, { genesisHash: GENESIS_HASH }));
    checkpointError('CHECKPOINT_VIOLATION', () =>
      assertCheckpointsForCandidate([cp2], other.blocks, { genesisHash: GENESIS_HASH }));

    // K-5 network and genesis never change.
    checkpointError('NETWORK_ID_MISMATCH', () => validateCheckpointSet(
      manifestFor([{ ...cp1, networkId: 'BLKC-MAINNET-V1' }]),
      { genesisHash: GENESIS_HASH }
    ));
    checkpointError('GENESIS_MISMATCH', () => validateCheckpointSet(
      manifestFor([{ ...cp1, genesisHash: 'b'.repeat(64) }]),
      { genesisHash: GENESIS_HASH }
    ));

    // K-6 burial below the tip.
    checkpointError('CHECKPOINT_NOT_BURIED', () => validateCheckpointSet(current, {
      genesisHash: GENESIS_HASH,
      priorManifest: prior,
      blocks,
      tipHeight: 2,
      burial: 100,
      enforceBurial: true
    }));

    // K-7 derivation is reproducible and refuses a decree.
    assert.deepEqual(
      deriveCheckpoint(blocks, 2, { genesisHash: GENESIS_HASH }),
      cp2
    );
    assert.notEqual(
      deriveCheckpoint(other.blocks, 2, { genesisHash: GENESIS_HASH }).blockHash,
      cp2.blockHash
    );
    checkpointError('CHAINWORK_MISMATCH', () =>
      verifyCheckpoint({ ...cp2, chainWork: '1' }, blocks, { genesisHash: GENESIS_HASH }));

    // K-8 publication-before-use.
    checkpointError('CHECKPOINT_PUBLICATION_UNVERIFIED', () => validateCheckpointSet(current, {
      genesisHash: GENESIS_HASH,
      priorManifest: prior,
      enforcePublication: true
    }));
    checkpointError('CHECKPOINT_PUBLICATION_WINDOW', () => validateCheckpointSet(
      manifestFor([cp1, cp2], {
        sequence: 2,
        previousManifestDigest: priorDigest,
        publishedAt: Date.now()
      }),
      { genesisHash: GENESIS_HASH, priorManifest: prior, enforcePublication: true }
    ));
    assert.equal(validateCheckpointSet(
      manifestFor([cp1, cp2], {
        sequence: 2,
        previousManifestDigest: priorDigest,
        publishedAt: Date.now() - (15 * DAY_MS)
      }),
      { genesisHash: GENESIS_HASH, priorManifest: prior, enforcePublication: true }
    ).checkpoints.length, 2);

    // K-9 manifest chaining.
    checkpointError('CHECKPOINT_MANIFEST_CHAIN_BROKEN', () => validateCheckpointSet(
      manifestFor([cp1, cp2], { sequence: 2, previousManifestDigest: 'b'.repeat(64) }),
      { genesisHash: GENESIS_HASH, priorManifest: prior }
    ));
    checkpointError('CHECKPOINT_MANIFEST_CHAIN_BROKEN', () => validateCheckpointSet(
      manifestFor([cp1, cp2], { sequence: 9, previousManifestDigest: priorDigest }),
      { genesisHash: GENESIS_HASH, priorManifest: prior }
    ));
    checkpointError('CHECKPOINT_MANIFEST_CHAIN_UNVERIFIED', () => validateCheckpointSet(
      manifestFor([cp1, cp2], { sequence: 2, previousManifestDigest: priorDigest }),
      { genesisHash: GENESIS_HASH }
    ));

    // K-10 binary binding.
    checkpointError('CHECKPOINT_MANIFEST_DIGEST_MISMATCH', () => validateCheckpointSet(current, {
      genesisHash: GENESIS_HASH,
      expectedManifestDigest: 'c'.repeat(64)
    }));

    // K-11 conflict is fatal; never resolved by work.
    const conflict = compareCheckpointSets([cp2], [{ ...cp2, blockHash: 'd'.repeat(64) }]);
    assert.equal(conflict.compatible, false);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.height, 2);
    assert.equal(conflict.field, 'blockHash');

    // K-12 recovery re-verifies the same set and refuses a substituted one.
    assert.equal(validateCheckpointSet(current, {
      genesisHash: GENESIS_HASH,
      priorManifest: current,
      blocks,
      recovery: true
    }).checkpoints.length, 2);
    checkpointError('CHECKPOINT_RECOVERY_SET_CHANGED', () => validateCheckpointSet(
      manifestFor([cp1, cp2, cp3], {
        sequence: 2,
        previousManifestDigest: priorDigest
      }),
      { genesisHash: GENESIS_HASH, priorManifest: current, blocks, recovery: true }
    ));

    // Aggregate states.
    const checkpointOptions = { genesisHash: GENESIS_HASH, networkId: NETWORK_ID };
    assert.equal(evaluateCheckpointSet([], blocks, checkpointOptions).checkpointState, 'UNCONFIGURED');
    assert.equal(
      evaluateCheckpointSet([cp2], blocks.slice(0, 2), checkpointOptions).checkpointState,
      'NOT_YET_APPLICABLE'
    );
    assert.equal(evaluateCheckpointSet([cp2], blocks, checkpointOptions).checkpointState, 'APPLICABLE');
    const violated = evaluateCheckpointSet([cp2], other.blocks, checkpointOptions);
    assert.equal(violated.checkpointState, 'VIOLATED');
    assert.equal(violated.checkpointErrors[0].code, 'CHECKPOINT_HASH_MISMATCH');
  } finally {
    chain.ledger.close();
    other.ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Ledger integration: admission and replacement
// ---------------------------------------------------------------------------

test('a configured checkpoint blocks admission and a higher-work fork before any work comparison', async () => {
  const source = await buildChain(3);
  const fork = await buildChain(6);
  let ledger;
  let accepted;
  try {
    const checkpoint = deriveCheckpoint(source.blocks, 2, { genesisHash: GENESIS_HASH });

    ledger = await createLedger(':memory:', {
      checkpoints: [checkpoint],
      checkpointBurial: 0,
      coinbaseMaturity: 0
    });
    const miner = nacl.sign.keyPair();
    const address = base64(miner.publicKey);

    assert.equal((await ledger.getTipHeight()), 0);
    const fresh = await ledger.validateStoredChain();
    assert.equal(fresh.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(fresh.checkpoints[0].state, 'NOT_YET_APPLICABLE');
    assert.equal(fresh.accountsValid, true);
    assert.equal(fresh.healthy, true);

    await mineNext(ledger, address);
    const before = await ledger.getBlocks();
    assert.equal(before.length, 2);

    const secondTemplate = await ledger.miningTemplate(address);
    const rejected = mine(secondTemplate);
    await assert.rejects(
      () => ledger.acceptBlock(rejected),
      error => error.code === 'CHECKPOINT_HASH_MISMATCH'
    );
    // Rejection happens before the database write.
    assert.equal((await ledger.getTipHeight()), 1);
    assert.equal((await ledger.getBlocks()).length, 2);

    // The fork is longer and therefore has more cumulative work. K-11 still wins.
    assert.ok(BigInt(fork.blocks[fork.blocks.length - 1].chainWork) >
      BigInt(before[before.length - 1].chainWork));
    await assert.rejects(
      () => ledger.replaceChain(fork.blocks),
      error => error.code === 'CHECKPOINT_VIOLATION'
    );
    assert.equal((await ledger.getTipHeight()), 1);

    // A chain that reproduces the anchor is accepted normally.
    accepted = await createLedger(':memory:', {
      checkpoints: [checkpoint],
      checkpointBurial: 0,
      coinbaseMaturity: 0
    });
    const replacement = await accepted.replaceChain(source.blocks);
    assert.equal(replacement.replaced, true);
    const validated = await accepted.validateStoredChain();
    assert.equal(validated.valid, true);
    assert.equal(validated.accountsValid, true);
    assert.equal(validated.checkpointState, 'APPLICABLE');
    assert.equal(validated.checkpoints[0].state, 'APPLICABLE');
    assert.equal(validated.healthy, true);
  } finally {
    ledger?.close();
    accepted?.close();
    source.ledger.close();
    fork.ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Full account-state verification (B0 gap)
// ---------------------------------------------------------------------------

test('stored account state is verified explicitly and reports structured errors', async () => {
  const chain = await buildChain(2);
  const { ledger, address } = chain;
  try {
    const baseline = await ledger.validateStoredChain();
    assert.equal(baseline.valid, true);
    assert.equal(baseline.storageValid, true);
    assert.equal(baseline.accountsValid, true);
    assert.deepEqual(baseline.accountErrors, []);
    assert.equal(baseline.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(baseline.healthy, true);

    const original = (await ledger.client.execute({
      sql: 'SELECT balance_units, nonce FROM accounts WHERE address = ?',
      args: [address]
    })).rows[0];
    const balance = Number(original.balance_units);
    const nonce = Number(original.nonce);

    await ledger.client.execute({
      sql: 'UPDATE accounts SET balance_units = ? WHERE address = ?',
      args: [balance + 1, address]
    });
    const balanceMismatch = await ledger.validateStoredChain();
    assert.equal(balanceMismatch.valid, true, 'chain replay is still valid');
    assert.equal(balanceMismatch.accountsValid, false);
    assert.equal(balanceMismatch.accountErrors[0].code, 'BALANCE_MISMATCH');
    assert.equal(balanceMismatch.accountErrors[0].address, address);
    assert.equal(balanceMismatch.healthy, false);

    const state = await ledger.networkState(address);
    assert.equal(state.accountsValid, false);
    assert.equal(state.accountErrors[0].code, 'BALANCE_MISMATCH');
    assert.equal(state.healthy, false);
    assert.equal(state.genesisHash, GENESIS_HASH);
    assert.equal(state.checkpointState, 'NOT_YET_APPLICABLE');

    await ledger.client.execute({
      sql: 'UPDATE accounts SET balance_units = ?, nonce = ? WHERE address = ?',
      args: [balance, nonce + 7, address]
    });
    const nonceMismatch = await ledger.validateStoredChain();
    assert.equal(nonceMismatch.accountsValid, false);
    assert.ok(nonceMismatch.accountErrors.some(error => error.code === 'NONCE_MISMATCH'));

    await ledger.client.execute({
      sql: 'DELETE FROM accounts WHERE address = ?',
      args: [address]
    });
    const missing = await ledger.validateStoredChain();
    assert.equal(missing.accountsValid, false);
    assert.ok(missing.accountErrors.some(error => error.code === 'ACCOUNT_MISSING'));

    await ledger.client.execute({
      sql: 'INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, ?)',
      args: [address, balance, nonce]
    });
    const extraAddress = base64(nacl.sign.keyPair().publicKey);
    await ledger.client.execute({
      sql: 'INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, ?)',
      args: [extraAddress, 1, 0]
    });
    const extra = await ledger.validateStoredChain();
    assert.equal(extra.accountsValid, false);
    assert.ok(extra.accountErrors.some(error => error.code === 'ACCOUNT_EXTRA'));
    assert.ok(extra.accountErrors.some(error => error.code === 'SUPPLY_MISMATCH'));
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Deterministic full-chain replay
// ---------------------------------------------------------------------------

test('full replay verifies signatures, nonces, fees, rewards, and coinbase maturity at inclusion height', async () => {
  const ledger = await createLedger(':memory:', { coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    await mineNext(ledger, address);
    const transfer = signedTransaction(miner, recipient.publicKey, '1', 1);
    await ledger.acceptTransaction(transfer);
    const withSpend = await mineNext(ledger, address);
    assert.equal(withSpend.transactions.length, 1);

    const blocks = await ledger.getBlocks();
    assert.equal(validateChain(blocks, { coinbaseMaturity: 0 }).valid, true);

    // A historical spend of an immature coinbase is invalid under the rule that
    // is evaluated at the spend's inclusion height, not at the tip.
    const immature = validateChain(blocks, {
      coinbaseMaturity: 100,
      coinbaseMaturityHeight: 1
    });
    assert.equal(immature.valid, false);
    assert.match(immature.error, /immature coinbase/i);

    const tx = blocks[2].transactions[0];
    const flipped = tx.signature[0] === 'A' ? `B${tx.signature.slice(1)}` : `A${tx.signature.slice(1)}`;
    const badSignature = blocks.map((block, index) => index === 2
      ? { ...block, transactions: [{ ...tx, signature: flipped }] }
      : block);
    const signatureResult = validateChain(badSignature, { coinbaseMaturity: 0 });
    assert.equal(signatureResult.valid, false);

    const duplicateNonce = blocks.map((block, index) => index === 2
      ? { ...block, transactions: [tx, { ...tx }] }
      : block);
    const nonceResult = validateChain(duplicateNonce, { coinbaseMaturity: 0 });
    assert.equal(nonceResult.valid, false);
    assert.match(nonceResult.error, /nonce/i);

    const inflatedReward = blocks.map((block, index) => index === 1
      ? { ...block, reward: { ...block.reward, amount: formatUnits((50 * COIN) + COIN) } }
      : block);
    const rewardResult = validateChain(inflatedReward, { coinbaseMaturity: 0 });
    assert.equal(rewardResult.valid, false);
    assert.match(rewardResult.error, /reward/i);

    // Halving schedule sanity: the subsidy at height 1 is the initial reward.
    assert.equal(rewardForHeight(1, 0), 50 * COIN);
    assert.equal(rewardForHeight(210_001, 0), 25 * COIN);
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// Paged chain exchange (C-14 / C-16 / R-17)
// ---------------------------------------------------------------------------

test('paged exchange chains pages by hash and rejects tampered, reordered, and oversized pages', async () => {
  const chain = await buildChain(5);
  try {
    const { blocks } = chain;
    const tipHeight = blocks[blocks.length - 1].height;
    const page0 = buildBlockPage({
      blocks,
      fromHeight: 0,
      toHeight: 1,
      tipHeight,
      genesisHash: GENESIS_HASH,
      pageIndex: 0,
      prevPageHash: null,
      maxBlocks: 2
    });
    const page1 = buildBlockPage({
      blocks,
      fromHeight: 2,
      toHeight: 3,
      tipHeight,
      genesisHash: GENESIS_HASH,
      pageIndex: 1,
      prevPageHash: page0.pageHash,
      maxBlocks: 2
    });

    assert.equal(page0.blocks.length, 2);
    assert.equal(page0.toHeight, 1);
    assert.equal(page0.tipHeight, tipHeight);
    assert.equal(computePageHash(page0), page0.pageHash);

    const verified0 = verifyBlockPage(page0, {
      expectedFromHeight: 0,
      expectedPageIndex: 0,
      expectedPrevPageHash: null,
      genesisHash: GENESIS_HASH
    });
    assert.equal(verified0.blocks.length, 2);
    const verified1 = verifyBlockPage(page1, {
      expectedFromHeight: 2,
      expectedPageIndex: 1,
      expectedPrevPageHash: page0.pageHash,
      genesisHash: GENESIS_HASH
    });
    assert.equal(verified1.pageHash, page1.pageHash);

    assert.throws(
      () => verifyBlockPage({ ...page0, tipHeight: 99 }, {
        expectedFromHeight: 0,
        expectedPageIndex: 0,
        expectedPrevPageHash: null,
        genesisHash: GENESIS_HASH
      }),
      error => error instanceof PageError && error.code === 'PAGE_HASH_MISMATCH'
    );
    assert.throws(
      () => verifyBlockPage(page0, {
        expectedFromHeight: 0,
        expectedPageIndex: 1,
        expectedPrevPageHash: null,
        genesisHash: GENESIS_HASH
      }),
      error => error.code === 'PAGE_INDEX_MISMATCH'
    );
    assert.throws(
      () => verifyBlockPage(page1, {
        expectedFromHeight: 2,
        expectedPageIndex: 1,
        expectedPrevPageHash: null,
        genesisHash: GENESIS_HASH
      }),
      error => error.code === 'PAGE_PREV_HASH_MISMATCH'
    );
    assert.throws(
      () => verifyBlockPage(page0, {
        expectedFromHeight: 5,
        expectedPageIndex: 0,
        expectedPrevPageHash: null,
        genesisHash: GENESIS_HASH
      }),
      error => error.code === 'PAGE_HEIGHT_MISMATCH'
    );

    const reordered = { ...page0, blocks: [page0.blocks[1], page0.blocks[0]] };
    reordered.pageHash = computePageHash(reordered);
    assert.throws(
      () => verifyBlockPage(reordered, {
        expectedFromHeight: 0,
        expectedPageIndex: 0,
        expectedPrevPageHash: null,
        genesisHash: GENESIS_HASH
      }),
      error => error.code === 'PAGE_GAP'
    );

    assert.throws(
      () => buildBlockPage({
        blocks,
        fromHeight: 0,
        tipHeight,
        genesisHash: GENESIS_HASH,
        maxBytes: 1100
      }),
      error => error.code === 'PAGE_BLOCK_TOO_LARGE'
    );
  } finally {
    chain.ledger.close();
  }
});

async function withPagedPeer(blocks, { mutatePage = null } = {}, run) {
  const tipHeight = blocks[blocks.length - 1].height;
  await withHttpServer((req, res) => {
    const url = new URL(req.url, 'http://peer.invalid');
    if (url.pathname !== '/api/peer/blocks') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const pageIndex = Number(url.searchParams.get('page') || '0');
    const prev = url.searchParams.get('prev') || null;
    const page = buildBlockPage({
      blocks,
      fromHeight: from,
      toHeight: Math.min(to, from + 1),
      tipHeight,
      genesisHash: GENESIS_HASH,
      pageIndex,
      prevPageHash: prev,
      maxBlocks: 2
    });
    const payload = mutatePage ? mutatePage(page) : page;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, async origin => {
    await run(origin);
  });
}

test('fetchPeerChain follows the cursor across pages and aborts on a tampered page', async () => {
  const chain = await buildChain(5);
  try {
    const { blocks } = chain;
    const tipHeight = blocks[blocks.length - 1].height;

    await withPagedPeer(blocks, {}, async origin => {
      const result = await fetchPeerChain(origin, {
        genesisHash: GENESIS_HASH,
        allowPrivate: true,
        pageBlocks: 2
      });
      assert.equal(result.blocks.length, blocks.length);
      assert.deepEqual(
        result.blocks.map(block => block.height),
        blocks.map(block => block.height)
      );
      assert.equal(result.pages, 3);
      assert.equal(result.tipHeight, tipHeight);
      assert.ok(result.bytes > 0);
    });

    await withPagedPeer(blocks, {
      mutatePage: page => ({ ...page, tipHeight: page.tipHeight + 1 })
    }, async origin => {
      await assert.rejects(
        () => fetchPeerChain(origin, {
          genesisHash: GENESIS_HASH,
          allowPrivate: true,
          pageBlocks: 2
        }),
        error => error.code === 'PAGE_HASH_MISMATCH'
      );
    });
  } finally {
    chain.ledger.close();
  }
});

// ---------------------------------------------------------------------------
// DNS pinning
// ---------------------------------------------------------------------------

test('peer transport connects to the screened address, closing the DNS rebinding window', async () => {
  let observedHost = null;
  await withHttpServer((req, res) => {
    observedHost = req.headers.host;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag: 'pinned-peer' }));
  }, async (_origin, port) => {
    // `pinned.invalid` is a reserved name that cannot resolve through public DNS.
    // The only way this request reaches the fixture is the injected lookup that
    // is bound into the socket agent.
    const info = await fetchPeerJson(`http://pinned.invalid:${port}/node`, {
      allowPrivate: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    assert.equal(info.tag, 'pinned-peer');
    // Host (and SNI) keep the hostname; only the socket is pinned.
    assert.equal(observedHost, `pinned.invalid:${port}`);
  });
});

// ---------------------------------------------------------------------------
// API surfaces: /health, /api/node, /api/validate, /api/peer/blocks
// ---------------------------------------------------------------------------

async function withNode(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-phase3-test-'));
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
      BANNEKER_CHECKPOINTS: '',
      BANNEKER_CHECKPOINT_MANIFEST_DIGEST: '',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  try {
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test node exited early: ${output}`);
      try {
        const response = await fetch(`${origin}/health`);
        ready = response.status === 200;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!ready) throw new Error(`Test node did not become ready: ${output}`);
    await run(origin);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('health, node identity, validate, and paged block routes expose the required state', async () => {
  await withNode(async origin => {
    const healthResponse = await fetch(`${origin}/health`);
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get('content-type') || '', /application\/json/);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(typeof health.buildId, 'string');
    assert.equal(health.protocolVersion, 2);
    assert.equal(health.networkId, NETWORK_ID);
    assert.equal(health.genesisHash, GENESIS_HASH);
    assert.equal(health.height, 0);
    assert.equal(health.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(health.storage, 'local');
    assert.equal(health.accountsValid, true);
    assert.equal(health.reasonCode, undefined);

    const node = await (await fetch(`${origin}/api/node`)).json();
    assert.equal(node.networkId, NETWORK_ID);
    assert.equal(node.protocolVersion, 2);
    assert.equal(node.genesisHash, GENESIS_HASH);
    assert.equal(node.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(node.accountsValid, true);
    assert.equal(typeof node.manifestDigest, 'string');
    assert.equal(typeof node.checkpointSetDigest, 'string');

    const validate = await (await fetch(`${origin}/api/validate`)).json();
    assert.equal(validate.valid, true);
    assert.equal(validate.accountsValid, true);
    assert.deepEqual(validate.accountErrors, []);
    assert.equal(validate.storageValid, true);
    assert.equal(validate.checkpointState, 'NOT_YET_APPLICABLE');
    assert.equal(validate.healthy, true);

    const page = await (await fetch(`${origin}/api/peer/blocks?from=0&to=0&page=0`)).json();
    assert.equal(page.networkId, NETWORK_ID);
    assert.equal(page.genesisHash, GENESIS_HASH);
    assert.equal(page.protocolVersion, 2);
    assert.equal(page.fromHeight, 0);
    assert.equal(page.toHeight, 0);
    assert.equal(page.tipHeight, 0);
    assert.equal(page.blocks.length, 1);
    assert.equal(page.blocks[0].height, 0);
    assert.equal(computePageHash(page), page.pageHash);

    const capped = await (await fetch(`${origin}/api/peer/blocks?from=0&to=999999&page=0`)).json();
    assert.equal(capped.toHeight, 0);

    const invalid = await fetch(`${origin}/api/peer/blocks?from=not-a-height`);
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.code, 'PAGE_INVALID');
  });
});
