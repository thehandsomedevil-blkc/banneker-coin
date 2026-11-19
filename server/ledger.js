import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import nacl from 'nacl';
import {
  BNKR_NETWORK_ID,
  COIN_UNITS,
  MAX_DIFFICULTY as SHARED_MAX_DIFFICULTY,
  MIN_FEE_UNITS as SHARED_MIN_FEE_UNITS,
  MIN_TRANSACTION_UNITS as SHARED_MIN_TRANSACTION_UNITS,
  assertEra1BlockShape,
  assertV2BlockShape,
  canonicalBlockPreimage,
  canonicalT7,
  projectV1Header,
  projectV2Header
} from '../shared/canonical.js';
import {
  CHECKPOINT_BURIAL_ENV,
  CHECKPOINT_ENV,
  CheckpointError,
  DEFAULT_CHECKPOINT_BURIAL,
  computeCheckpointSetDigest,
  computeManifestDigest,
  emptyCheckpointManifest,
  evaluateCheckpointSet,
  normalizeCheckpointManifest,
  validateCheckpointSet,
  verifyCheckpoint,
  assertCheckpointsForCandidate
} from './checkpoints.js';
import { MAX_PAGE_BLOCKS } from './paging.js';
import {
  COINBASE_MATURITY,
  HALVING_INTERVAL,
  MAINNET_CHECKPOINT_ANCHORS,
  TARGET_BLOCK_TIME_SECONDS,
  V2_ACTIVATION_HEIGHT,
  appliesToActivation,
  targetBlockSecondsForHeight
} from '../shared/protocol.js';

export const COIN = COIN_UNITS;
export const MAX_SUPPLY = 21_000_000 * COIN;
export const INITIAL_REWARD = 50 * COIN;
// Owner-selected parameters (Q-1, Q-15, maturity). Re-exported here because
// server/index.js and the tests import protocol constants from the ledger.
export {
  COINBASE_MATURITY,
  HALVING_INTERVAL,
  TARGET_BLOCK_TIME_SECONDS,
  V2_ACTIVATION_HEIGHT
};
// Backwards-compatible names. TARGET_BLOCK_SECONDS is the current (V2) cadence;
// Era 1 history is recomputed with ERA1_TARGET_BLOCK_SECONDS below.
export const TARGET_BLOCK_SECONDS = TARGET_BLOCK_TIME_SECONDS;
export const ADJUSTMENT_INTERVAL = 10;
export const MAX_DIFFICULTY = SHARED_MAX_DIFFICULTY;
export const MAX_MEMPOOL_TRANSACTIONS = 500;
export const MIN_TRANSACTION_UNITS = SHARED_MIN_TRANSACTION_UNITS;
export const MIN_FEE_UNITS = SHARED_MIN_FEE_UNITS;
export const NETWORK_ID = BNKR_NETWORK_ID;
export const PROTOCOL_UPGRADE_HEIGHT = 136;
export const MAX_REORG_DEPTH = 100;
export const MEDIAN_TIME_WINDOW = 11;
export const PEER_BAN_SCORE = 100;
export const PEER_BAN_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COINBASE_MATURITY = COINBASE_MATURITY;
export const V2_ACTIVATION_ENV = 'BANNEKER_V2_ACTIVATION_HEIGHT';
export const COINBASE_MATURITY_ENV = 'BANNEKER_COINBASE_MATURITY';
export const COINBASE_MATURITY_HEIGHT_ENV = 'BANNEKER_COINBASE_MATURITY_HEIGHT';
export const CHECKPOINT_MANIFEST_DIGEST_ENV = 'BANNEKER_CHECKPOINT_MANIFEST_DIGEST';
export const PROTOCOL_VERSION = 2;
const ZERO_HASH = '0'.repeat(64);
const GENESIS_TIMESTAMP = Date.UTC(2026, 10, 1, 0, 0, 0);
export const GENESIS_MESSAGE = 'The Handsome Devil — Nov 2026 — No Central Mint, No Middlemen.';

function parseOptionalHeight(value, label, { allowZero = false } = {}) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(text)) {
    throw new Error(`${label} must be a non-negative decimal integer height.`);
  }
  const height = Number(text);
  if (!Number.isSafeInteger(height)) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return height;
}

/**
 * Q-1 is resolved: V2 activates at height 2026 by default. Setting
 * BANNEKER_V2_ACTIVATION_HEIGHT is a consensus switch: height H is the first
 * V2 block, and H - 1 remains Era 1. A value of 0 is rejected because genesis
 * is always a V1 block. An explicit empty value falls back to the compiled
 * default rather than silently unscheduling consensus.
 */
export function parseV2ActivationHeight(value) {
  return parseOptionalHeight(value, V2_ACTIVATION_ENV);
}

export function parseCoinbaseMaturity(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_COINBASE_MATURITY;
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${COINBASE_MATURITY_ENV} must be a non-negative decimal integer.`);
  }
  const maturity = Number(text);
  if (!Number.isSafeInteger(maturity)) {
    throw new Error(`${COINBASE_MATURITY_ENV} is outside the safe integer range.`);
  }
  return maturity;
}

export function parseCoinbaseMaturityHeight(value) {
  return parseOptionalHeight(value, COINBASE_MATURITY_HEIGHT_ENV, { allowZero: true });
}

/**
 * K-6 burial is a configuration-time rule. It needs a positive safe integer;
 * zero is allowed only for local test chains that are shorter than the default
 * burial depth.
 */
export function parseCheckpointBurial(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_CHECKPOINT_BURIAL;
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${CHECKPOINT_BURIAL_ENV} must be a non-negative decimal integer.`);
  }
  const burial = Number(text);
  if (!Number.isSafeInteger(burial)) {
    throw new Error(`${CHECKPOINT_BURIAL_ENV} is outside the safe integer range.`);
  }
  return burial;
}

function normalizeConsensus(options = {}) {
  const activation = Object.hasOwn(options, 'v2ActivationHeight')
    ? options.v2ActivationHeight
    : V2_ACTIVATION_HEIGHT;
  const maturity = Object.hasOwn(options, 'coinbaseMaturity')
    ? options.coinbaseMaturity
    : COINBASE_MATURITY;
  const maturityHeight = Object.hasOwn(options, 'coinbaseMaturityHeight')
    ? options.coinbaseMaturityHeight
    : activation;
  return {
    v2ActivationHeight: activation,
    coinbaseMaturity: maturity,
    // Maturity starts with V2 by default. Era 1 history is never re-judged by a
    // rule that did not exist when it was mined.
    coinbaseMaturityHeight: maturityHeight,
    requireDerived: options.requireDerived === true
  };
}

function isV2Height(height, consensus) {
  return consensus.v2ActivationHeight !== null &&
    consensus.v2ActivationHeight !== undefined &&
    height >= consensus.v2ActivationHeight;
}

function coinbaseMaturityStart(consensus) {
  return consensus.coinbaseMaturityHeight === undefined
    ? consensus.v2ActivationHeight
    : consensus.coinbaseMaturityHeight;
}

function isCoinbaseMaturityActive(height, consensus) {
  const maturity = consensus.coinbaseMaturity;
  const start = coinbaseMaturityStart(consensus);
  return Number.isSafeInteger(maturity) && maturity > 0 &&
    start !== null && start !== undefined && height >= start;
}

function coinbaseTotalFor(entries) {
  if (!entries || !entries.length) return 0;
  let total = 0;
  for (const entry of entries) total += entry.units;
  return total;
}

function immatureCoinbaseUnitsFromState(coinbase, address, height, maturity) {
  const entries = coinbase?.get(address);
  if (!entries || !entries.length) return 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.height + maturity > height) total += entry.units;
  }
  return total;
}

function rewardUnitsOf(block) {
  if (!block || !block.reward || typeof block.reward.amount !== 'string') return 0;
  if (block.reward.amount === '0') return 0;
  try {
    return parseAmount(block.reward.amount);
  } catch {
    return 0;
  }
}

/**
 * Rebuilds the immature coinbase set for a spend at `height` from persisted
 * block history. A reward at height r is immature at h iff r + maturity > h.
 * Only rewards produced at or after the maturity start height are tracked, so
 * coins mined under the old rules are never locked retroactively.
 */
function coinbaseEntriesForHeight(blocks, height, consensus) {
  const map = new Map();
  if (!isCoinbaseMaturityActive(height, consensus)) return map;
  const maturity = consensus.coinbaseMaturity;
  const start = coinbaseMaturityStart(consensus);
  for (const block of blocks) {
    if (!block || !Number.isSafeInteger(block.height)) continue;
    if (block.height >= height) break;
    if (block.height < start) continue;
    if (block.height + maturity <= height) continue;
    const units = rewardUnitsOf(block);
    if (!units) continue;
    const entries = map.get(block.miner) || [];
    entries.push({ height: block.height, units });
    map.set(block.miner, entries);
  }
  return map;
}

/**
 * Drops entries that are already mature at `height`. Entries are appended in
 * increasing height, so the mature prefix is contiguous and can be sliced off.
 */
function pruneMatureCoinbase(coinbase, height, maturity) {
  for (const [address, entries] of coinbase) {
    let cut = 0;
    while (cut < entries.length && entries[cut].height + maturity <= height) cut += 1;
    if (cut === 0) continue;
    if (cut === entries.length) coinbase.delete(address);
    else coinbase.set(address, entries.slice(cut));
  }
}

function minDifficultyForHeight(height) {
  return height >= PROTOCOL_UPGRADE_HEIGHT ? 4 : 1;
}

class LedgerValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function headerOf(block) {
  // Era selection is shared with the browser worker. Era 1 output is unchanged
  // byte-for-byte; V2 adds exactly version and networkId at the front.
  if (block?.version === 2) return projectV2Header(block);
  return projectV1Header(block);
}

export function hashBlock(block) {
  return sha256(canonicalBlockPreimage(block));
}

export function formatUnits(units) {
  if (!Number.isSafeInteger(units) || units < 0 || units > Number.MAX_SAFE_INTEGER) {
    throw new Error('Atomic amount is outside the safe integer range.');
  }
  const whole = Math.floor(units / COIN);
  const fraction = String(units % COIN).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function parseAmount(amount) {
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SUPPLY) {
      throw new Error('Amount must be greater than zero and within the supported range.');
    }
    return amount;
  }
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(amount)) {
    throw new Error('Amount must be a positive decimal with at most 8 places.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const unitsBigInt = BigInt(whole) * BigInt(COIN) + BigInt(fraction.padEnd(8, '0'));
  if (unitsBigInt <= 0n || unitsBigInt > BigInt(MAX_SUPPLY)) {
    throw new Error('Amount must be greater than zero and within the supported range.');
  }
  return Number(unitsBigInt);
}

function parseUnitString(value, label) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${label} units must be a non-negative integer string.`);
  }
  const unitsBigInt = BigInt(text);
  if (unitsBigInt > BigInt(MAX_SUPPLY)) {
    throw new Error(`${label} must be within the supported range.`);
  }
  const units = Number(unitsBigInt);
  if (!Number.isSafeInteger(units)) {
    throw new Error(`${label} units are outside the safe integer range.`);
  }
  return units;
}

function parseAmountInput(value, unitsValue, label = 'Amount') {
  if (unitsValue !== undefined && unitsValue !== null) {
    const units = parseUnitString(unitsValue, label);
    if (value !== undefined && value !== null) {
      const decimalUnits = parseAmount(String(value));
      if (decimalUnits !== units) {
        throw new Error(`${label} and ${label.toLowerCase()}Units do not match.`);
      }
    }
    return units;
  }
  return parseAmount(value);
}

// One accounting rule for admission, block validation, persistence, and mining
// templates. Decimal fields are lossless strings with at most 8 places; atomic
// fields are integer unit strings. When both are supplied they must agree.
function resolveTransactionAmounts(transaction, { allowLegacy = false } = {}) {
  const amountUnits = parseAmountInput(transaction.amount, transaction.amountUnits, 'Amount');
  if (amountUnits < MIN_TRANSACTION_UNITS) {
    throw new Error('Transaction amount must be at least 0.01 BNKR.');
  }
  const legacy = transaction.fee === undefined && transaction.feeUnits === undefined;
  if (legacy) {
    if (!allowLegacy) throw new Error('Transaction fee is required.');
    if (transaction.amount === undefined || transaction.amount === null) {
      throw new Error('Legacy transaction must include a decimal amount.');
    }
    return { amountUnits, feeUnits: 0, legacy: true };
  }
  const feeUnits = parseAmountInput(transaction.fee, transaction.feeUnits, 'Fee');
  if (feeUnits < MIN_FEE_UNITS) {
    throw new Error('Miner fee must be at least 0.001 BNKR.');
  }
  return { amountUnits, feeUnits, legacy: false };
}

function canonicalTransaction(transaction, amountUnits, feeUnits, legacy) {
  if (legacy) return transaction;
  return {
    sender: transaction.sender,
    recipient: transaction.recipient,
    amount: formatUnits(amountUnits),
    fee: formatUnits(feeUnits),
    nonce: transaction.nonce,
    timestamp: transaction.timestamp,
    signature: transaction.signature
  };
}

function workForDifficulty(difficulty) {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > MAX_DIFFICULTY) {
    throw new Error('Proof-of-work difficulty is outside the supported range.');
  }
  return 16n ** BigInt(difficulty);
}

function isPublicKey(address) {
  if (typeof address !== 'string') return false;
  try {
    const bytes = Buffer.from(address, 'base64');
    return bytes.length === nacl.sign.publicKeyLength && bytes.toString('base64') === address;
  } catch {
    return false;
  }
}

function normalizeTransaction(tx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    throw new Error('Transaction must be an object.');
  }
  const transaction = {
    sender: tx.sender,
    recipient: tx.recipient,
    amount: tx.amount,
    nonce: tx.nonce,
    timestamp: tx.timestamp,
    signature: tx.signature
  };
  if (Object.hasOwn(tx, 'amountUnits')) transaction.amountUnits = tx.amountUnits;
  if (Object.hasOwn(tx, 'fee')) transaction.fee = tx.fee;
  if (Object.hasOwn(tx, 'feeUnits')) transaction.feeUnits = tx.feeUnits;
  return transaction;
}

function legacyTransactionMessage(tx) {
  return JSON.stringify({
    sender: tx.sender,
    recipient: tx.recipient,
    amount: tx.amount,
    nonce: tx.nonce,
    timestamp: tx.timestamp
  });
}

function transactionMessage(tx, amountUnits, feeUnits) {
  return JSON.stringify([
    NETWORK_ID,
    tx.sender,
    tx.recipient,
    String(amountUnits),
    String(feeUnits),
    tx.nonce,
    tx.timestamp
  ]);
}

export function verifyTransaction(tx, { allowLegacy = false } = {}) {
  let transaction;
  try {
    transaction = normalizeTransaction(tx);
    if (!isPublicKey(transaction.sender) || !isPublicKey(transaction.recipient)) {
      return { valid: false, error: 'Sender and recipient must be valid Ed25519 public keys.' };
    }
    if (transaction.sender === transaction.recipient) {
      return { valid: false, error: 'Sender and recipient must be different.' };
    }
    const { amountUnits, feeUnits, legacy } = resolveTransactionAmounts(transaction, { allowLegacy });
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 1) {
      return { valid: false, error: 'Transaction nonce must be a positive integer.' };
    }
    if (!Number.isSafeInteger(transaction.timestamp) || transaction.timestamp <= 0 ||
      transaction.timestamp > Date.now() + 120_000) {
      return { valid: false, error: 'Transaction timestamp is invalid or too far in the future.' };
    }
    const signature = Buffer.from(transaction.signature, 'base64');
    if (signature.length !== nacl.sign.signatureLength ||
      signature.toString('base64') !== transaction.signature) {
      return { valid: false, error: 'Transaction signature is malformed.' };
    }
    const key = Buffer.from(transaction.sender, 'base64');
    const message = legacy
      ? legacyTransactionMessage(transaction)
      : transactionMessage(transaction, amountUnits, feeUnits);
    const valid = nacl.sign.detached.verify(Buffer.from(message), signature, key);
    return valid
      ? {
          valid: true,
          transaction,
          canonicalTransaction: canonicalTransaction(transaction, amountUnits, feeUnits, legacy),
          amountUnits,
          feeUnits,
          legacy
        }
      : { valid: false, error: 'Transaction signature verification failed.' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

export function rewardForHeight(height, supply) {
  const halvings = Math.floor((height - 1) / HALVING_INTERVAL);
  const reward = halvings >= 53 ? 0 : Math.floor(INITIAL_REWARD / (2 ** halvings));
  return Math.min(reward, Math.max(0, MAX_SUPPLY - supply));
}

export function expectedDifficulty(blocks, height, { v2ActivationHeight = V2_ACTIVATION_HEIGHT } = {}) {
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new Error('Difficulty height must be a positive safe integer.');
  }
  if (!Array.isArray(blocks)) {
    throw new Error('Difficulty history must be an array of blocks.');
  }
  // The floor is a property of the height, not of the adjustment branch. This
  // is the D-2 fix: a non-adjustment block at or above the upgrade height may
  // never inherit a sub-floor difficulty from its parent.
  const minDifficulty = minDifficultyForHeight(height);
  if (height < ADJUSTMENT_INTERVAL) return minDifficulty;

  // Make the window contract explicit instead of relying on the caller to pass
  // a slice whose last element happens to be height - 1 (D-3 fix).
  const end = blocks.find(block => block.height === height - 1);
  if (!end || !Number.isSafeInteger(end.difficulty) || end.difficulty < 1) {
    throw new Error('Insufficient chain history for difficulty adjustment.');
  }
  const floor = value => Math.min(MAX_DIFFICULTY, Math.max(minDifficulty, value));
  if (height % ADJUSTMENT_INTERVAL !== 0) return floor(end.difficulty);

  const start = blocks.find(block => block.height === height - ADJUSTMENT_INTERVAL);
  if (!start) throw new Error('Insufficient chain history for difficulty adjustment.');
  const elapsed = Math.max(1, (end.timestamp - start.timestamp) / 1000);
  const expected = (ADJUSTMENT_INTERVAL - 1) *
    targetBlockSecondsForHeight(height, v2ActivationHeight);
  const previous = end.difficulty;
  if (elapsed < expected / 2) return floor(previous + 1);
  if (elapsed > expected * 2) return floor(previous - 1);
  return floor(previous);
}

function genesisBlock() {
  const block = {
    height: 0,
    timestamp: GENESIS_TIMESTAMP,
    prevHash: ZERO_HASH,
    difficulty: 0,
    nonce: 0,
    miner: null,
    transactions: [],
    reward: null,
    message: GENESIS_MESSAGE
  };
  return { ...block, hash: hashBlock(block), chainWork: '0' };
}

// The network genesis is a permanent identity value. Checkpoints and paged
// envelopes are compared against this constant, not against a database row.
export const GENESIS_HASH = genesisBlock().hash;

/**
 * Compiled Mainnet Checkpoint 1 (Q-2). The height and hash are compiled
 * constants; only the tuple's network and genesis binding is taken from the
 * permanent identity above. `appliesToActivation` keeps a mainnet Era 1 anchor
 * out of a testnet schedule whose activation would make height 731 a V2 block.
 */
export const COMPILED_MAINNET_CHECKPOINTS = Object.freeze(
  MAINNET_CHECKPOINT_ANCHORS.map(anchor => Object.freeze({
    networkId: NETWORK_ID,
    protocolVersion: anchor.protocolVersion,
    height: anchor.height,
    blockHash: anchor.blockHash,
    chainWork: anchor.chainWork,
    genesisHash: GENESIS_HASH
  }))
);

function envValue(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function hasProof(hash, difficulty) {
  return hash.startsWith('0'.repeat(difficulty));
}

function validMiner(address) {
  return isPublicKey(address);
}

function newLedgerState() {
  return { balances: new Map(), nonces: new Map(), supply: 0, coinbase: new Map() };
}

function balanceOf(state, address) {
  return state.balances.get(address) || 0;
}

function nonceOf(state, address) {
  return state.nonces.get(address) || 0;
}

function verifyBlockTransactions(block, state, height, consensus) {
  const next = {
    balances: new Map(state.balances),
    nonces: new Map(state.nonces),
    supply: state.supply,
    coinbase: new Map(state.coinbase || new Map()),
    fees: 0,
    transactions: []
  };
  if (!Array.isArray(block.transactions) || block.transactions.length > 10_000) {
    throw new Error('Block transactions are invalid or exceed the block limit.');
  }
  const maturityActive = isCoinbaseMaturityActive(height, consensus);
  for (const raw of block.transactions) {
    const result = verifyTransaction(raw, { allowLegacy: block.height < PROTOCOL_UPGRADE_HEIGHT });
    if (!result.valid) throw new Error(result.error);
    const tx = result.transaction;
    const amount = result.amountUnits;
    const fee = result.feeUnits;
    const expectedNonce = nonceOf(next, tx.sender) + 1;
    if (tx.nonce !== expectedNonce) throw new Error('Transaction nonce is not the next expected value.');
    const balance = balanceOf(next, tx.sender);
    const immature = maturityActive
      ? immatureCoinbaseUnitsFromState(next.coinbase, tx.sender, height, consensus.coinbaseMaturity)
      : 0;
    const spendable = balance - immature;
    if (amount > spendable || fee > spendable - amount) {
      throw new Error(maturityActive
        ? 'Transaction spends immature coinbase funds or more than the confirmed balance.'
        : 'Transaction spends more than the confirmed balance.');
    }
    if (fee > MAX_SUPPLY - next.fees) throw new Error('Block transaction fees exceed the supported supply range.');
    next.fees += fee;
    next.balances.set(tx.sender, balance - amount - fee);
    next.balances.set(tx.recipient, balanceOf(next, tx.recipient) + amount);
    next.nonces.set(tx.sender, tx.nonce);
    // Keep the exact validated atomic values so persistence cannot re-parse
    // decimal fields differently from consensus.
    next.transactions.push({ transaction: tx, amountUnits: amount, feeUnits: fee });
  }
  return next;
}

function medianTimePast(blocks) {
  const timestamps = blocks.slice(-MEDIAN_TIME_WINDOW).map(block => block.timestamp).sort((a, b) => a - b);
  if (!timestamps.length) throw new Error('Insufficient chain history for median time past.');
  return timestamps[Math.floor(timestamps.length / 2)];
}

function validateBlock(block, previousBlocks, state, consensus = normalizeConsensus()) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('Block must be an object.');
  }
  const previous = previousBlocks[previousBlocks.length - 1];
  if (!previous) throw new Error('Insufficient chain history to validate a block.');
  const height = previous.height + 1;
  if (block.height !== height) throw new Error('Block height does not extend the current chain.');
  if (block.prevHash !== previous.hash) throw new Error('Block previous hash does not match the chain tip.');

  // Era admission runs before hashing. A block below the activation height is
  // never interpreted by the V2 serializer, even if it carries version: 2; that
  // keeps every historical style hash frozen.
  const v2 = isV2Height(height, consensus);
  let preimage;
  if (v2) {
    preimage = assertV2BlockShape(block, {
      allowDerived: true,
      expectedNetworkId: NETWORK_ID
    });
  } else {
    assertEra1BlockShape(block);
    preimage = canonicalBlockPreimage(block);
  }

  if (!Number.isSafeInteger(block.timestamp) || block.timestamp <= medianTimePast(previousBlocks) ||
    block.timestamp > Date.now() + 120_000) {
    throw new Error('Block timestamp must exceed median time past and cannot be far in the future.');
  }
  if (!Number.isSafeInteger(block.nonce) || block.nonce < 0) throw new Error('Block nonce is invalid.');
  if (block.difficulty !== expectedDifficulty(previousBlocks, height, consensus)) {
    throw new Error('Block difficulty does not match the network adjustment rules.');
  }
  if (block.chainWork !== undefined && block.chainWork !== (BigInt(previous.chainWork || '0') + workForDifficulty(block.difficulty)).toString()) {
    throw new Error('Block chainWork is incorrect.');
  }
  if (!validMiner(block.miner)) throw new Error('Block miner must be an Ed25519 public key.');
  if (block.message !== null) throw new Error('Only the genesis block may contain a message.');
  const txState = verifyBlockTransactions(block, state, height, consensus);
  const subsidy = rewardForHeight(height, txState.supply);
  const reward = subsidy + txState.fees;
  if (!block.reward || block.reward.recipient !== block.miner ||
    block.reward.amount !== formatUnits(reward)) {
    throw new Error('Block reward does not match the scheduled subsidy plus transaction fees.');
  }
  const digest = sha256(preimage);
  if (v2) {
    // The hash is derived. A supplied value is checked, never trusted; an
    // absent value is allowed for a received block and filled in by the caller.
    if (block.hash !== undefined && block.hash !== digest) {
      throw new Error('Block hash or proof of work is invalid.');
    }
  } else if (block.hash !== digest) {
    throw new Error('Block hash or proof of work is invalid.');
  }
  if (!hasProof(digest, block.difficulty)) {
    throw new Error('Block hash or proof of work is invalid.');
  }
  txState.balances.set(block.miner, balanceOf(txState, block.miner) + reward);
  txState.supply += subsidy;
  if (isCoinbaseMaturityActive(height, consensus)) {
    const entries = txState.coinbase.get(block.miner) || [];
    entries.push({ height, units: reward });
    txState.coinbase.set(block.miner, entries);
    pruneMatureCoinbase(txState.coinbase, height, consensus.coinbaseMaturity);
  }
  txState.hash = digest;
  return txState;
}

function validateChainInternal(blocks, consensus = normalizeConsensus()) {
  try {
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('Chain is empty.');
    const genesis = genesisBlock();
    if (JSON.stringify(headerOf(blocks[0])) !== JSON.stringify(headerOf(genesis)) ||
      blocks[0].hash !== genesis.hash) {
      throw new Error('Genesis block does not match the permanent network genesis.');
    }
    if (blocks[0].chainWork !== undefined && blocks[0].chainWork !== '0') {
      throw new Error('Genesis chainWork must be zero.');
    }
    const state = newLedgerState();
    const history = [blocks[0]];
    let chainWork = 0n;
    for (let i = 1; i < blocks.length; i += 1) {
      const current = blocks[i];
      const nextState = validateBlock(current, history.slice(-MEDIAN_TIME_WINDOW), state, consensus);
      chainWork += workForDifficulty(current.difficulty);
      if (current.chainWork !== undefined && current.chainWork !== chainWork.toString()) {
        throw new Error(`Block ${current.height} has incorrect chainWork.`);
      }
      state.balances = nextState.balances;
      state.nonces = nextState.nonces;
      state.supply = nextState.supply;
      state.coinbase = nextState.coinbase;
      history.push(current);
    }
    return {
      valid: true,
      height: blocks.length - 1,
      supply: state.supply,
      chainWork: chainWork.toString(),
      error: null,
      balances: state.balances,
      nonces: state.nonces,
      coinbase: state.coinbase
    };
  } catch (error) {
    return {
      valid: false,
      height: null,
      supply: null,
      chainWork: null,
      error: error.message,
      balances: null,
      nonces: null,
      coinbase: null
    };
  }
}

export function validateChain(blocks, options = {}) {
  const { balances: _balances, nonces: _nonces, coinbase: _coinbase, ...result } =
    validateChainInternal(blocks, normalizeConsensus(options));
  return result;
}

// Startup against Turso can fail while a hibernating database wakes up. Those
// failures are transport-level and must be retried with a fresh client, because
// a client that has already lost its socket cannot be reused. Permanent errors
// (bad checkpoint, invalid configuration, unsupported data) fail immediately.
const STARTUP_RETRY_BASES_MS = [2_000, 3_000, 5_000, 8_000];
const STARTUP_TRANSIENT_PATTERN = /UND_ERR_SOCKET|fetch failed|other side closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network|timeout|temporarily unavailable|database is locked|database is busy/i;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isTransientStartupError(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`;
  return STARTUP_TRANSIENT_PATTERN.test(text);
}

// Fibonacci-like backoff: 2s, 3s, 5s, 8s, then 10s cap. Jitter prevents a fleet
// of restarting nodes from waking the database in a synchronized thundering herd.
export function startupRetryDelayMs(attempt, maxDelayMs = 10_000) {
  const index = Math.max(0, Math.min(STARTUP_RETRY_BASES_MS.length - 1, attempt - 1));
  const base = Math.min(STARTUP_RETRY_BASES_MS[index] ?? 10_000, maxDelayMs);
  const jitterWindow = Math.min(1_000, Math.max(1, Math.floor(base * 0.2)));
  return base + Math.floor(Math.random() * jitterWindow);
}

/**
 * Node 24's undici fetch is more reliable against Turso over HTTPS than over
 * the libsql scheme during a cold start. Keep every other URL byte-for-byte
 * intact so file: databases and explicitly configured HTTPS endpoints are
 * unaffected.
 */
export function normalizeTursoUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.replace(/^libsql:\/\//i, 'https://');
}

export const BLOCK_LOAD_PAGE_SIZE = 250;

/**
 * Reads the full block table in bounded pages. A stable upper bound is captured
 * before paging so a concurrent tip extension cannot shift OFFSET windows and
 * duplicate or skip rows. Small pages keep a cold Turso socket alive instead of
 * asking it to stream the entire chain in one response.
 */
export async function fetchPagedBlockRows(client, {
  pageSize = BLOCK_LOAD_PAGE_SIZE,
  maxHeight = null
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('Block load page size must be a positive safe integer.');
  }
  if (maxHeight !== null && (!Number.isSafeInteger(maxHeight) || maxHeight < 0)) {
    throw new Error('Block load upper bound must be a non-negative safe integer.');
  }

  const bounded = maxHeight !== null;
  const where = bounded ? 'WHERE height <= ?' : '';
  const rows = [];
  let offset = 0;
  for (;;) {
    const args = bounded ? [maxHeight, pageSize, offset] : [pageSize, offset];
    const result = await client.execute({
      sql: `SELECT height, timestamp, hash, miner, tx_count, json, chain_work FROM blocks ${where} ORDER BY height LIMIT ? OFFSET ?`.replace(/\s+/g, ' ').trim(),
      args
    });
    const page = result?.rows ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return rows;
}

/**
 * Creates and validates a ledger with fresh clients on every attempt. A failed
 * candidate is closed before the next attempt so no half-open socket survives.
 * The returned ledger has already passed the startup integrity check.
 */
export async function createLedgerWithRetry(
  databasePath = 'blackcoin.db',
  options = {},
  {
    attempts = 10,
    maxDelayMs = 10_000,
    label = 'Ledger initialization',
    onRetry = null
  } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let candidate = null;
    try {
      candidate = await createLedger(databasePath, options);
      const integrity = await candidate.validateStoredChain();
      if (integrity?.valid === false) {
        console.error(`Stored chain integrity issue on startup: ${integrity.error}`);
      }
      return candidate;
    } catch (error) {
      lastError = error;
      if (candidate) {
        try { candidate.close(); } catch { /* already closed */ }
      }
      if (!isTransientStartupError(error) || attempt >= attempts) throw error;
      const waitMs = startupRetryDelayMs(attempt, maxDelayMs);
      const detail = { attempt, attempts, delayMs: waitMs, error };
      if (typeof onRetry === 'function') onRetry(detail);
      else console.warn(`${label} failed (attempt ${attempt}/${attempts}): ${error?.message || error}. Retrying in ${waitMs}ms...`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

export async function createLedger(databasePath = 'blackcoin.db', options = {}) {
  // Consensus switches are read once at construction. A running process never
  // changes era mid-flight. Q-1 is resolved: the compiled default is height
  // 2026, and an operator may move it for testnet with
  // BANNEKER_V2_ACTIVATION_HEIGHT. An empty environment value falls back to the
  // compiled default instead of silently unscheduling consensus.
  const activationEnv = envValue(V2_ACTIVATION_ENV);
  const activationValue = Object.hasOwn(options, 'v2ActivationHeight')
    ? options.v2ActivationHeight
    : (activationEnv ?? V2_ACTIVATION_HEIGHT);
  const maturityEnv = envValue(COINBASE_MATURITY_ENV);
  const maturityValue = Object.hasOwn(options, 'coinbaseMaturity')
    ? options.coinbaseMaturity
    : (maturityEnv ?? COINBASE_MATURITY);
  const maturityHeightEnv = envValue(COINBASE_MATURITY_HEIGHT_ENV);
  const maturityHeightValue = Object.hasOwn(options, 'coinbaseMaturityHeight')
    ? options.coinbaseMaturityHeight
    : maturityHeightEnv;
  const v2ActivationHeight = parseV2ActivationHeight(activationValue);
  const coinbaseMaturity = parseCoinbaseMaturity(maturityValue);
  const coinbaseMaturityHeight = parseCoinbaseMaturityHeight(maturityHeightValue);
  const consensus = normalizeConsensus({
    v2ActivationHeight,
    coinbaseMaturity,
    coinbaseMaturityHeight: coinbaseMaturityHeight ?? v2ActivationHeight
  });

  // Checkpoint configuration is a compiled/operator constant, never a database
  // row. Q-2 is resolved: the compiled Mainnet Checkpoint 1 at height 731 is
  // enforced by default. An operator may supply an explicit set, but an empty
  // environment value falls back to the compiled anchor rather than disabling
  // consensus. An explicit programmatic `checkpoints: []` disables it for local
  // chains, as tests do.
  const compiledCheckpoints = COMPILED_MAINNET_CHECKPOINTS
    .filter(anchor => appliesToActivation(anchor, v2ActivationHeight));
  const checkpointEnv = envValue(CHECKPOINT_ENV);
  const checkpointValue = Object.hasOwn(options, 'checkpoints')
    ? options.checkpoints
    : (checkpointEnv ?? compiledCheckpoints);
  const checkpointBurialValue = Object.hasOwn(options, 'checkpointBurial')
    ? options.checkpointBurial
    : envValue(CHECKPOINT_BURIAL_ENV);
  const checkpointBurial = parseCheckpointBurial(checkpointBurialValue);
  const priorCheckpointValue = Object.hasOwn(options, 'previousCheckpoints')
    ? options.previousCheckpoints
    : null;
  const expectedManifestDigest = Object.hasOwn(options, 'expectedManifestDigest')
    ? options.expectedManifestDigest
    : (process.env[CHECKPOINT_MANIFEST_DIGEST_ENV] || null);
  const checkpointManifest = normalizeCheckpointManifest(checkpointValue, {
    networkId: NETWORK_ID,
    genesisHash: GENESIS_HASH
  });
  const manifestDigest = computeManifestDigest(checkpointManifest);
  const checkpointSetDigest = computeCheckpointSetDigest(checkpointManifest.checkpoints);
  const checkpoints = checkpointManifest.checkpoints;
  const checkpointsByHeight = new Map(checkpoints.map(checkpoint => [checkpoint.height, checkpoint]));

  const tursoUrl = envValue('TURSO_DATABASE_URL');
  // Keep an unset token as undefined; the HTTP client omits the Authorization
  // header only for undefined, while null would be sent as "Bearer null".
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  // libsql:// is normalized to https:// so Node 24's undici HTTP transport
  // handles the remote endpoint during Turso cold starts.
  const url = normalizeTursoUrl(tursoUrl) || `file:${databasePath}`;
  const client = createClient({ url, authToken: tursoToken });

  // All chain-state mutations (block acceptance, mempool admission, and chain
  // replacement) pass through this queue. It serializes conflicting writers and
  // keeps each operation's read/validate/write sequence consistent.
  let writeTail = Promise.resolve();
  function withWriteLock(fn) {
    const result = writeTail.then(fn);
    writeTail = result.catch(() => {});
    return result;
  }

  async function withTransaction(fn, mode = 'write') {
    const transaction = await client.transaction(mode);
    try {
      const result = await fn(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      try { await transaction.rollback(); } catch { /* already settled */ }
      throw error;
    }
  }

  // Initialize schema
  await client.batch([
    `CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      miner TEXT,
      tx_count INTEGER NOT NULL,
      json TEXT NOT NULL,
      chain_work TEXT NOT NULL DEFAULT '0'
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      address TEXT PRIMARY KEY,
      balance_units INTEGER NOT NULL DEFAULT 0,
      nonce INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS mempool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      nonce INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      json TEXT NOT NULL,
      UNIQUE(sender, nonce)
    )`,
    `CREATE TABLE IF NOT EXISTS peers (
      url TEXT PRIMARY KEY,
      last_seen INTEGER,
      last_error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS peer_bans (
      identifier TEXT PRIMARY KEY,
      score INTEGER NOT NULL,
      banned_until INTEGER,
      reason TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ], "write");

  // Check for chain_work column (for migrations)
  const tableInfo = await client.execute("PRAGMA table_info(blocks)");
  if (!tableInfo.rows.some(row => row.name === 'chain_work')) {
    await client.execute("ALTER TABLE blocks ADD COLUMN chain_work TEXT NOT NULL DEFAULT '0'");
  }

  // Genesis block initialization
  const genesisCheck = await client.execute("SELECT 1 FROM blocks WHERE height = 0");
  if (genesisCheck.rows.length === 0) {
    const genesis = genesisBlock();
    await client.execute({
      sql: "INSERT INTO blocks(height, timestamp, hash, miner, tx_count, json, chain_work) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [0, GENESIS_TIMESTAMP, genesis.hash, null, 0, JSON.stringify(genesis), '0']
    });
  }

  async function getBlockRows() {
    // Capture the tip first so OFFSET paging sees a consistent upper bound even
    // if a peer sync extends the chain while a full replay is in progress.
    const tipHeight = await getTipHeight();
    return fetchPagedBlockRows(client, { maxHeight: tipHeight });
  }

  async function getBlocks() {
    const rows = await getBlockRows();
    return rows.map(row => JSON.parse(row.json));
  }

  /**
   * Bounded contiguous read used by the paged chain exchange. The database does
   * the slicing, so a peer asking for one page never causes a full-chain read.
   */
  async function getBlockRange(fromHeight, toHeight = Number.MAX_SAFE_INTEGER, {
    limit = MAX_PAGE_BLOCKS
  } = {}) {
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
      throw new Error('Block range start must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(toHeight) || toHeight < fromHeight) {
      throw new Error('Block range end must be a safe integer at or above the start.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_BLOCKS) {
      throw new Error(`Block range limit must be between 1 and ${MAX_PAGE_BLOCKS}.`);
    }
    const result = await client.execute({
      sql: "SELECT json FROM blocks WHERE height >= ? AND height <= ? ORDER BY height LIMIT ?",
      args: [fromHeight, toHeight, limit]
    });
    return result.rows.map(row => JSON.parse(row.json));
  }

  async function getTipHeight() {
    const result = await client.execute("SELECT MAX(height) AS height FROM blocks");
    const height = Number(result.rows[0]?.height ?? 0);
    return Number.isSafeInteger(height) && height >= 0 ? height : 0;
  }

  /**
   * Identity the node advertises to peers and supervisors. Everything here is
   * derived from compiled constants or the manifest, never from a database row.
   */
  function getChainIdentity() {
    return {
      networkId: NETWORK_ID,
      protocolVersion: PROTOCOL_VERSION,
      genesisHash: GENESIS_HASH,
      v2ActivationHeight: consensus.v2ActivationHeight,
      coinbaseMaturity: consensus.coinbaseMaturity,
      targetBlockSeconds: TARGET_BLOCK_TIME_SECONDS,
      halvingInterval: HALVING_INTERVAL,
      checkpointBurial,
      checkpointCount: checkpoints.length,
      manifestDigest,
      checkpointSetDigest
    };
  }

  // Storage layer (L3) cross-check. A mismatch is reported, not silently
  // repaired, and it never rewrites history. Startup keeps using the pure chain
  // replay so an operator can inspect a bad row instead of losing the chain.
  function validateStoredRows(rows, blocks) {
    const errors = [];
    if (rows.length !== blocks.length) {
      errors.push(`Stored row count ${rows.length} does not match parsed block count ${blocks.length}.`);
    }
    const count = Math.min(rows.length, blocks.length);
    for (let index = 0; index < count; index += 1) {
      const row = rows[index];
      const block = blocks[index];
      const label = `height ${row.height}`;
      try {
        if (Number(row.height) !== block.height) {
          errors.push(`${label}: height column does not match json.`);
        }
        if (Number(row.timestamp) !== block.timestamp) {
          errors.push(`${label}: timestamp column does not match json.`);
        }
        if (row.hash !== block.hash) {
          errors.push(`${label}: hash column does not match json.`);
        }
        if ((row.miner ?? null) !== (block.miner ?? null)) {
          errors.push(`${label}: miner column does not match json.`);
        }
        const txCount = Array.isArray(block.transactions) ? block.transactions.length : -1;
        if (Number(row.tx_count) !== txCount) {
          errors.push(`${label}: tx_count column does not match json.`);
        }
        if (String(row.chain_work) !== String(block.chainWork ?? block.chain_work ?? '0')) {
          errors.push(`${label}: chain_work column does not match json.`);
        }

        if (block.version === 2) {
          const preimage = assertV2BlockShape(block, {
            allowDerived: true,
            requireDerived: true,
            expectedNetworkId: NETWORK_ID
          });
          const expectedHash = sha256(preimage);
          if (row.hash !== expectedHash) {
            errors.push(`${label}: V2 hash column does not match recomputation.`);
          }
          if (block.hash !== expectedHash) {
            errors.push(`${label}: V2 json hash does not match recomputation.`);
          }
        } else {
          assertEra1BlockShape(block);
          const expectedHash = sha256(canonicalBlockPreimage(block));
          if (row.hash !== expectedHash) {
            errors.push(`${label}: Era 1 hash column does not match recomputation.`);
          }
        }
      } catch (error) {
        errors.push(`${label}: ${error.code ? `${error.code}: ` : ''}${error.message}`);
      }
    }
    return {
      storageValid: errors.length === 0,
      storageErrors: errors.slice(0, 25)
    };
  }

  function checkpointStatus(blocks) {
    return evaluateCheckpointSet(checkpoints, blocks, {
      networkId: NETWORK_ID,
      genesisHash: GENESIS_HASH,
      activationHeight: consensus.v2ActivationHeight,
      manifestDigest,
      checkpointSetDigest
    });
  }

  async function validateStoredChain() {
    const rows = await getBlockRows();
    const blocks = rows.map(row => JSON.parse(row.json));
    const validation = validateChainInternal(blocks, consensus);
    const { balances: _balances, nonces: _nonces, coinbase: _coinbase, ...summary } = validation;
    const storage = validateStoredRows(rows, blocks);
    const checkpoint = checkpointStatus(blocks);
    let accountErrors;
    if (!validation.valid) {
      accountErrors = compareAccounts(new Map(), validation);
    } else {
      try {
        accountErrors = compareAccounts(await readAccounts(), validation);
      } catch (error) {
        accountErrors = [{ code: 'ACCOUNT_STATE_INVALID', message: error.message }];
      }
    }
    const accountsValid = accountErrors.length === 0;
    const healthy = summary.valid && accountsValid && storage.storageValid &&
      checkpoint.checkpointState !== 'VIOLATED' &&
      checkpoint.checkpointState !== 'UNSUPPORTED_PROTOCOL_VERSION';
    return {
      ...summary,
      accountsValid,
      accountErrors,
      ...storage,
      ...checkpoint,
      healthy
    };
  }

  async function readAccounts() {
    const result = await client.execute("SELECT address, balance_units, nonce FROM accounts");
    const accounts = new Map();
    for (const row of result.rows) {
      const balance = Number(row.balance_units);
      const nonce = Number(row.nonce);
      if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_SUPPLY ||
        !Number.isSafeInteger(nonce) || nonce < 0) {
        throw new Error('Stored account values are outside the safe integer range.');
      }
      accounts.set(row.address, { balance_units: balance, nonce });
    }
    return accounts;
  }

  function sumBalances(accounts) {
    let total = 0;
    for (const account of accounts.values()) {
      total += account.balance_units;
      if (!Number.isSafeInteger(total) || total > MAX_SUPPLY) {
        throw new Error('Stored account supply exceeds the safe integer or monetary policy limit.');
      }
    }
    return total;
  }

  /**
   * Deterministic L4 comparison between the replayed state and the `accounts`
   * table. It reports *why* the state differs instead of collapsing every fault
   * into a boolean. The replay (validateChainInternal) has already checked
   * signatures, nonces, fee/amount arithmetic, balances, reward schedule, and
   * coinbase maturity at inclusion height.
   */
  function compareAccounts(accounts, validation) {
    if (!validation.valid || !validation.balances) {
      return [{
        code: 'CHAIN_INVALID',
        message: validation.error || 'Chain replay did not produce account state.'
      }];
    }
    const errors = [];
    for (const [address, expectedBalance] of validation.balances) {
      const expectedNonce = validation.nonces.get(address) || 0;
      const account = accounts.get(address);
      if (!account) {
        errors.push({
          code: 'ACCOUNT_MISSING',
          address,
          expectedBalance,
          expectedNonce
        });
        continue;
      }
      if (account.balance_units !== expectedBalance) {
        errors.push({
          code: 'BALANCE_MISMATCH',
          address,
          expected: expectedBalance,
          actual: account.balance_units
        });
      }
      if (account.nonce !== expectedNonce) {
        errors.push({
          code: 'NONCE_MISMATCH',
          address,
          expected: expectedNonce,
          actual: account.nonce
        });
      }
    }
    for (const [address, account] of accounts) {
      if (validation.balances.has(address)) continue;
      errors.push({
        code: 'ACCOUNT_EXTRA',
        address,
        actualBalance: account.balance_units,
        actualNonce: account.nonce
      });
    }
    try {
      const total = sumBalances(accounts);
      if (total !== validation.supply) {
        errors.push({
          code: 'SUPPLY_MISMATCH',
          expected: validation.supply,
          actual: total
        });
      }
    } catch (error) {
      errors.push({ code: 'ACCOUNT_STATE_INVALID', message: error.message });
    }
    return errors.slice(0, 25);
  }

  function accountsMatchValidation(accounts, validation) {
    return compareAccounts(accounts, validation).length === 0;
  }

  // Startup validation and migration with safe recovery: if the stored tip is
  // invalid, roll back only invalid tip blocks to the last valid block. Account
  // reconstruction is checked against a full replay and repaired atomically.
  // Never wipe to genesis.
  let storedBlocks = await getBlocks();
  let startupValidation = validateChainInternal(storedBlocks, consensus);
  let recovery = null;
  if (!startupValidation.valid) {
    for (let end = storedBlocks.length - 1; end >= 1; end -= 1) {
      const candidate = storedBlocks.slice(0, end);
      const result = validateChainInternal(candidate, consensus);
      if (result.valid) {
        recovery = { blocks: candidate, removed: storedBlocks.length - end, error: startupValidation.error };
        storedBlocks = candidate;
        startupValidation = result;
        break;
      }
    }
    if (!recovery) {
      client.close();
      throw new Error(`Stored chain failed integrity verification: ${startupValidation.error}`);
    }
  }

  const startupAccounts = await readAccounts();
  if (recovery || !accountsMatchValidation(startupAccounts, startupValidation)) {
    await withTransaction(async transaction => {
      if (recovery) {
        await transaction.execute({
          sql: 'DELETE FROM blocks WHERE height >= ?',
          args: [recovery.blocks.length]
        });
        await transaction.execute('DELETE FROM mempool');
      }
      await transaction.execute('DELETE FROM accounts');
      for (const [address, balance] of startupValidation.balances) {
        await transaction.execute({
          sql: 'INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, ?)',
          args: [address, balance, startupValidation.nonces.get(address) || 0]
        });
      }
    });
    if (recovery) {
      console.warn(`Rolled back ${recovery.removed} invalid tip block(s) to height ${recovery.blocks.length - 1}: ${recovery.error}`);
    } else {
      console.warn('Rebuilt account state from validated chain history.');
    }
  }

  // Migrate chain work if needed
  let needsMigration = false;
  for (const block of storedBlocks) {
    if (block.chainWork === undefined) {
      needsMigration = true;
      break;
    }
  }

  if (needsMigration) {
    let chainWork = 0n;
    const batch = [];
    for (const block of storedBlocks) {
      if (block.height > 0) chainWork += workForDifficulty(block.difficulty);
      const migrated = { ...block, chainWork: chainWork.toString() };
      batch.push({
        sql: "UPDATE blocks SET chain_work = ?, json = ? WHERE height = ?",
        args: [chainWork.toString(), JSON.stringify(migrated), block.height]
      });
    }
    await client.batch(batch, "write");
  }

  // Checkpoint enforcement at startup. Structural continuity is checked first,
  // then every applicable anchor is fully re-derived from genesis. A violated
  // set is fatal: the database is preserved for the operator, and the node must
  // not serve a chain that contradicts its own compiled constants.
  try {
    validateCheckpointSet(checkpointManifest, {
      networkId: NETWORK_ID,
      genesisHash: GENESIS_HASH,
      priorManifest: priorCheckpointValue,
      expectedManifestDigest,
      blocks: storedBlocks,
      activationHeight: consensus.v2ActivationHeight,
      burial: checkpointBurial,
      // K-6 is a publication-time rule for *adding* an anchor. Startup must not
      // reject an already-published anchor merely because a test chain is short.
      enforceBurial: false
    });
    const startupCheckpoints = checkpointStatus(storedBlocks);
    if (startupCheckpoints.checkpointState === 'VIOLATED') {
      const first = startupCheckpoints.checkpointErrors[0];
      throw new CheckpointError(
        'CHECKPOINT_VIOLATION',
        `Stored chain violates checkpoint at height ${first?.height}: ${first?.message || 'verification failed'}.`,
        first?.details ?? {}
      );
    }
    if (startupCheckpoints.checkpointState === 'UNSUPPORTED_PROTOCOL_VERSION') {
      throw new CheckpointError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        'A configured checkpoint uses a protocol version this binary cannot validate.'
      );
    }
  } catch (error) {
    client.close();
    throw error;
  }

  async function getAccount(address) {
    const result = await client.execute({
      sql: "SELECT balance_units, nonce FROM accounts WHERE address = ?",
      args: [address]
    });
    const account = result.rows[0] || { balance_units: 0, nonce: 0 };
    if (!Number.isSafeInteger(Number(account.balance_units)) || account.balance_units < 0 ||
      account.balance_units > MAX_SUPPLY || !Number.isSafeInteger(Number(account.nonce)) || account.nonce < 0) {
      throw new Error('Stored account values are outside the safe integer range.');
    }
    return { balance_units: Number(account.balance_units), nonce: Number(account.nonce) };
  }

  async function getSupply() {
    const result = await client.execute("SELECT COALESCE(SUM(balance_units), 0) AS total FROM accounts");
    const total = Number(result.rows[0].total);
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_SUPPLY) {
      throw new Error('Stored account supply exceeds the safe integer or monetary policy limit.');
    }
    return total;
  }

  async function pendingFor(address) {
    const result = await client.execute({
      sql: "SELECT json FROM mempool WHERE sender = ? ORDER BY nonce",
      args: [address]
    });
    return result.rows.map(row => JSON.parse(row.json));
  }

  async function applyBlock(block, resolvedTransactions = null, executor = client) {
    if (!block || !Array.isArray(block.transactions)) {
      throw new Error('Block transactions are invalid.');
    }
    const transactions = resolvedTransactions || block.transactions.map(raw => {
      const result = verifyTransaction(raw, { allowLegacy: block.height < PROTOCOL_UPGRADE_HEIGHT });
      if (!result.valid) throw new LedgerValidationError(result.error);
      return { transaction: result.transaction, amountUnits: result.amountUnits, feeUnits: result.feeUnits };
    });
    if (transactions.length !== block.transactions.length) {
      throw new Error('Resolved transaction list does not match the block.');
    }
    if (!block.reward || typeof block.reward.amount !== 'string') {
      throw new Error('Block reward is missing.');
    }

    const batch = [];
    for (const item of transactions) {
      const tx = item.transaction;
      const amount = item.amountUnits;
      const fee = item.feeUnits;
      const debit = amount + fee;
      if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(fee) || !Number.isSafeInteger(debit) ||
        amount < 0 || fee < 0) {
        throw new Error('Resolved transaction amounts are outside the safe integer range.');
      }

      batch.push({
        sql: `INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET balance_units = balance_units + excluded.balance_units,
              nonce = excluded.nonce`,
        args: [tx.sender, -debit, tx.nonce]
      });
      batch.push({
        sql: `INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, 0)
              ON CONFLICT(address) DO UPDATE SET balance_units = balance_units + excluded.balance_units`,
        args: [tx.recipient, amount]
      });
      batch.push({
        sql: "DELETE FROM mempool WHERE sender = ? AND nonce <= ?",
        args: [tx.sender, tx.nonce]
      });
    }

    const reward = block.reward.amount === '0' ? 0 : parseAmount(block.reward.amount);
    if (!Number.isSafeInteger(reward) || reward < 0) {
      throw new Error('Block reward is outside the safe integer range.');
    }
    if (reward > 0) {
      batch.push({
        sql: `INSERT INTO accounts(address, balance_units, nonce) VALUES (?, ?, 0)
              ON CONFLICT(address) DO UPDATE SET balance_units = balance_units + excluded.balance_units`,
        args: [block.miner, reward]
      });
    }

    const chainWork = block.chainWork ?? block.chain_work;
    if (chainWork === undefined || chainWork === null) {
      throw new Error('Block chain work is missing.');
    }
    batch.push({
      sql: "INSERT INTO blocks(height, timestamp, hash, miner, tx_count, json, chain_work) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [block.height, block.timestamp, block.hash, block.miner, block.transactions.length, JSON.stringify(block), chainWork]
    });

    if (executor === client) {
      await executor.batch(batch, 'write');
    } else {
      await executor.batch(batch);
    }
  }

  async function acceptTransaction(rawTx) {
    return withWriteLock(() => acceptTransactionLocked(rawTx));
  }

  async function acceptTransactionLocked(rawTx) {
    const result = verifyTransaction(rawTx);
    if (!result.valid) throw new LedgerValidationError(result.error);
    const tx = result.canonicalTransaction;
    const debit = result.amountUnits + result.feeUnits;
    if (!Number.isSafeInteger(debit)) {
      throw new LedgerValidationError('Transaction amount and fee exceed the safe integer range.');
    }

    const mempoolCount = await client.execute("SELECT COUNT(*) AS count FROM mempool");
    if (Number(mempoolCount.rows[0].count) >= MAX_MEMPOOL_TRANSACTIONS) {
      throw new LedgerValidationError(`Mempool is full (maximum ${MAX_MEMPOOL_TRANSACTIONS} transactions).`, 503);
    }

    const account = await getAccount(tx.sender);
    // Spending is checked against the next block height, because that is where
    // an admitted transaction can first be mined. Coinbase rewards that are not
    // yet mature are excluded from the spendable balance.
    const blocks = await getBlocks();
    const nextHeight = blocks[blocks.length - 1].height + 1;
    const immature = coinbaseEntriesForHeight(blocks, nextHeight, consensus);
    const immatureUnits = coinbaseTotalFor(immature.get(tx.sender));
    const pending = await pendingFor(tx.sender);
    let available = account.balance_units - immatureUnits;
    let lastNonce = account.nonce;
    for (const item of pending) {
      let normalized;
      try {
        normalized = normalizeTransaction(item);
        const amounts = resolveTransactionAmounts(normalized);
        if (normalized.sender !== tx.sender || normalized.nonce !== lastNonce + 1) {
          throw new Error('Mempool nonce sequence is inconsistent.');
        }
        available -= amounts.amountUnits + amounts.feeUnits;
        lastNonce = normalized.nonce;
      } catch {
        // Signatures were checked at admission; this guards against corrupted
        // or ambiguous rows without paying a signature check per pending item.
        throw new LedgerValidationError('Mempool contains an invalid transaction; refusing to extend it.', 503);
      }
    }
    if (available < 0) {
      throw new LedgerValidationError(immatureUnits > 0
        ? 'Pending transactions exceed the spendable confirmed balance.'
        : 'Pending transactions exceed the confirmed balance.', 503);
    }

    const expectedNonce = lastNonce + 1;
    if (tx.nonce !== expectedNonce) {
      throw new LedgerValidationError(`Invalid nonce. The next nonce for this wallet is ${expectedNonce}.`);
    }

    if (debit > available) {
      throw new LedgerValidationError(immatureUnits > 0
        ? 'Transaction spends immature coinbase funds or more than the confirmed balance.'
        : 'Insufficient confirmed balance after pending transactions.');
    }

    try {
      await client.execute({
        sql: "INSERT INTO mempool(sender, nonce, timestamp, json) VALUES (?, ?, ?, ?)",
        args: [tx.sender, tx.nonce, tx.timestamp, JSON.stringify(tx)]
      });
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        throw new LedgerValidationError('This sender nonce is already pending.');
      }
      throw error;
    }
    return tx;
  }

  async function readMempoolEntries() {
    const result = await client.execute("SELECT json FROM mempool ORDER BY sender, nonce, id");
    const entries = [];
    for (const row of result.rows) {
      try {
        const resultTx = verifyTransaction(JSON.parse(row.json));
        if (!resultTx.valid) continue;
        entries.push({
          transaction: resultTx.canonicalTransaction,
          amountUnits: resultTx.amountUnits,
          feeUnits: resultTx.feeUnits
        });
      } catch {
        // Malformed or stale rows are never admitted to a mining template.
      }
    }
    return entries;
  }

  async function listMempool() {
    return (await readMempoolEntries()).map(entry => entry.transaction);
  }

  async function selectMiningTransactions(accounts, immature = new Map()) {
    const entries = await readMempoolEntries();
    const grouped = new Map();
    for (const entry of entries) {
      const sender = entry.transaction.sender;
      if (!grouped.has(sender)) grouped.set(sender, []);
      grouped.get(sender).push(entry);
    }
    for (const transactions of grouped.values()) {
      transactions.sort((a, b) => a.transaction.nonce - b.transaction.nonce);
    }

    const balances = new Map([...accounts].map(([address, account]) => [address, account.balance_units]));
    const nonces = new Map([...accounts].map(([address, account]) => [address, account.nonce]));
    const positions = new Map();
    const ready = [];
    for (const [sender, transactions] of grouped) {
      positions.set(sender, 0);
      ready.push(transactions[0]);
    }

    const selected = [];
    while (ready.length) {
      ready.sort((a, b) => b.feeUnits - a.feeUnits ||
        a.transaction.timestamp - b.transaction.timestamp ||
        a.transaction.sender.localeCompare(b.transaction.sender) ||
        a.transaction.nonce - b.transaction.nonce);
      const entry = ready.shift();
      const tx = entry.transaction;
      const sender = tx.sender;
      const position = positions.get(sender);
      if (position === undefined) continue;

      // A gap, replay, or unaffordable transaction makes every later nonce for
      // that sender unusable until the chain changes.
      if (tx.nonce !== (nonces.get(sender) || 0) + 1) {
        positions.delete(sender);
        continue;
      }
      const balance = balances.get(sender) || 0;
      const spendable = balance - coinbaseTotalFor(immature.get(sender));
      if (entry.amountUnits + entry.feeUnits > spendable) {
        positions.delete(sender);
        continue;
      }

      balances.set(sender, balance - entry.amountUnits - entry.feeUnits);
      balances.set(tx.recipient, (balances.get(tx.recipient) || 0) + entry.amountUnits);
      nonces.set(sender, tx.nonce);
      selected.push(entry);

      const nextPosition = position + 1;
      const transactions = grouped.get(sender);
      if (nextPosition < transactions.length) {
        positions.set(sender, nextPosition);
        ready.push(transactions[nextPosition]);
      } else {
        positions.delete(sender);
      }
    }
    return selected;
  }

  async function miningTemplate(miner) {
    if (!validMiner(miner)) throw new Error('Miner must be a valid Ed25519 public key.');
    const blocks = await getBlocks();
    const tip = blocks[blocks.length - 1];
    const height = tip.height + 1;
    const accounts = await readAccounts();
    const immature = coinbaseEntriesForHeight(blocks, height, consensus);
    const selected = await selectMiningTransactions(accounts, immature);
    const transactions = selected.map(entry => entry.transaction);
    const totalFees = selected.reduce((total, entry) => total + entry.feeUnits, 0);
    const supply = sumBalances(accounts);
    const subsidy = rewardForHeight(height, supply);
    const reward = subsidy + totalFees;
    if (!Number.isSafeInteger(reward)) throw new Error('Block reward exceeds the safe integer range.');

    // The template advertises the era so the browser worker and any other
    // producer build the exact header the validator will accept. Era 1 keeps
    // its historical shape with no version or networkId field.
    const era = isV2Height(height, consensus)
      ? { version: 2, networkId: NETWORK_ID }
      : {};
    return {
      ...era,
      height,
      timestamp: Math.max(Date.now(), tip.timestamp + 1),
      prevHash: tip.hash,
      difficulty: expectedDifficulty(blocks, height, consensus),
      nonce: 0,
      miner,
      transactions,
      reward: { recipient: miner, amount: formatUnits(reward) },
      message: null
    };
  }

  async function acceptBlock(block) {
    return withWriteLock(() => acceptBlockLocked(block));
  }

  async function acceptBlockLocked(block) {
    const blocks = await getBlocks();
    const tip = blocks[blocks.length - 1];
    const accounts = await readAccounts();
    const height = tip.height + 1;
    const txState = validateBlock(block, blocks.slice(-MEDIAN_TIME_WINDOW), {
      balances: new Map([...accounts].map(([address, account]) => [address, account.balance_units])),
      nonces: new Map([...accounts].map(([address, account]) => [address, account.nonce])),
      supply: sumBalances(accounts),
      coinbase: coinbaseEntriesForHeight(blocks, height, consensus)
    }, consensus);

    const chainWork = (BigInt(tip.chainWork || '0') + workForDifficulty(block.difficulty)).toString();
    // A received V2 block may omit its derived hash; fill it from validation.
    const storedBlock = { ...block, hash: block.hash ?? txState.hash, chainWork };
    // A block mined at a configured checkpoint height must reproduce the
    // compiled anchor exactly. This is checked after the block is fully valid
    // but before any database write.
    const checkpoint = checkpointsByHeight.get(storedBlock.height);
    if (checkpoint) {
      verifyCheckpoint(checkpoint, [...blocks, storedBlock], {
        networkId: NETWORK_ID,
        genesisHash: GENESIS_HASH,
        activationHeight: consensus.v2ActivationHeight
      });
    }
    await withTransaction(transaction => applyBlock(storedBlock, txState.transactions, transaction));
    return { block: storedBlock, height: storedBlock.height, supply: txState.supply, chainWork };
  }

  async function replaceChain(candidate) {
    return withWriteLock(() => replaceChainLocked(candidate));
  }

  async function replaceChainLocked(candidate) {
    const validation = validateChainInternal(candidate, consensus);
    if (!validation.valid) throw new Error(`Peer chain rejected: ${validation.error}`);

    // Rule N-1 / §8.8: checkpoint conflict is fatal and is decided before any
    // cumulative-work comparison. A chain claiming 10^30 work still loses here.
    assertCheckpointsForCandidate(checkpoints, candidate, {
      networkId: NETWORK_ID,
      genesisHash: GENESIS_HASH,
      activationHeight: consensus.v2ActivationHeight
    });

    const local = await getBlocks();
    const oldChainWork = BigInt(local[local.length - 1].chainWork || '0');
    const newChainWork = BigInt(validation.chainWork);

    if (newChainWork <= oldChainWork) {
      return { replaced: false, oldChainWork: oldChainWork.toString(), chainWork: newChainWork.toString() };
    }

    let commonAncestor = 0;
    while (commonAncestor + 1 < local.length && commonAncestor + 1 < candidate.length &&
      local[commonAncestor + 1].hash === candidate[commonAncestor + 1].hash) {
      commonAncestor += 1;
    }

    const reorgDepth = local.length - 1 - commonAncestor;
    if (reorgDepth > MAX_REORG_DEPTH) {
      throw new Error(`Peer chain reorganization exceeds the ${MAX_REORG_DEPTH}-block safety limit.`);
    }

    const candidateTransactions = new Set(candidate.flatMap(block => block.transactions.map(tx => tx.signature)));
    const orphanedTransactions = local.slice(commonAncestor + 1)
      .flatMap(block => block.transactions)
      .filter(tx => !candidateTransactions.has(tx.signature));

    const pendingEntries = await readMempoolEntries();
    const seen = new Set();
    const toRequeue = [...pendingEntries.map(entry => entry.transaction), ...orphanedTransactions]
      .filter(tx => {
        if (!tx || typeof tx.signature !== 'string') return false;
        if (candidateTransactions.has(tx.signature)) return false;
        if (seen.has(tx.signature)) return false;
        seen.add(tx.signature);
        return true;
      })
      .sort((a, b) => a.sender.localeCompare(b.sender) || a.nonce - b.nonce);

    // Requeue against the candidate tip state before the database is touched so
    // an invalid pending transaction cannot abort a valid replacement.
    const simulatedBalances = new Map(validation.balances);
    const simulatedNonces = new Map(validation.nonces);
    const pendingHeight = candidate[candidate.length - 1].height + 1;
    const immature = new Map();
    if (isCoinbaseMaturityActive(pendingHeight, consensus)) {
      for (const [address, entries] of validation.coinbase) {
        const total = coinbaseTotalFor(
          entries.filter(entry => entry.height + consensus.coinbaseMaturity > pendingHeight)
        );
        if (total > 0) immature.set(address, total);
      }
    }
    const requeued = [];
    for (const raw of toRequeue) {
      const result = verifyTransaction(raw);
      if (!result.valid) continue;
      const tx = result.canonicalTransaction;
      if (tx.nonce !== (simulatedNonces.get(tx.sender) || 0) + 1) continue;
      const balance = simulatedBalances.get(tx.sender) || 0;
      const spendable = balance - (immature.get(tx.sender) || 0);
      if (result.amountUnits + result.feeUnits > spendable) continue;
      simulatedBalances.set(tx.sender, balance - result.amountUnits - result.feeUnits);
      simulatedBalances.set(tx.recipient, (simulatedBalances.get(tx.recipient) || 0) + result.amountUnits);
      simulatedNonces.set(tx.sender, tx.nonce);
      requeued.push(tx);
    }

    await withTransaction(async transaction => {
      await transaction.execute("DELETE FROM blocks WHERE height > 0");
      await transaction.execute("DELETE FROM accounts");
      await transaction.execute("DELETE FROM mempool");

      let chainWork = 0n;
      for (const block of candidate) {
        if (block.height === 0) continue;
        chainWork += workForDifficulty(block.difficulty);
        await applyBlock({
          ...block,
          hash: block.hash ?? hashBlock(block),
          chainWork: chainWork.toString()
        }, null, transaction);
      }

      for (const tx of requeued) {
        await transaction.execute({
          sql: "INSERT INTO mempool(sender, nonce, timestamp, json) VALUES (?, ?, ?, ?)",
          args: [tx.sender, tx.nonce, tx.timestamp, JSON.stringify(tx)]
        });
      }
    });

    return {
      replaced: true,
      oldChainWork: oldChainWork.toString(),
      chainWork: newChainWork.toString(),
      commonAncestor,
      requeued: requeued.length
    };
  }

  async function listBlocks({ limit = 50, offset = 0, search = '' } = {}) {
    const query = String(search).trim();
    const pattern = `%${query}%`;
    const where = query ? 'WHERE CAST(height AS TEXT) LIKE ? OR miner LIKE ? OR hash LIKE ?' : '';
    const params = query ? [pattern, pattern, pattern] : [];
    
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM blocks ${where}`,
      args: params
    });
    const total = Number(countResult.rows[0].count);
    
    const rowsResult = await client.execute({
      sql: `SELECT json FROM blocks ${where} ORDER BY height DESC LIMIT ? OFFSET ?`,
      args: [...params, limit, offset]
    });
    
    return { blocks: rowsResult.rows.map(row => JSON.parse(row.json)), total };
  }

  async function getPeers() {
    const result = await client.execute("SELECT url, last_seen AS lastSeen, last_error AS lastError FROM peers ORDER BY url");
    return result.rows.map(row => ({ url: row.url, lastSeen: Number(row.lastSeen), lastError: row.lastError }));
  }

  async function addPeer(url) {
    await client.execute({
      sql: "INSERT INTO peers(url) VALUES (?) ON CONFLICT(url) DO NOTHING",
      args: [url]
    });
  }

  async function updatePeer(url, error = null) {
    await client.execute({
      sql: "UPDATE peers SET last_seen = ?, last_error = ? WHERE url = ?",
      args: [error ? null : Date.now(), error, url]
    });
  }

  async function isPeerBanned(identifier) {
    const result = await client.execute({
      sql: "SELECT score, banned_until AS bannedUntil, reason FROM peer_bans WHERE identifier = ?",
      args: [identifier]
    });
    const ban = result.rows[0];
    if (!ban) return null;
    const now = Date.now();
    if (ban.bannedUntil && Number(ban.bannedUntil) > now && Number(ban.score) >= PEER_BAN_SCORE) {
      return { score: Number(ban.score), bannedUntil: Number(ban.bannedUntil), reason: ban.reason };
    }
    if (ban.bannedUntil && Number(ban.bannedUntil) <= now) {
      await client.execute({
        sql: "UPDATE peer_bans SET score = 0, banned_until = NULL, reason = ?, updated_at = ? WHERE identifier = ?",
        args: ['', now, identifier]
      });
    }
    return null;
  }

  async function recordPeerFault(identifier, reason, points = 1) {
    const now = Date.now();
    const current = await client.execute({
      sql: "SELECT score, banned_until AS bannedUntil FROM peer_bans WHERE identifier = ?",
      args: [identifier]
    });
    const row = current.rows[0];
    const priorScore = row?.bannedUntil && Number(row.bannedUntil) <= now ? 0 : (Number(row?.score) || 0);
    const score = Math.min(PEER_BAN_SCORE, priorScore + points);
    const bannedUntil = score >= PEER_BAN_SCORE
      ? Math.max(now + PEER_BAN_DURATION_MS, Number(row?.bannedUntil) || 0)
      : null;

    await client.execute({
      sql: `INSERT INTO peer_bans(identifier, score, banned_until, reason, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(identifier) DO UPDATE SET score = excluded.score,
            banned_until = excluded.banned_until, reason = excluded.reason, updated_at = excluded.updated_at`,
      args: [identifier, score, bannedUntil, String(reason).slice(0, 256), now]
    });
    return { identifier, score, bannedUntil, reason: String(reason).slice(0, 256) };
  }

  async function networkState(address) {
    const blocks = await getBlocks();
    const tip = blocks[blocks.length - 1];
    const height = tip.height;
    const account = address ? await getAccount(address) : { balance_units: 0, nonce: 0 };
    const supply = await getSupply();
    
    const minedResult = address ? await client.execute({
      sql: "SELECT COUNT(*) AS count FROM blocks WHERE miner = ?",
      args: [address]
    }) : { rows: [{ count: 0 }] };
    
    const pendingResult = await client.execute("SELECT COUNT(*) AS count FROM mempool");

    // State is replayed on every call so a database writer cannot hide a
    // tampered balance behind a cached verdict. The replay is the same
    // deterministic validator used for admission and startup.
    const validation = validateChainInternal(blocks, consensus);
    let accountErrors;
    try {
      const accounts = await readAccounts();
      accountErrors = compareAccounts(accounts, validation);
    } catch (error) {
      accountErrors = [{ code: 'ACCOUNT_STATE_INVALID', message: error.message }];
    }
    const accountsValid = accountErrors.length === 0;
    const checkpoint = checkpointStatus(blocks);
    const healthy = validation.valid && accountsValid &&
      checkpoint.checkpointState !== 'VIOLATED' &&
      checkpoint.checkpointState !== 'UNSUPPORTED_PROTOCOL_VERSION';

    return {
      height,
      supply,
      chainWork: tip.chainWork,
      reward: rewardForHeight(height + 1, supply),
      difficulty: expectedDifficulty(blocks, height + 1, consensus),
      balance: account.balance_units,
      nonce: account.nonce,
      minedBlocks: Number(minedResult.rows[0].count),
      pendingCount: Number(pendingResult.rows[0].count),
      latestBlock: tip,
      accountsValid,
      accountErrors,
      checkpointState: checkpoint.checkpointState,
      checkpointErrors: checkpoint.checkpointErrors,
      checkpoints: checkpoint.checkpoints,
      manifestDigest,
      checkpointSetDigest,
      genesisHash: GENESIS_HASH,
      healthy
    };
  }

  function close() {
    client.close();
  }

  return {
    client,
    acceptBlock,
    acceptTransaction,
    addPeer,
    close,
    getBlockRange,
    getBlocks,
    getChainIdentity,
    getMempool: listMempool,
    getTipHeight,
    getPeers,
    isPeerBanned,
    listBlocks,
    miningTemplate,
    networkState,
    recordPeerFault,
    replaceChain,
    updatePeer,
    validateStoredChain
  };
}
