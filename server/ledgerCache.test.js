import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'nacl';
import { createLedger, hashBlock, NETWORK_ID, parseAmount } from './ledger.js';

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

async function mineHeight(ledger, address, height, timeStep = 15_000) {
  const template = await ledger.miningTemplate(address);
  template.timestamp = (await ledger.getBlocks())[0].timestamp + height * timeStep;
  return ledger.acceptBlock(mine(template));
}

/**
 * Wraps the storage client so tests can prove request handlers never fall back
 * to full chain/account/peer scans after startup. Mempool reads are intentionally
 * left live and are not counted here.
 */
function instrumentReads(ledger) {
  const originalExecute = ledger.client.execute.bind(ledger.client);
  const counts = { blockScans: 0, accountReads: 0, peerReads: 0, tipReads: 0 };
  ledger.client.execute = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
    if (typeof sql === 'string') {
      if (/FROM blocks/.test(sql)) counts.blockScans += 1;
      if (/FROM accounts/.test(sql)) counts.accountReads += 1;
      if (/FROM peers/.test(sql)) counts.peerReads += 1;
      if (/MAX\(height\) FROM blocks/.test(sql)) counts.tipReads += 1;
    }
    return originalExecute(...args);
  };
  const reset = () => {
    counts.blockScans = 0;
    counts.accountReads = 0;
    counts.peerReads = 0;
    counts.tipReads = 0;
  };
  return { counts, reset };
}

test('read endpoints resolve from the validated snapshot without SQL row scans', async () => {
  const ledger = await createLedger(':memory:');
  const address = base64(nacl.sign.keyPair().publicKey);
  const { counts, reset } = instrumentReads(ledger);
  try {
    await mineHeight(ledger, address, 1);
    await ledger.addPeer('https://peer.example/bnkr');

    // Everything the HTTP read routes use, exercised back to back.
    reset();
    const state = await ledger.cachedNetworkState(address);
    const blocks = await ledger.getBlocks();
    const page = await ledger.listBlocks({ limit: 10, offset: 0, search: '' });
    const peers = await ledger.getPeers();
    const template = await ledger.miningTemplate(address);
    const validation = ledger.cachedValidation();
    const tipHeight = await ledger.getTipHeight();

    assert.equal(state.height, 1);
    assert.equal(state.supply, 5_000_000_000);
    assert.equal(state.balance, 5_000_000_000);
    assert.equal(blocks.length, 2);
    assert.equal(page.total, 2);
    assert.equal(peers.length, 1);
    assert.equal(template.height, 2);
    assert.equal(validation.height, 1);
    assert.equal(tipHeight, 1);

    assert.deepEqual(counts, { blockScans: 0, accountReads: 0, peerReads: 0, tipReads: 0 });
  } finally {
    ledger.close();
  }
});

test('block and transaction mutations atomically refresh every cached view', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  const recipient = base64(nacl.sign.keyPair().publicKey);
  const { counts, reset } = instrumentReads(ledger);
  try {
    await mineHeight(ledger, address, 1);

    reset();
    const before = await ledger.cachedNetworkState(address);
    assert.equal(before.height, 1);
    assert.equal(before.balance, 5_000_000_000);

    const accepted = await mineHeight(ledger, address, 2);
    assert.equal(accepted.height, 2);

    // Reads after the mutation must see the new generation, not stale rows.
    reset();
    const state = await ledger.cachedNetworkState(address);
    assert.equal(state.height, 2);
    assert.equal(state.balance, 10_000_000_000);
    assert.equal(state.minedBlocks, 2);
    assert.equal((await ledger.getBlocks()).length, 3);
    assert.equal((await ledger.listBlocks({ limit: 10 })).total, 3);
    assert.equal((await ledger.miningTemplate(address)).height, 3);
    assert.equal(ledger.cachedValidation().height, 2);
    assert.deepEqual(counts, { blockScans: 0, accountReads: 0, peerReads: 0, tipReads: 0 });

    // Admitting a transaction changes only the cached pending count.
    const payload = {
      sender: address,
      recipient,
      amount: '1',
      fee: '0.001',
      nonce: 1,
      timestamp: Date.now()
    };
    const message = JSON.stringify([
      NETWORK_ID,
      address,
      recipient,
      String(parseAmount('1')),
      String(parseAmount('0.001')),
      1,
      payload.timestamp
    ]);
    await ledger.acceptTransaction({
      ...payload,
      signature: base64(nacl.sign.detached(Buffer.from(message), miner.secretKey))
    });
    reset();
    assert.equal((await ledger.cachedNetworkState(address)).pendingCount, 1);
    assert.deepEqual(counts, { blockScans: 0, accountReads: 0, peerReads: 0, tipReads: 0 });
  } finally {
    ledger.close();
  }
});

test('chain replacement swaps the snapshot to the winning chain without a re-scan', async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const localMiner = base64(nacl.sign.keyPair().publicKey);
  const peerMiner = base64(nacl.sign.keyPair().publicKey);
  const { counts, reset } = instrumentReads(local);
  try {
    await mineHeight(local, localMiner, 1);
    for (let height = 1; height <= 3; height += 1) await mineHeight(peer, peerMiner, height, 15_000 + height);

    const peerChain = await peer.getBlocks();
    const peerTip = peerChain[peerChain.length - 1];
    const result = await local.replaceChain(peerChain);
    assert.equal(result.replaced, true);

    reset();
    const state = await local.cachedNetworkState(peerMiner);
    assert.equal(state.height, 3);
    assert.equal(state.latestBlock.hash, peerTip.hash);
    assert.equal((await local.getBlocks()).length, 4);
    assert.equal((await local.miningTemplate(peerMiner)).height, 4);
    assert.equal(local.cachedValidation().height, 3);
    assert.deepEqual(counts, { blockScans: 0, accountReads: 0, peerReads: 0, tipReads: 0 });
  } finally {
    local.close();
    peer.close();
  }
});

test('peer list mutations refresh the cached peer view', async () => {
  const ledger = await createLedger(':memory:');
  const { counts, reset } = instrumentReads(ledger);
  try {
    await ledger.addPeer('https://a.example/bnkr');
    await ledger.addPeer('https://b.example/bnkr');
    reset();
    assert.deepEqual((await ledger.getPeers()).map(peer => peer.url), [
      'https://a.example/bnkr',
      'https://b.example/bnkr'
    ]);
    assert.equal(counts.peerReads, 0);

    await ledger.updatePeer('https://a.example/bnkr');
    reset();
    const updated = (await ledger.getPeers()).find(peer => peer.url === 'https://a.example/bnkr');
    assert.equal(typeof updated.lastSeen, 'number');
    assert.equal(counts.peerReads, 0);

    await ledger.removePeer('https://a.example/bnkr');
    reset();
    assert.deepEqual((await ledger.getPeers()).map(peer => peer.url), ['https://b.example/bnkr']);
    assert.equal(counts.peerReads, 0);
  } finally {
    ledger.close();
  }
});

test('a failed post-commit mempool count read does not strand the snapshot at the old tip', async () => {
  const ledger = await createLedger(':memory:');
  const address = base64(nacl.sign.keyPair().publicKey);
  const originalExecute = ledger.client.execute.bind(ledger.client);
  let failMempoolCount = false;
  ledger.client.execute = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
    if (failMempoolCount && /SELECT COUNT\(\*\) AS count FROM mempool/.test(sql)) {
      throw new Error('simulated post-commit read failure');
    }
    return originalExecute(...args);
  };
  try {
    await mineHeight(ledger, address, 1);
    failMempoolCount = true;
    const accepted = await mineHeight(ledger, address, 2);
    assert.equal(accepted.height, 2);

    // The block was committed and the snapshot must have advanced anyway.
    const state = await ledger.cachedNetworkState(address);
    assert.equal(state.height, 2);
    assert.equal((await ledger.getBlocks()).length, 3);
    assert.equal((await ledger.miningTemplate(address)).height, 3);
    assert.equal((await ledger.validateStoredChain()).height, 2);
  } finally {
    ledger.close();
  }
});

test('an ambiguous commit resyncs the snapshot from committed storage', async () => {
  const ledger = await createLedger(':memory:');
  const address = base64(nacl.sign.keyPair().publicKey);
  const originalTransaction = ledger.client.transaction.bind(ledger.client);
  let failCommit = false;
  ledger.client.transaction = async (mode) => {
    const transaction = await originalTransaction(mode);
    const originalCommit = transaction.commit.bind(transaction);
    transaction.commit = async () => {
      await originalCommit();
      if (failCommit) {
        failCommit = false;
        throw new Error('simulated ambiguous commit');
      }
    };
    return transaction;
  };
  try {
    await mineHeight(ledger, address, 1);
    failCommit = true;
    await assert.rejects(() => mineHeight(ledger, address, 2), /ambiguous commit/);

    // The block was committed; the snapshot must have been resynced anyway.
    assert.equal((await ledger.cachedNetworkState(address)).height, 2);
    assert.equal((await ledger.miningTemplate(address)).height, 3);
    assert.equal((await ledger.validateStoredChain()).height, 2);
  } finally {
    ledger.close();
  }
});

test('deep validation still reads storage and detects out-of-band tampering', async () => {
  const ledger = await createLedger(':memory:');
  const address = base64(nacl.sign.keyPair().publicKey);
  try {
    await mineHeight(ledger, address, 1);
    const clean = await ledger.validateStoredChain();
    assert.equal(clean.valid, true);
    assert.equal(clean.accountsValid, true);

    await ledger.client.execute({
      sql: 'UPDATE accounts SET balance_units = balance_units + 1 WHERE address = ?',
      args: [address]
    });
    const tampered = await ledger.validateStoredChain();
    assert.equal(tampered.accountsValid, false);
    assert.equal(tampered.accountErrors[0].code, 'BALANCE_MISMATCH');
    assert.equal(tampered.healthy, false);
  } finally {
    ledger.close();
  }
});
