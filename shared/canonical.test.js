import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ERROR_CODES,
  MAX_BLOCK_PREIMAGE_BYTES,
  assertV2BlockShape,
  canonicalBlockHash,
  canonicalBlockPreimage,
  canonicalT7,
  parseCanonicalJson,
  serializeV1Header,
  serializeV2Header,
  sha256Hex,
  transactionId
} from './canonical.js';

const vectors = JSON.parse(readFileSync(new URL('./v2-vectors.json', import.meta.url), 'utf8'));
const byId = new Map(vectors.map(vector => [vector.id, vector]));

function vectorBlock(id) {
  return JSON.parse(byId.get(id).preimage);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('every positive V2 vector reproduces exact bytes, length, and digest', async () => {
  assert.equal(vectors.length, 12);
  for (const vector of vectors) {
    if (vector.id === 'V-09' || vector.id === 'V-11') continue;
    const block = JSON.parse(vector.preimage);
    const preimage = serializeV2Header(block);
    assert.equal(preimage, vector.preimage, `${vector.id}: exact bytes`);
    assert.equal(Buffer.byteLength(preimage, 'utf8'), vector.bytes, `${vector.id}: byte length`);
    assert.equal(await sha256Hex(preimage), vector.sha256, `${vector.id}: digest`);
    assert.equal(await canonicalBlockHash(block), vector.sha256, `${vector.id}: canonical helper`);
  }
});

test('V-09 proves the Era 1 serializer is frozen and distinct', async () => {
  const vector = byId.get('V-09');
  const block = JSON.parse(vector.preimage);
  const preimage = serializeV1Header(block);
  assert.equal(preimage, vector.preimage);
  assert.equal(Buffer.byteLength(preimage, 'utf8'), vector.bytes);
  assert.equal(await sha256Hex(preimage), vector.sha256);
  assert.equal(await canonicalBlockPreimage(block), vector.preimage);
  // The same semantic body under the V2 rule has a different digest.
  assert.notEqual(vector.sha256, byId.get('V-02').sha256);
});

test('V-11 is consensus-invalid, and its probe digest is not the V1 form', async () => {
  const vector = byId.get('V-11');
  const block = JSON.parse(vector.preimage);
  expectCode(() => serializeV2Header(block), ERROR_CODES.NON_NULL_MESSAGE);

  // Reconstruct the probe from the valid null-message encoding rather than
  // trusting the fixture text.
  const nullForm = serializeV2Header({ ...block, message: null });
  const probe = nullForm.replace('"message":null}', '"message":"fictional non-null message"}');
  assert.equal(probe, vector.preimage);
  assert.equal(await sha256Hex(probe), vector.sha256);
  assert.notEqual(await sha256Hex(nullForm), vector.sha256);
});

test('V2 bytes are independent of source-key order and repeat deterministically', async () => {
  const block = vectorBlock('V-02');
  const reordered = {
    message: block.message,
    reward: { amount: block.reward.amount, recipient: block.reward.recipient },
    transactions: block.transactions,
    miner: block.miner,
    nonce: block.nonce,
    difficulty: block.difficulty,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    height: block.height,
    networkId: block.networkId,
    version: block.version
  };
  const first = serializeV2Header(block);
  assert.equal(serializeV2Header(reordered), first);
  assert.equal(serializeV2Header(block), first);
  assert.equal(await canonicalBlockHash(block), byId.get('V-02').sha256);
});

test('closed V2 admission accepts derived fields and rejects application metadata', () => {
  const block = vectorBlock('V-02');
  assert.equal(
    assertV2BlockShape({ ...block, hash: 'a'.repeat(64), chainWork: '16' }, { allowDerived: true }),
    byId.get('V-02').preimage
  );
  expectCode(
    () => assertV2BlockShape({ ...block, receivedAt: 1 }, { allowDerived: true }),
    ERROR_CODES.EXTRA_HEADER_FIELD
  );
  expectCode(
    () => assertV2BlockShape({ ...block }, { requireDerived: true, allowDerived: true }),
    ERROR_CODES.MISSING_FIELD
  );
});

test('transaction identity is the canonical T7 projection', async () => {
  const block = vectorBlock('V-02');
  const transaction = block.transactions[0];
  const id = await transactionId(transaction);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, await sha256Hex(canonicalT7(transaction)));
});

// ---------------------------------------------------------------------------
// Negative vectors N-01 .. N-25
// ---------------------------------------------------------------------------

test('N-01 .. N-05: version and required identity fields are closed', () => {
  const base = vectorBlock('V-02');

  const missing = clone(base);
  delete missing.networkId;
  expectCode(() => serializeV2Header(missing), ERROR_CODES.MISSING_FIELD);

  expectCode(() => serializeV2Header({ ...base, chainId: 1 }), ERROR_CODES.EXTRA_HEADER_FIELD);
  expectCode(() => serializeV2Header({ ...base, version: '2' }), ERROR_CODES.INVALID_VERSION_TYPE);
  expectCode(() => serializeV2Header({ ...base, version: 3 }), ERROR_CODES.UNSUPPORTED_VERSION);
  for (const version of [null, true, 2.5, undefined]) {
    expectCode(
      () => serializeV2Header({ ...base, version }),
      version === undefined ? ERROR_CODES.MISSING_FIELD : ERROR_CODES.INVALID_VERSION_TYPE
    );
  }
});

test('N-06 .. N-09: networkId is ASCII, exact, and byte-equal to the compiled identity', () => {
  const base = vectorBlock('V-02');
  expectCode(() => serializeV2Header({ ...base, networkId: '' }), ERROR_CODES.INVALID_NETWORK_ID);
  expectCode(() => serializeV2Header({ ...base, networkId: 'BNKR-MAINNET-V\u0412' }), ERROR_CODES.INVALID_NETWORK_ID);
  expectCode(() => serializeV2Header({ ...base, networkId: 'BNKR-MAINNET-V1 ' }), ERROR_CODES.INVALID_NETWORK_ID);
  expectCode(() => serializeV2Header({ ...base, networkId: 'BNKR-MAINNET-V1\u200d' }), ERROR_CODES.INVALID_NETWORK_ID);
  expectCode(
    () => serializeV2Header({ ...base, networkId: 'bnkr-mainnet-v1' }, { expectedNetworkId: 'BNKR-MAINNET-V1' }),
    ERROR_CODES.NETWORK_ID_MISMATCH
  );
});

test('N-10 .. N-14: integers, difficulty, and keys are domain-checked', () => {
  const base = vectorBlock('V-02');
  expectCode(() => serializeV2Header({ ...base, height: 0 }), ERROR_CODES.INVALID_HEIGHT);
  expectCode(() => serializeV2Header({ ...base, timestamp: String(base.timestamp) }), ERROR_CODES.INVALID_INTEGER);
  expectCode(() => serializeV2Header({ ...base, nonce: -1 }), ERROR_CODES.INVALID_NONCE);
  expectCode(() => serializeV2Header({ ...base, difficulty: 7 }), ERROR_CODES.INVALID_DIFFICULTY);
  expectCode(
    () => serializeV2Header({ ...base, miner: Buffer.alloc(31).toString('base64') }),
    ERROR_CODES.INVALID_KEY
  );
});

test('N-15 .. N-19: transactions are an array of closed canonical T7 objects', () => {
  const base = vectorBlock('V-02');
  const transaction = base.transactions[0];

  expectCode(() => serializeV2Header({ ...base, transactions: null }), ERROR_CODES.INVALID_TRANSACTIONS);
  expectCode(
    () => serializeV2Header({ ...base, transactions: Array.from({ length: 10_001 }, () => transaction) }),
    ERROR_CODES.TOO_MANY_TRANSACTIONS
  );
  expectCode(
    () => serializeV2Header({ ...base, transactions: [{ ...transaction, amountUnits: '1' }] }),
    ERROR_CODES.EXTRA_TRANSACTION_FIELD
  );
  expectCode(
    () => serializeV2Header({ ...base, transactions: [{ ...transaction, amount: '1.50' }] }),
    ERROR_CODES.NON_CANONICAL_DECIMAL
  );
  expectCode(
    () => serializeV2Header({ ...base, transactions: [{ ...transaction, amount: '1e-8' }] }),
    ERROR_CODES.NON_CANONICAL_DECIMAL
  );
});

test('N-20 .. N-22: reward is closed and the message is null', () => {
  const base = vectorBlock('V-02');
  expectCode(
    () => serializeV2Header({ ...base, reward: { ...base.reward, amount: 50 } }),
    ERROR_CODES.INVALID_REWARD_TYPE
  );
  expectCode(
    () => serializeV2Header({ ...base, reward: { ...base.reward, fee: '0.001' } }),
    ERROR_CODES.EXTRA_REWARD_FIELD
  );
  expectCode(() => serializeV2Header({ ...base, message: '' }), ERROR_CODES.NON_NULL_MESSAGE);
});

test('N-23 .. N-24: duplicate keys and trailing data are parser-fatal', () => {
  const preimage = byId.get('V-02').preimage;
  const duplicate = preimage.replace('"height":1200', '"height":1200,"height":1201');
  assert.throws(
    () => parseCanonicalJson(duplicate),
    error => error.code === ERROR_CODES.DUPLICATE_KEY
  );
  assert.throws(
    () => parseCanonicalJson(`${preimage} trailing`),
    error => error.code === ERROR_CODES.TRAILING_DATA
  );
  assert.throws(
    () => parseCanonicalJson(preimage.slice(0, -1)),
    error => error.code === ERROR_CODES.JSON_INVALID
  );
});

test('N-25: a preimage above 8 MiB is rejected before hashing', () => {
  const base = vectorBlock('V-02');
  const enormous = '1' + '0'.repeat(MAX_BLOCK_PREIMAGE_BYTES);
  expectCode(
    () => serializeV2Header({
      ...base,
      transactions: [{ ...base.transactions[0], amount: enormous }]
    }),
    ERROR_CODES.PREIMAGE_TOO_LARGE
  );
});
