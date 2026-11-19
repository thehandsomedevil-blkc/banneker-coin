import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import nacl from 'nacl';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLedger,
  hashBlock,
  headerOf,
  formatUnits,
  parseAmount,
  NETWORK_ID,
  MAX_REORG_DEPTH,
  verifyTransaction
} from './ledger.js';

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function signedTransaction(pair, recipient, amount, nonce, fee = '0.001', networkId = NETWORK_ID) {
  const payload = {
    sender: base64(pair.publicKey),
    recipient: base64(recipient),
    amount,
    fee,
    nonce,
    timestamp: Date.now()
  };
  const message = JSON.stringify([
    networkId,
    payload.sender,
    payload.recipient,
    String(parseAmount(amount)),
    String(parseAmount(fee)),
    nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    signature: base64(nacl.sign.detached(Buffer.from(message), pair.secretKey))
  };
}

function signedTransactionFromUnits(pair, recipient, fields) {
  const {
    amount,
    amountUnits,
    fee,
    feeUnits,
    nonce = 1,
    timestamp = Date.now()
  } = fields;
  const payload = {
    sender: base64(pair.publicKey),
    recipient: base64(recipient),
    nonce,
    timestamp
  };
  if (amount !== undefined) payload.amount = amount;
  if (amountUnits !== undefined) payload.amountUnits = String(amountUnits);
  if (fee !== undefined) payload.fee = fee;
  if (feeUnits !== undefined) payload.feeUnits = String(feeUnits);
  const units = amountUnits !== undefined ? String(amountUnits) : String(parseAmount(amount));
  const fees = feeUnits !== undefined ? String(feeUnits) : String(parseAmount(fee));
  const message = JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    units,
    fees,
    payload.nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    signature: base64(nacl.sign.detached(Buffer.from(message), pair.secretKey))
  };
}

function legacyTransaction(pair, recipient, amount, nonce) {
  const payload = {
    sender: base64(pair.publicKey),
    recipient: base64(recipient),
    amount,
    nonce,
    timestamp: Date.now()
  };
  return {
    ...payload,
    signature: base64(nacl.sign.detached(Buffer.from(JSON.stringify(payload)), pair.secretKey))
  };
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

async function mineBranch(ledger, miner, timeStep, transfer = null, maxHeight = 10) {
  const address = base64(miner.publicKey);
  const genesisTime = (await ledger.getBlocks())[0].timestamp;
  for (let height = 1; height <= maxHeight; height += 1) {
    if (height === 2 && transfer) await ledger.acceptTransaction(transfer);
    const template = await ledger.miningTemplate(address);
    template.timestamp = genesisTime + height * timeStep;
    await ledger.acceptBlock(mine(template));
  }
}

test('genesis is fixed, has zero supply, and chain validation succeeds', async () => {
  const ledger = await createLedger(':memory:');
  try {
    const result = await ledger.validateStoredChain();
    assert.equal(result.valid, true);
    assert.equal(result.height, 0);
    assert.equal(result.supply, 0);
    const blocks = await ledger.getBlocks();
    assert.equal(blocks[0].chainWork, '0');
    const template = await ledger.miningTemplate(base64(nacl.sign.keyPair().publicKey));
    assert.equal(template.difficulty, 1);
    assert.match(blocks[0].message, /No Central Mint, No Middlemen/);
  } finally {
    ledger.close();
  }
});

test('signed pending transfers enforce signature, nonce, and available balance', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  try {
    const template = await ledger.miningTemplate(base64(miner.publicKey));
    const first = mine(template);
    await ledger.acceptBlock(first);
    const state = await ledger.networkState(base64(miner.publicKey));
    assert.equal(formatUnits(state.balance), '50');

    const transfer = signedTransaction(miner, recipient.publicKey, '30', 1);
    assert.equal(verifyTransaction(transfer).valid, true);
    await ledger.acceptTransaction(transfer);
    
    await assert.rejects(async () => await ledger.acceptTransaction(
      signedTransaction(miner, recipient.publicKey, '21', 2)
    ), /Insufficient confirmed balance/);
    
    await assert.rejects(async () => await ledger.acceptTransaction(
      signedTransaction(miner, recipient.publicKey, '1', 1)
    ), /Invalid nonce/);
    
    const mempool = await ledger.getMempool();
    assert.equal(mempool.length, 1);

    const nextTemplate = await ledger.miningTemplate(base64(miner.publicKey));
    const next = mine(nextTemplate);
    assert.equal(next.transactions.length, 1);
    await ledger.acceptBlock(next);
    
    const minerState = await ledger.networkState(base64(miner.publicKey));
    const recipientState = await ledger.networkState(base64(recipient.publicKey));
    assert.equal(formatUnits(minerState.balance), '70');
    assert.equal(formatUnits(recipientState.balance), '30');
    
    const validation = await ledger.validateStoredChain();
    assert.equal(validation.valid, true);
  } finally {
    ledger.close();
  }
});

test('new signatures bind network and atomic fee while legacy signatures remain historical-only', () => {
  const sender = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const valid = signedTransaction(sender, recipient.publicKey, '0.01', 1);
  const wrongNetwork = signedTransaction(sender, recipient.publicKey, '0.01', 1, '0.001', 'BNKR-TESTNET-V1');
  const lowFee = signedTransaction(sender, recipient.publicKey, '0.01', 1, '0.0009');
  const dust = signedTransaction(sender, recipient.publicKey, '0.00999999', 1);
  const legacy = legacyTransaction(sender, recipient.publicKey, '1', 1);

  assert.equal(verifyTransaction(valid).valid, true);
  assert.equal(verifyTransaction(wrongNetwork).valid, false);
  assert.match(verifyTransaction(lowFee).error, /at least 0\.001 BNKR/);
  assert.match(verifyTransaction(dust).error, /at least 0\.01 BNKR/);
  assert.equal(verifyTransaction(legacy).valid, false);
  assert.equal(verifyTransaction(legacy, { allowLegacy: true }).valid, true);
});

test('block hash commits to the ordered header and altered block is rejected', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  try {
    const template = await ledger.miningTemplate(base64(miner.publicKey));
    const block = mine(template);
    assert.equal(hashBlock(block), block.hash);
    assert.equal(headerOf(block).nonce, block.nonce);
    
    await assert.rejects(async () => await ledger.acceptBlock({ ...block, nonce: block.nonce + 1 }), /hash or proof of work/);
    await assert.rejects(async () => await ledger.acceptBlock({ ...block, chainWork: '17' }), /chainWork/);
    
    const futureTemplate = await ledger.miningTemplate(base64(miner.publicKey));
    futureTemplate.timestamp = Date.now() + 180_000;
    await assert.rejects(async () => await ledger.acceptBlock(mine(futureTemplate)), /far in the future/);
    
    const state = await ledger.networkState();
    assert.equal(state.height, 0);
  } finally {
    ledger.close();
  }
});

test('a same-height branch with higher accumulated work reorganizes and requeues orphaned transactions', async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  try {
    const orphanedTransfer = signedTransaction(miner, recipient.publicKey, '5', 1);
    await mineBranch(local, miner, 15_000, orphanedTransfer);
    await mineBranch(peer, miner, 1);

    const localState = await local.networkState();
    const localWork = BigInt(localState.chainWork);
    const peerChain = await peer.getBlocks();
    const peerState = await peer.networkState();
    const peerWork = BigInt(peerState.chainWork);
    
    assert.equal(localState.height, peerState.height);
    assert.ok(peerWork > localWork);
    assert.equal(peerChain[10].difficulty, 2);

    const result = await local.replaceChain(peerChain);
    assert.equal(result.replaced, true);
    assert.equal(result.commonAncestor, 0);
    assert.equal(result.requeued, 1);
    
    const finalState = await local.networkState();
    assert.equal(finalState.chainWork, peerWork.toString());
    
    const mempool = await local.getMempool();
    assert.equal(mempool.length, 1);
    assert.equal(mempool[0].signature, orphanedTransfer.signature);
    
    const validation = await local.validateStoredChain();
    assert.equal(validation.valid, true);
    
    const blocks = await local.getBlocks();
    const selfReplace = await local.replaceChain(blocks);
    assert.equal(selfReplace.replaced, false);
  } finally {
    local.close();
    peer.close();
  }
});

test('median time past rejects timestamps at the median but permits a valid lower-than-tip time', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  try {
    await mineBranch(ledger, miner, 15_000, null, 11);
    const blocks = await ledger.getBlocks();
    const history = blocks.slice(-11);
    const times = history.map(block => block.timestamp).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const template = await ledger.miningTemplate(base64(miner.publicKey));

    await assert.rejects(async () => await ledger.acceptBlock(mine({ ...template, timestamp: median })),
      /median time past/);
    const accepted = await ledger.acceptBlock(mine({ ...template, timestamp: median + 1 }));
    assert.equal(accepted.height, 12);
    assert.ok(accepted.block.timestamp < history[history.length - 1].timestamp);
  } finally {
    ledger.close();
  }
});

test(`higher-work chains deeper than ${MAX_REORG_DEPTH} blocks are rejected`, async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const peerMiner = nacl.sign.keyPair();
  try {
    await mineBranch(local, miner, 15_000, null, MAX_REORG_DEPTH + 1);
    await mineBranch(peer, peerMiner, 15_000, null, MAX_REORG_DEPTH + 2);
    
    const localState = await local.networkState();
    const peerState = await peer.networkState();
    assert.ok(BigInt(peerState.chainWork) > BigInt(localState.chainWork));
    
    const peerBlocks = await peer.getBlocks();
    await assert.rejects(async () => await local.replaceChain(peerBlocks), /exceeds the 100-block safety limit/);
    
    const finalState = await local.networkState();
    assert.equal(finalState.height, MAX_REORG_DEPTH + 1);
  } finally {
    local.close();
    peer.close();
  }
});

test('mempool rejects submissions beyond its configured capacity', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  try {
    const template = await ledger.miningTemplate(base64(miner.publicKey));
    await ledger.acceptBlock(mine(template));
    for (let nonce = 1; nonce <= 500; nonce += 1) {
      await ledger.acceptTransaction(signedTransaction(miner, recipient.publicKey, '0.01', nonce));
    }
    const mempool = await ledger.getMempool();
    assert.equal(mempool.length, 500);
    await assert.rejects(async () => await ledger.acceptTransaction(
      signedTransaction(miner, recipient.publicKey, '0.01', 501)
    ), /maximum 500 transactions/);
  } finally {
    ledger.close();
  }
});

test('legacy SQLite database migrates chainWork without losing blocks or balances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-migration-test-'));
  const databasePath = path.join(directory, 'bannekercoin.db');
  const source = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  let migrated;
  try {
    const template = await source.miningTemplate(base64(miner.publicKey));
    await source.acceptBlock(mine(template));
    const blocksResult = await source.getBlocks();
    const oldBlocks = blocksResult.map(({ chainWork, ...block }) => block);
    
    // Manual setup of legacy schema using raw libsql client for local file
    const client = createClient({ url: `file:${databasePath}` });
    await client.execute(`
      CREATE TABLE blocks (
        height INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        miner TEXT,
        tx_count INTEGER NOT NULL,
        json TEXT NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE accounts (
        address TEXT PRIMARY KEY,
        balance_units INTEGER NOT NULL DEFAULT 0,
        nonce INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.execute(`
      CREATE TABLE mempool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        json TEXT NOT NULL,
        UNIQUE(sender, nonce)
      )
    `);
    await client.execute(`CREATE TABLE peers (url TEXT PRIMARY KEY, last_seen INTEGER, last_error TEXT)`);

    for (const block of oldBlocks) {
      await client.execute({
        sql: 'INSERT INTO blocks(height, timestamp, hash, miner, tx_count, json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [block.height, block.timestamp, block.hash, block.miner, block.transactions.length, JSON.stringify(block)]
      });
    }
    
    // For account migration test, we need to know the address
    const minerAddress = base64(miner.publicKey);
    await client.execute({
      sql: 'INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, ?)',
      args: [minerAddress, 50 * 100_000_000, 0]
    });
    
    const oldPeers = [{ url: 'http://127.0.0.1:4999', lastSeen: 123, lastError: null }];
    await client.execute({
      sql: 'INSERT INTO peers(url, last_seen, last_error) VALUES (?, ?, ?)',
      args: [oldPeers[0].url, oldPeers[0].lastSeen, oldPeers[0].lastError]
    });
    
    client.close();
    
    migrated = await createLedger(databasePath);
    const validation = await migrated.validateStoredChain();
    assert.equal(validation.valid, true);
    
    const state = await migrated.networkState(minerAddress);
    assert.equal(state.balance, 50 * 100_000_000);
    assert.equal(state.chainWork, '16');
    
    const peers = await migrated.getPeers();
    assert.equal(peers[0].url, oldPeers[0].url);
    
    const chainWorkResult = await migrated.client.execute('SELECT chain_work FROM blocks WHERE height = 1');
    assert.equal(chainWorkResult.rows[0].chain_work, '16');
    
    const jsonResult = await migrated.client.execute('SELECT json FROM blocks WHERE height = 0');
    assert.equal(JSON.parse(jsonResult.rows[0].json).chainWork, '0');
  } finally {
    if (migrated) migrated.close();
    source.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Ignore EBUSY on Windows in CI/test environments
    }
  }
});

test('transaction amounts reject missing, mismatched, over-precise, and unsafe representations', () => {
  const sender = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const timestamp = Date.now();
  const decimal = signedTransaction(sender, recipient.publicKey, '10', 1);
  const atomic = signedTransactionFromUnits(sender, recipient.publicKey, {
    amountUnits: 1_000_000_000,
    feeUnits: 100_000,
    nonce: 1
  });
  const mixed = signedTransactionFromUnits(sender, recipient.publicKey, {
    amount: '10',
    amountUnits: 1_000_000_000,
    fee: '0.001',
    feeUnits: 100_000,
    nonce: 1
  });

  assert.equal(verifyTransaction(decimal).valid, true);
  assert.equal(verifyTransaction(atomic).valid, true);
  assert.equal(verifyTransaction(mixed).valid, true);

  const atomicResult = verifyTransaction(atomic);
  assert.equal(atomicResult.amountUnits, 1_000_000_000);
  assert.equal(atomicResult.feeUnits, 100_000);
  assert.equal(atomicResult.canonicalTransaction.amount, '10');
  assert.equal(atomicResult.canonicalTransaction.fee, '0.001');
  assert.equal(Object.hasOwn(atomicResult.canonicalTransaction, 'amountUnits'), false);
  assert.equal(verifyTransaction(atomicResult.canonicalTransaction).valid, true);

  const mismatchedAmount = { ...mixed, amountUnits: '999999999' };
  assert.match(verifyTransaction(mismatchedAmount).error, /do not match/i);
  const mismatchedFee = { ...mixed, feeUnits: '99999' };
  assert.match(verifyTransaction(mismatchedFee).error, /do not match/i);

  const missingAmount = {
    sender: decimal.sender,
    recipient: decimal.recipient,
    fee: '0.001',
    nonce: 1,
    timestamp,
    signature: decimal.signature
  };
  assert.match(verifyTransaction(missingAmount).error, /Amount must be/i);

  const missingFee = {
    sender: decimal.sender,
    recipient: decimal.recipient,
    amount: '10',
    nonce: 1,
    timestamp,
    signature: decimal.signature
  };
  assert.match(verifyTransaction(missingFee).error, /fee is required/i);

  const nullFee = { ...decimal, fee: null };
  assert.match(verifyTransaction(nullFee).error, /positive decimal|Amount must be/i);

  const overPrecise = { ...decimal, amount: '1.000000001' };
  assert.match(verifyTransaction(overPrecise).error, /at most 8 places/i);

  const unsafeUnits = { ...atomic, amountUnits: '9007199254740993' };
  assert.match(verifyTransaction(unsafeUnits).error, /safe integer|supported range/i);

  const unsafeNumber = { ...decimal, amount: Number.MAX_SAFE_INTEGER + 1 };
  assert.match(verifyTransaction(unsafeNumber).error, /safe integer|positive decimal|supported range/i);

  const excessiveAmount = { ...decimal, amount: '21000001' };
  assert.match(verifyTransaction(excessiveAmount).error, /supported range/i);
});

test('decimal, atomic-only, and mixed transactions debit and reward identically', async () => {
  const cases = [
    ['decimal', (miner, recipient) => signedTransaction(miner, recipient.publicKey, '10', 1)],
    ['atomic', (miner, recipient) => signedTransactionFromUnits(miner, recipient.publicKey, {
      amountUnits: 1_000_000_000,
      feeUnits: 100_000,
      nonce: 1
    })],
    ['mixed', (miner, recipient) => signedTransactionFromUnits(miner, recipient.publicKey, {
      amount: '10',
      amountUnits: 1_000_000_000,
      fee: '0.001',
      feeUnits: 100_000,
      nonce: 1
    })]
  ];

  for (const [name, make] of cases) {
    const ledger = await createLedger(':memory:');
    const miner = nacl.sign.keyPair();
    const recipient = nacl.sign.keyPair();
    const minerAddress = base64(miner.publicKey);
    try {
      await ledger.acceptBlock(mine(await ledger.miningTemplate(minerAddress)));
      const accepted = await ledger.acceptTransaction(make(miner, recipient));
      assert.equal(accepted.amount, '10', `${name}: canonical amount`);
      assert.equal(accepted.fee, '0.001', `${name}: canonical fee`);
      assert.equal(verifyTransaction(accepted).valid, true, `${name}: canonical signature`);

      const template = await ledger.miningTemplate(minerAddress);
      assert.equal(template.transactions.length, 1, `${name}: template transaction`);
      assert.equal(template.reward.amount, formatUnits(parseAmount('50') + 100_000),
        `${name}: fee is included in the reward`);
      await ledger.acceptBlock(mine(template));

      const minerState = await ledger.networkState(minerAddress);
      const recipientState = await ledger.networkState(base64(recipient.publicKey));
      assert.equal(formatUnits(minerState.balance), '90', `${name}: miner balance`);
      assert.equal(formatUnits(recipientState.balance), '10', `${name}: recipient balance`);
      assert.equal((await ledger.validateStoredChain()).valid, true, `${name}: chain valid`);
    } finally {
      ledger.close();
    }
  }
});

test('block persistence uses validated atomic units for atomic-only transactions', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const minerAddress = base64(miner.publicKey);
  try {
    await ledger.acceptBlock(mine(await ledger.miningTemplate(minerAddress)));
    const template = await ledger.miningTemplate(minerAddress);
    const tx = signedTransactionFromUnits(miner, recipient.publicKey, {
      amountUnits: 2_500_000_000,
      feeUnits: 200_000,
      nonce: 1
    });
    template.transactions = [tx];
    template.reward = {
      recipient: minerAddress,
      amount: formatUnits(parseAmount('50') + 200_000)
    };
    await ledger.acceptBlock(mine(template));

    const blocks = await ledger.getBlocks();
    assert.equal(blocks[2].transactions[0].amountUnits, '2500000000');
    assert.equal(Object.hasOwn(blocks[2].transactions[0], 'amount'), false);
    assert.equal(formatUnits((await ledger.networkState(minerAddress)).balance), '75');
    assert.equal(formatUnits((await ledger.networkState(base64(recipient.publicKey))).balance), '25');
    assert.equal((await ledger.validateStoredChain()).valid, true);
  } finally {
    ledger.close();
  }
});

test('a failed chain replacement rolls back blocks, accounts, and mempool', async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const localMiner = nacl.sign.keyPair();
  const peerMiner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  try {
    await mineBranch(local, localMiner, 15_000, null, 4);
    await mineBranch(peer, peerMiner, 1, null, 7);
    await local.acceptTransaction(signedTransaction(localMiner, recipient.publicKey, '2', 1));

    const beforeBlocks = await local.getBlocks();
    const beforeState = await local.networkState(base64(localMiner.publicKey));
    const beforeMempool = await local.getMempool();
    assert.equal(beforeMempool.length, 1);

    await local.client.execute(`
      CREATE TRIGGER reject_peer_block
      BEFORE INSERT ON blocks
      WHEN NEW.height = 5
      BEGIN SELECT RAISE(ABORT, 'injected block failure'); END
    `);

    await assert.rejects(local.replaceChain(await peer.getBlocks()), /injected block failure/);

    assert.deepEqual(await local.getBlocks(), beforeBlocks);
    assert.equal((await local.networkState(base64(localMiner.publicKey))).balance, beforeState.balance);
    assert.deepEqual(await local.getMempool(), beforeMempool);
    assert.equal((await local.validateStoredChain()).valid, true);
    const total = await local.client.execute('SELECT COALESCE(SUM(balance_units), 0) AS total FROM accounts');
    assert.equal(Number(total.rows[0].total), beforeState.supply);
  } finally {
    local.close();
    peer.close();
  }
});

test('a failure during account reconstruction rolls the replacement back', async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const localMiner = nacl.sign.keyPair();
  const peerMiner = nacl.sign.keyPair();
  const peerAddress = base64(peerMiner.publicKey);
  try {
    await mineBranch(local, localMiner, 15_000, null, 3);
    await mineBranch(peer, peerMiner, 1, null, 6);

    const beforeBlocks = await local.getBlocks();
    const beforeState = await local.networkState(base64(localMiner.publicKey));

    await local.client.execute(`
      CREATE TRIGGER reject_peer_account
      BEFORE INSERT ON accounts
      WHEN NEW.address = '${peerAddress}'
      BEGIN SELECT RAISE(ABORT, 'injected account failure'); END
    `);

    await assert.rejects(local.replaceChain(await peer.getBlocks()), /injected account failure/);

    assert.deepEqual(await local.getBlocks(), beforeBlocks);
    assert.equal((await local.networkState(base64(localMiner.publicKey))).balance, beforeState.balance);
    const peerAccount = await local.client.execute({
      sql: 'SELECT COUNT(*) AS count FROM accounts WHERE address = ?',
      args: [peerAddress]
    });
    assert.equal(Number(peerAccount.rows[0].count), 0);
    assert.equal((await local.validateStoredChain()).valid, true);
  } finally {
    local.close();
    peer.close();
  }
});

test('an interrupted replacement survives a restart with the prior chain intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-atomic-replace-'));
  const databasePath = path.join(directory, 'bannekercoin.db');
  const localMiner = nacl.sign.keyPair();
  const peerMiner = nacl.sign.keyPair();
  const peer = await createLedger(':memory:');
  let local;
  let reopened;
  try {
    await mineBranch(peer, peerMiner, 1, null, 7);
    const peerBlocks = await peer.getBlocks();

    local = await createLedger(databasePath);
    await mineBranch(local, localMiner, 15_000, null, 4);
    const minerAddress = base64(localMiner.publicKey);
    const expectedBalance = (await local.networkState(minerAddress)).balance;
    local.close();
    local = null;

    reopened = await createLedger(databasePath);
    await reopened.client.execute(`
      CREATE TRIGGER reject_interrupted_block
      BEFORE INSERT ON blocks
      WHEN NEW.height = 4
      BEGIN SELECT RAISE(ABORT, 'injected interrupted failure'); END
    `);
    await assert.rejects(reopened.replaceChain(peerBlocks), /injected interrupted failure/);
    reopened.close();
    reopened = null;

    reopened = await createLedger(databasePath);
    const recovered = await reopened.getBlocks();
    assert.equal(recovered.length, 5);
    assert.equal((await reopened.networkState(minerAddress)).balance, expectedBalance);
    assert.equal((await reopened.validateStoredChain()).valid, true);

    await reopened.client.execute('DROP TRIGGER reject_interrupted_block');
    const replaced = await reopened.replaceChain(peerBlocks);
    assert.equal(replaced.replaced, true);
    assert.equal((await reopened.getBlocks()).length, 8);
    assert.equal((await reopened.validateStoredChain()).valid, true);
    const totals = await reopened.client.execute('SELECT COALESCE(SUM(balance_units), 0) AS total FROM accounts');
    assert.equal(Number(totals.rows[0].total), (await reopened.validateStoredChain()).supply);
  } finally {
    if (local) local.close();
    if (reopened) reopened.close();
    peer.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Ignore EBUSY on Windows in CI/test environments
    }
  }
});

test('concurrent chain replacements serialize and leave a consistent chain', async () => {
  const local = await createLedger(':memory:');
  const peerA = await createLedger(':memory:');
  const peerB = await createLedger(':memory:');
  try {
    await mineBranch(local, nacl.sign.keyPair(), 15_000, null, 3);
    await mineBranch(peerA, nacl.sign.keyPair(), 1_000, null, 6);
    await mineBranch(peerB, nacl.sign.keyPair(), 500, null, 8);
    const chainA = await peerA.getBlocks();
    const chainB = await peerB.getBlocks();

    const results = await Promise.allSettled([
      local.replaceChain(chainA),
      local.replaceChain(chainB)
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);

    const validation = await local.validateStoredChain();
    assert.equal(validation.valid, true);
    assert.equal(validation.height, 8);
    const totals = await local.client.execute('SELECT COALESCE(SUM(balance_units), 0) AS total FROM accounts');
    assert.equal(Number(totals.rows[0].total), validation.supply);
    const negative = await local.client.execute('SELECT COUNT(*) AS count FROM accounts WHERE balance_units < 0');
    assert.equal(Number(negative.rows[0].count), 0);
  } finally {
    local.close();
    peerA.close();
    peerB.close();
  }
});

test('concurrent block acceptance and chain replacement cannot corrupt state', async () => {
  const local = await createLedger(':memory:');
  const peer = await createLedger(':memory:');
  const localMiner = nacl.sign.keyPair();
  const peerMiner = nacl.sign.keyPair();
  try {
    await mineBranch(local, localMiner, 15_000, null, 3);
    await mineBranch(peer, peerMiner, 1, null, 7);
    const nextBlock = mine(await local.miningTemplate(base64(localMiner.publicKey)));
    const peerBlocks = await peer.getBlocks();

    const results = await Promise.allSettled([
      local.acceptBlock(nextBlock),
      local.replaceChain(peerBlocks)
    ]);
    assert.ok(results.some(result => result.status === 'fulfilled'));

    const validation = await local.validateStoredChain();
    assert.equal(validation.valid, true);
    assert.equal(validation.height, 7);
    const totals = await local.client.execute('SELECT COALESCE(SUM(balance_units), 0) AS total FROM accounts');
    assert.equal(Number(totals.rows[0].total), validation.supply);
    const negative = await local.client.execute('SELECT COUNT(*) AS count FROM accounts WHERE balance_units < 0');
    assert.equal(Number(negative.rows[0].count), 0);
  } finally {
    local.close();
    peer.close();
  }
});

test('startup repairs account state from validated chain history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-account-repair-'));
  const databasePath = path.join(directory, 'bannekercoin.db');
  const miner = nacl.sign.keyPair();
  const minerAddress = base64(miner.publicKey);
  let ledger;
  let reopened;
  try {
    ledger = await createLedger(databasePath);
    await mineBranch(ledger, miner, 15_000, null, 2);
    const expected = await ledger.networkState(minerAddress);
    await ledger.client.execute({
      sql: 'UPDATE accounts SET balance_units = ?, nonce = ? WHERE address = ?',
      args: [123, 99, minerAddress]
    });
    const corruptValidation = await ledger.validateStoredChain();
    assert.equal(corruptValidation.valid, true);
    assert.equal(corruptValidation.accountsValid, false);
    ledger.close();
    ledger = null;

    reopened = await createLedger(databasePath);
    const repaired = await reopened.networkState(minerAddress);
    assert.equal(repaired.balance, expected.balance);
    assert.equal(repaired.nonce, expected.nonce);
    assert.equal((await reopened.validateStoredChain()).valid, true);
  } finally {
    if (ledger) ledger.close();
    if (reopened) reopened.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Ignore EBUSY on Windows in CI/test environments
    }
  }
});

test('startup rolls back an invalid tip block without wiping the valid chain', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-tip-repair-'));
  const databasePath = path.join(directory, 'bannekercoin.db');
  const miner = nacl.sign.keyPair();
  const minerAddress = base64(miner.publicKey);
  let ledger;
  let reopened;
  try {
    ledger = await createLedger(databasePath);
    await mineBranch(ledger, miner, 15_000, null, 2);
    ledger.close();
    ledger = null;

    const raw = createClient({ url: `file:${databasePath}` });
    try {
      const tipRow = await raw.execute('SELECT json FROM blocks WHERE height = 2');
      const tip = JSON.parse(tipRow.rows[0].json);
      const bogus = {
        ...tip,
        height: 3,
        prevHash: tip.hash,
        timestamp: tip.timestamp + 1,
        nonce: 0,
        hash: 'f'.repeat(64),
        chainWork: '48'
      };
      await raw.execute({
        sql: 'INSERT INTO blocks(height, timestamp, hash, miner, tx_count, json, chain_work) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [3, bogus.timestamp, bogus.hash, bogus.miner, 0, JSON.stringify(bogus), '48']
      });
    } finally {
      raw.close();
    }

    reopened = await createLedger(databasePath);
    const blocks = await reopened.getBlocks();
    assert.equal(blocks.length, 3);
    assert.equal((await reopened.validateStoredChain()).valid, true);
    assert.equal((await reopened.networkState(minerAddress)).balance, parseAmount('100'));
  } finally {
    if (ledger) ledger.close();
    if (reopened) reopened.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Ignore EBUSY on Windows in CI/test environments
    }
  }
});

test('mining templates exclude invalid, stale, and overdrawn mempool entries', async () => {
  const ledger = await createLedger(':memory:');
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const minerAddress = base64(miner.publicKey);
  try {
    await ledger.acceptBlock(mine(await ledger.miningTemplate(minerAddress)));
    const valid = signedTransaction(miner, recipient.publicKey, '1', 1);
    await ledger.acceptTransaction(valid);

    const forged = {
      ...signedTransaction(miner, recipient.publicKey, '1', 2),
      signature: base64(Buffer.alloc(64, 7))
    };
    await ledger.client.execute({
      sql: 'INSERT INTO mempool(sender, nonce, timestamp, json) VALUES (?, ?, ?, ?)',
      args: [forged.sender, forged.nonce, forged.timestamp, JSON.stringify(forged)]
    });

    const overdrawn = signedTransaction(miner, recipient.publicKey, '1000', 3);
    await ledger.client.execute({
      sql: 'INSERT INTO mempool(sender, nonce, timestamp, json) VALUES (?, ?, ?, ?)',
      args: [overdrawn.sender, overdrawn.nonce, overdrawn.timestamp, JSON.stringify(overdrawn)]
    });

    const template = await ledger.miningTemplate(minerAddress);
    assert.deepEqual(template.transactions.map(tx => tx.nonce), [1]);
    assert.equal(template.reward.amount, formatUnits(parseAmount('50') + 100_000));

    await ledger.acceptBlock(mine(template));
    assert.equal(formatUnits((await ledger.networkState(minerAddress)).balance), '99');
    assert.equal(formatUnits((await ledger.networkState(base64(recipient.publicKey))).balance), '1');
    assert.equal((await ledger.validateStoredChain()).valid, true);
  } finally {
    ledger.close();
  }
});
