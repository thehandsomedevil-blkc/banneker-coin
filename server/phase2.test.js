import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'nacl';
import {
  createLedger,
  expectedDifficulty,
  formatUnits,
  hashBlock,
  parseAmount,
  validateChain,
  NETWORK_ID,
  PROTOCOL_UPGRADE_HEIGHT
} from './ledger.js';
import { buildCandidate, findProof, mineBatch } from '../src/miner.worker.js';

const COIN = 100_000_000;

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
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

// Builds the block through the same candidate builder the browser worker uses,
// so block-level tests cannot accidentally invent a different header.
function mine(template) {
  let nonce = 0;
  for (;;) {
    const block = buildCandidate(template, nonce);
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

async function mineNext(ledger, minerAddress) {
  const template = await ledger.miningTemplate(minerAddress);
  const block = mine(template);
  await ledger.acceptBlock(block);
  return block;
}

test('V2 activation makes the template, the worker, and the server agree', async () => {
  const ledger = await createLedger(':memory:', { v2ActivationHeight: 2, coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    const firstTemplate = await ledger.miningTemplate(address);
    assert.equal(firstTemplate.version, undefined);
    assert.equal(firstTemplate.networkId, undefined);
    await ledger.acceptBlock(mine(firstTemplate));

    const template = await ledger.miningTemplate(address);
    assert.equal(template.height, 2);
    assert.equal(template.version, 2);
    assert.equal(template.networkId, NETWORK_ID);

    const found = await findProof(template);
    assert.ok(found, 'difficulty 1 must produce a proof');
    assert.equal(found.block.version, 2);
    assert.equal(found.block.networkId, NETWORK_ID);
    assert.equal(found.block.hash, found.hash);
    assert.equal(hashBlock(found.block), found.hash);

    const accepted = await ledger.acceptBlock(found.block);
    assert.equal(accepted.height, 2);

    const stored = await ledger.getBlocks();
    assert.equal(stored[2].version, 2);
    assert.equal(stored[2].networkId, NETWORK_ID);
    assert.equal(stored[2].chainWork, '32');

    const validation = await ledger.validateStoredChain();
    assert.equal(validation.valid, true);
    assert.equal(validation.storageValid, true);

    assert.equal(validateChain(stored, { v2ActivationHeight: 2 }).valid, true);
    assert.equal(validateChain(stored, { v2ActivationHeight: 3 }).valid, false);
  } finally {
    ledger.close();
  }
});

test('a V1 template still produces the historical nine-field block', async () => {
  const ledger = await createLedger(':memory:', { coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    const template = await ledger.miningTemplate(address);
    assert.equal(Object.hasOwn(template, 'version'), false);
    assert.equal(Object.hasOwn(template, 'networkId'), false);

    const found = await findProof(template);
    assert.ok(found);
    assert.equal(Object.hasOwn(found.block, 'version'), false);
    assert.equal(found.hash, hashBlock(found.block));

    const accepted = await ledger.acceptBlock(found.block);
    assert.equal(accepted.height, 1);
    assert.equal((await ledger.validateStoredChain()).storageValid, true);
  } finally {
    ledger.close();
  }
});

test('Era 1 ignores unknown metadata while V2 rejects it before hashing', async () => {
  const v1 = await createLedger(':memory:', { coinbaseMaturity: 0 });
  const v2 = await createLedger(':memory:', { v2ActivationHeight: 1, coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    const v1Block = mine(await v1.miningTemplate(address));
    const decorated = {
      ...v1Block,
      receivedAt: 123,
      peer: 'legacy-peer',
      networkId: 'BLKC-MAINNET-V1'
    };
    await v1.acceptBlock(decorated);
    const storedV1 = await v1.getBlocks();
    assert.equal(storedV1[1].receivedAt, 123);
    assert.equal(storedV1[1].peer, 'legacy-peer');
    assert.equal(storedV1[1].hash, v1Block.hash);
    assert.equal((await v1.validateStoredChain()).storageValid, true);

    const v2Block = mine(await v2.miningTemplate(address));
    await assert.rejects(
      () => v2.acceptBlock({ ...v2Block, receivedAt: 1 }),
      error => error.code === 'EXTRA_HEADER_FIELD'
    );
    const withPrototype = JSON.parse(JSON.stringify(v2Block).replace('{', '{"__proto__":{"polluted":true},'));
    await assert.rejects(
      () => v2.acceptBlock(withPrototype),
      error => error.code === 'EXTRA_HEADER_FIELD'
    );
    await assert.rejects(
      () => v2.acceptBlock({ ...v2Block, tx_count: 0 }),
      error => error.code === 'EXTRA_HEADER_FIELD'
    );

    // Rejections do not poison the tip: the canonical block still lands.
    await v2.acceptBlock(v2Block);
    assert.equal((await v2.validateStoredChain()).valid, true);
  } finally {
    v1.close();
    v2.close();
  }
});

test('V2 identity and era are enforced before hashing', async () => {
  const ledger = await createLedger(':memory:', { v2ActivationHeight: 2, coinbaseMaturity: 0 });
  const preActivation = await createLedger(':memory:', { v2ActivationHeight: 3, coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    await mineNext(ledger, address);
    const template = await ledger.miningTemplate(address);

    const wrongNetwork = mine({ ...template, networkId: 'BLKC-MAINNET-V1' });
    await assert.rejects(
      () => ledger.acceptBlock(wrongNetwork),
      error => error.code === 'NETWORK_ID_MISMATCH'
    );

    // A lowercase case-variant cannot even be hashed by the V2 serializer, which
    // is the point: shape admission rejects it before the digest is consulted.
    const caseVariant = { ...mine(template), networkId: 'bnkr-mainnet-v1' };
    await assert.rejects(
      () => ledger.acceptBlock(caseVariant),
      error => error.code === 'NETWORK_ID_MISMATCH'
    );

    const missingNetwork = mine(template);
    delete missingNetwork.networkId;
    await assert.rejects(
      () => ledger.acceptBlock(missingNetwork),
      error => error.code === 'MISSING_FIELD'
    );

    const missingVersion = mine(template);
    delete missingVersion.version;
    await assert.rejects(
      () => ledger.acceptBlock(missingVersion),
      error => error.code === 'MISSING_FIELD'
    );

    // A received V2 block may omit its derived hash; the server fills it in.
    const withoutHash = mine(template);
    delete withoutHash.hash;
    const accepted = await ledger.acceptBlock(withoutHash);
    assert.equal(accepted.block.hash, hashBlock(withoutHash));
    assert.match(accepted.block.hash, /^[0-9a-f]{64}$/);

    await mineNext(preActivation, address);
    const preTemplate = await preActivation.miningTemplate(address);
    assert.equal(preTemplate.version, undefined);
    const counterfeitV2 = mine({ ...preTemplate, version: 2, networkId: NETWORK_ID });
    await assert.rejects(
      () => preActivation.acceptBlock(counterfeitV2),
      error => error.code === 'UNSUPPORTED_VERSION'
    );
  } finally {
    ledger.close();
    preActivation.close();
  }
});

test('minDifficulty is a floor at every height at or above the upgrade height', () => {
  const at = (height, difficulty, timestamp = 1_700_000_000_000) => ({ height, difficulty, timestamp });

  assert.equal(expectedDifficulty([at(134, 1)], 135), 1);
  // 136 % 10 !== 0: the historical bug returned the parent's difficulty (1).
  assert.equal(expectedDifficulty([at(135, 1)], 136), 4);
  assert.equal(expectedDifficulty([at(136, 1)], 137), 4);
  assert.equal(expectedDifficulty([at(138, 3)], 139), 4);

  // The floor also applies to the decrement branch of an adjustment height.
  const start = at(PROTOCOL_UPGRADE_HEIGHT - 6, 1, 1_700_000_000_000);
  const end = at(PROTOCOL_UPGRADE_HEIGHT + 3, 1, 1_700_000_020_000);
  assert.equal(expectedDifficulty([start, end], PROTOCOL_UPGRADE_HEIGHT + 4), 4);

  // Pre-upgrade heights keep the historical minimum.
  assert.equal(expectedDifficulty([], 1), 1);
  assert.throws(() => expectedDifficulty([], 137), /Insufficient chain history/);
  assert.throws(() => expectedDifficulty([at(136, 1)], 138), /Insufficient chain history/);

  // §14.11 correction 5: heights 9, 10, 11 and 140, 141, then every multiple.
  const targetMs = 15_000;
  const steady = [];
  for (let height = 0; height <= 400; height += 1) {
    steady.push(at(height, 1, 1_700_000_000_000 + height * targetMs));
  }
  assert.equal(expectedDifficulty(steady, 9), 1);
  assert.equal(expectedDifficulty(steady, 10), 1);
  assert.equal(expectedDifficulty(steady, 11), 1);
  assert.equal(expectedDifficulty(steady, 135), 1);
  assert.equal(expectedDifficulty(steady, 136), 4);
  assert.equal(expectedDifficulty(steady, 139), 4);
  assert.equal(expectedDifficulty(steady, 140), 4);
  assert.equal(expectedDifficulty(steady, 141), 4);

  // A floor is a lower bound, not a cap: a higher parent difficulty survives.
  assert.equal(expectedDifficulty([at(139, 5), at(140, 5)], 141), 5);

  // At an adjustment height the decrement clamp cannot fall below the floor.
  const slowStart = at(130, 5, 1_700_000_000_000);
  const slowEnd = at(139, 5, 1_700_000_000_000 + 3_600_000);
  assert.equal(expectedDifficulty([slowStart, slowEnd], 140), 4);

  for (let height = 150; height <= 400; height += 10) {
    assert.equal(expectedDifficulty(steady, height), 4, `height ${height}`);
    assert.equal(expectedDifficulty(steady, height + 1), 4, `height ${height + 1}`);
  }
});

test('networkState no longer special-cases the genesis height', async () => {
  const ledger = await createLedger(':memory:', { coinbaseMaturity: 0 });
  try {
    const state = await ledger.networkState();
    assert.equal(state.height, 0);
    assert.equal(state.difficulty, 1);
  } finally {
    ledger.close();
  }
});

test('coinbase maturity rejects spends before maturity and accepts them after', async () => {
  const ledger = await createLedger(':memory:', {
    coinbaseMaturity: 2,
    coinbaseMaturityHeight: 1
  });
  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    await mineNext(ledger, address); // height 1, reward at r = 1

    const early = signedTransaction(miner, recipient.publicKey, '10', 1);
    await assert.rejects(
      () => ledger.acceptTransaction(early),
      /immature coinbase/
    );

    // The same spend is rejected at block validation, not only at admission.
    const template = await ledger.miningTemplate(address);
    const invalidBlock = mine({
      ...template,
      transactions: [early],
      reward: {
        recipient: address,
        amount: formatUnits(parseAmount('50') + 100_000)
      }
    });
    await assert.rejects(() => ledger.acceptBlock(invalidBlock), /immature coinbase/);

    // Height 2 reward is also immature at height 3, so only the matured 50 from
    // height 1 is spendable there.
    await mineNext(ledger, address);
    await assert.rejects(
      () => ledger.acceptTransaction(signedTransaction(miner, recipient.publicKey, '60', 1)),
      /immature coinbase|Insufficient confirmed balance/
    );

    await ledger.acceptTransaction(early);
    const matureTemplate = await ledger.miningTemplate(address);
    assert.deepEqual(matureTemplate.transactions.map(tx => tx.nonce), [1]);
    await ledger.acceptBlock(mine(matureTemplate));

    const minerState = await ledger.networkState(address);
    const recipientState = await ledger.networkState(base64(recipient.publicKey));
    assert.equal(formatUnits(minerState.balance), '140');
    assert.equal(formatUnits(recipientState.balance), '10');
    assert.equal(minerState.height, 3);
    assert.equal((await ledger.validateStoredChain()).valid, true);
  } finally {
    ledger.close();
  }
});

test('storage cross-check detects row tampering without rewriting history', async () => {
  const ledger = await createLedger(':memory:', { coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    await mineNext(ledger, address);
    const healthy = await ledger.validateStoredChain();
    assert.equal(healthy.valid, true);
    assert.equal(healthy.storageValid, true);
    assert.deepEqual(healthy.storageErrors, []);

    await ledger.client.execute("UPDATE blocks SET chain_work = '999' WHERE height = 1");
    const tampered = await ledger.validateStoredChain();
    assert.equal(tampered.valid, true, 'json replay is still valid');
    assert.equal(tampered.storageValid, false);
    assert.ok(tampered.storageErrors.some(error => /chain_work/.test(error)));

    await ledger.client.execute({
      sql: 'UPDATE blocks SET chain_work = ? WHERE height = 1',
      args: ['16']
    });
    assert.equal((await ledger.validateStoredChain()).storageValid, true);
  } finally {
    ledger.close();
  }
});

test('a persisted V2 row with L4 metadata fails closed', async () => {
  const ledger = await createLedger(':memory:', { v2ActivationHeight: 1, coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    await mineNext(ledger, address);
    const row = await ledger.client.execute('SELECT json FROM blocks WHERE height = 1');
    const stored = JSON.parse(row.rows[0].json);
    assert.equal(stored.version, 2);

    await ledger.client.execute({
      sql: 'UPDATE blocks SET json = ? WHERE height = 1',
      args: [JSON.stringify({ ...stored, receivedAt: 1 })]
    });
    const validation = await ledger.validateStoredChain();
    assert.equal(validation.valid, false);
    assert.equal(validation.storageValid, false);
    assert.ok(validation.storageErrors.some(error => error.includes('EXTRA_HEADER_FIELD')));
  } finally {
    ledger.close();
  }
});

test('the worker returns a V2 block whose preimage survives a second batch', async () => {
  const ledger = await createLedger(':memory:', { v2ActivationHeight: 1, coinbaseMaturity: 0 });
  const miner = nacl.sign.keyPair();
  const address = base64(miner.publicKey);
  try {
    const template = await ledger.miningTemplate(address);
    const first = await mineBatch(template, 0, 1);
    assert.equal(first.block, null);
    assert.equal(first.hashes, 1);
    assert.equal(first.nextNonce, 1);

    const found = await findProof(template, { maxHashes: 20_000 });
    assert.ok(found);
    assert.equal(found.block.version, 2);
    assert.equal(found.hash, hashBlock(found.block));
    await ledger.acceptBlock(found.block);
    assert.equal((await ledger.getBlocks())[1].hash, found.hash);
    assert.equal((await ledger.validateStoredChain()).valid, true);
  } finally {
    ledger.close();
  }
});
