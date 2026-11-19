// Canonical BNKR serialization, shared by the Node server and the browser
// mining worker.
//
// This module is deliberately isomorphic: it imports no Node built-in and no
// browser-only API. SHA-256 is provided asynchronously through WebCrypto so the
// exact same serializer can be exercised from both runtimes. The server keeps a
// synchronous node:crypto wrapper around `canonicalBlockPreimage` so ordinary
// validation does not become async.
//
// Definition source: BNKR_PROTOCOL_V2_CORRECTION_SPECIFICATION.md sections 3-7.
// Era 1 (the nine-field projection) is frozen byte-for-byte. Era 2 is the closed
// eleven-field header. The era branch is consensus-critical and lives here so a
// browser bundle cannot drift from the server.

export const MAX_BLOCK_PREIMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TX_PER_BLOCK = 10_000;
export const MAX_DIFFICULTY = 6;
export const COIN_UNITS = 100_000_000;
export const MIN_TRANSACTION_UNITS = 1_000_000;
export const MIN_FEE_UNITS = 100_000;
export const BNKR_NETWORK_ID = 'BNKR-MAINNET-V1';
export const MAX_NETWORK_ID_BYTES = 64;

export const V2_HEADER_FIELDS = Object.freeze([
  'version',
  'networkId',
  'height',
  'timestamp',
  'prevHash',
  'difficulty',
  'nonce',
  'miner',
  'transactions',
  'reward',
  'message'
]);

export const V1_HEADER_FIELDS = Object.freeze([
  'height',
  'timestamp',
  'prevHash',
  'difficulty',
  'nonce',
  'miner',
  'transactions',
  'reward',
  'message'
]);

export const T7_FIELDS = Object.freeze([
  'sender',
  'recipient',
  'amount',
  'fee',
  'nonce',
  'timestamp',
  'signature'
]);

export const REWARD_FIELDS = Object.freeze(['recipient', 'amount']);

const NETWORK_ID_PATTERN = /^[A-Z0-9-]{1,64}$/;
const ASCII_NETWORK_CANDIDATE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,7}[1-9])?$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const ERROR_CODES = Object.freeze({
  MISSING_FIELD: 'MISSING_FIELD',
  EXTRA_HEADER_FIELD: 'EXTRA_HEADER_FIELD',
  INVALID_VERSION_TYPE: 'INVALID_VERSION_TYPE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  INVALID_NETWORK_ID: 'INVALID_NETWORK_ID',
  NETWORK_ID_MISMATCH: 'NETWORK_ID_MISMATCH',
  INVALID_HEIGHT: 'INVALID_HEIGHT',
  INVALID_INTEGER: 'INVALID_INTEGER',
  INVALID_NONCE: 'INVALID_NONCE',
  INVALID_DIFFICULTY: 'INVALID_DIFFICULTY',
  INVALID_PREV_HASH: 'INVALID_PREV_HASH',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_TRANSACTIONS: 'INVALID_TRANSACTIONS',
  TOO_MANY_TRANSACTIONS: 'TOO_MANY_TRANSACTIONS',
  INVALID_TRANSACTION: 'INVALID_TRANSACTION',
  EXTRA_TRANSACTION_FIELD: 'EXTRA_TRANSACTION_FIELD',
  INVALID_TRANSACTION_AMOUNT: 'INVALID_TRANSACTION_AMOUNT',
  INVALID_FEE: 'INVALID_FEE',
  NON_CANONICAL_DECIMAL: 'NON_CANONICAL_DECIMAL',
  INVALID_REWARD_TYPE: 'INVALID_REWARD_TYPE',
  EXTRA_REWARD_FIELD: 'EXTRA_REWARD_FIELD',
  NON_NULL_MESSAGE: 'NON_NULL_MESSAGE',
  PREIMAGE_TOO_LARGE: 'PREIMAGE_TOO_LARGE',
  INVALID_BLOCK: 'INVALID_BLOCK',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  TRAILING_DATA: 'TRAILING_DATA',
  JSON_INVALID: 'JSON_INVALID',
  JSON_TOO_DEEP: 'JSON_TOO_DEEP',
  CRYPTO_UNAVAILABLE: 'CRYPTO_UNAVAILABLE'
});

export class CanonicalError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CanonicalError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message) {
  throw new CanonicalError(code, message);
}

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requirePlainObject(value, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  return value;
}

/**
 * Requires an exact key set. A present-but-undefined required field is treated
 * as missing: JSON.stringify would silently omit it, which is the historical
 * hazard this function exists to close.
 */
function requireExactKeys(object, required, {
  allowed = [],
  missingCode = ERROR_CODES.MISSING_FIELD,
  extraCode = ERROR_CODES.EXTRA_HEADER_FIELD,
  label = 'object'
} = {}) {
  const allowedKeys = new Set([...required, ...allowed]);
  for (const key of required) {
    if (!hasOwn(object, key) || object[key] === undefined) {
      fail(missingCode, `Missing required ${label} field "${key}".`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      fail(extraCode, `Unexpected ${label} field "${key}".`);
    }
  }
}

export function isCanonicalDecimal(value) {
  return typeof value === 'string' && CANONICAL_DECIMAL_PATTERN.test(value);
}

function requireCanonicalDecimal(value, code, message) {
  if (!isCanonicalDecimal(value)) fail(code, message);
}

// Canonical decimals can be arbitrarily long in principle. Only compare against
// a fixed minimum, so an adversarial multi-megabyte amount is not converted to
// a multi-megabyte BigInt before the preimage bound is checked.
function decimalUnitsAtLeast(text, minimumUnits) {
  const [whole, fraction = ''] = text.split('.');
  if (whole.length > 15) return true;
  const units = BigInt(whole) * BigInt(COIN_UNITS) +
    BigInt((fraction + '00000000').slice(0, 8));
  return units >= BigInt(minimumUnits);
}

function decodeBase64(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(text)) return null;
  const bytes = [];
  for (let index = 0; index < text.length; index += 4) {
    const c0 = BASE64_ALPHABET.indexOf(text[index]);
    const c1 = BASE64_ALPHABET.indexOf(text[index + 1]);
    const c2 = text[index + 2] === '=' ? -1 : BASE64_ALPHABET.indexOf(text[index + 2]);
    const c3 = text[index + 3] === '=' ? -1 : BASE64_ALPHABET.indexOf(text[index + 3]);
    if (c0 < 0 || c1 < 0 || (text[index + 2] !== '=' && c2 < 0) || (text[index + 3] !== '=' && c3 < 0)) {
      return null;
    }
    const packed = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    bytes.push((packed >> 16) & 0xff);
    if (c2 >= 0) bytes.push((packed >> 8) & 0xff);
    if (c3 >= 0) bytes.push(packed & 0xff);
  }
  return Uint8Array.from(bytes);
}

function encodeBase64(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const packed = (b0 << 16) | (b1 << 8) | b2;
    output += BASE64_ALPHABET[(packed >> 18) & 0x3f];
    output += BASE64_ALPHABET[(packed >> 12) & 0x3f];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(packed >> 6) & 0x3f] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[packed & 0x3f] : '=';
  }
  return output;
}

export function isCanonicalBase64(value, expectedBytes) {
  if (typeof value !== 'string') return false;
  const bytes = decodeBase64(value);
  return bytes !== null && bytes.length === expectedBytes && encodeBase64(bytes) === value;
}

function requireCanonicalBase64(value, expectedBytes, code, message) {
  if (!isCanonicalBase64(value, expectedBytes)) fail(code, message);
}

export function canonicalDecimalFromUnits(units) {
  if (!Number.isSafeInteger(units) || units < 0) {
    fail(ERROR_CODES.NON_CANONICAL_DECIMAL, 'Atomic amount is outside the safe integer range.');
  }
  const whole = Math.floor(units / COIN_UNITS);
  const fraction = String(units % COIN_UNITS).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function quote(value) {
  // Every allowed V2 alphabet excludes ", \\, and control characters, so the
  // no-escaping theorem means the canonical form is a byte copy.
  return `"${value}"`;
}

function encodeInteger(value) {
  return String(value);
}

/**
 * Frozen Era 1 projection. It intentionally never validates and never
 * normalizes: historical hashes are defined by these exact bytes.
 */
export function projectV1Header(block) {
  return {
    height: block.height,
    timestamp: block.timestamp,
    prevHash: block.prevHash,
    difficulty: block.difficulty,
    nonce: block.nonce,
    miner: block.miner,
    transactions: block.transactions,
    reward: block.reward,
    message: block.message
  };
}

export function serializeV1Header(block) {
  return JSON.stringify(projectV1Header(block));
}

export function projectV2Header(block) {
  return {
    version: block.version,
    networkId: block.networkId,
    height: block.height,
    timestamp: block.timestamp,
    prevHash: block.prevHash,
    difficulty: block.difficulty,
    nonce: block.nonce,
    miner: block.miner,
    transactions: block.transactions,
    reward: block.reward,
    message: block.message
  };
}

function validateV2Version(version) {
  if (!isSafeInteger(version)) {
    fail(ERROR_CODES.INVALID_VERSION_TYPE, 'Block version must be the safe integer 2.');
  }
  if (version !== 2) {
    fail(ERROR_CODES.UNSUPPORTED_VERSION, `Unsupported block version ${version}.`);
  }
}

/**
 * Closed seven-field transaction projection `T7` (spec section 4.4).
 */
export function canonicalT7(transaction) {
  requirePlainObject(transaction, ERROR_CODES.INVALID_TRANSACTION, 'Transaction must be an object.');
  requireExactKeys(transaction, T7_FIELDS, {
    extraCode: ERROR_CODES.EXTRA_TRANSACTION_FIELD,
    label: 'transaction'
  });

  requireCanonicalBase64(transaction.sender, 32, ERROR_CODES.INVALID_KEY,
    'Transaction sender must be a canonical 32-byte Ed25519 public key.');
  requireCanonicalBase64(transaction.recipient, 32, ERROR_CODES.INVALID_KEY,
    'Transaction recipient must be a canonical 32-byte Ed25519 public key.');
  if (transaction.sender === transaction.recipient) {
    fail(ERROR_CODES.INVALID_TRANSACTION, 'Transaction sender and recipient must differ.');
  }

  if (typeof transaction.amount !== 'string') {
    fail(ERROR_CODES.INVALID_TRANSACTION_AMOUNT, 'Transaction amount must be a canonical decimal string.');
  }
  requireCanonicalDecimal(transaction.amount, ERROR_CODES.NON_CANONICAL_DECIMAL,
    'Transaction amount is not a canonical decimal.');
  if (!decimalUnitsAtLeast(transaction.amount, MIN_TRANSACTION_UNITS)) {
    fail(ERROR_CODES.INVALID_TRANSACTION_AMOUNT, 'Transaction amount must be at least 0.01 BNKR.');
  }

  if (typeof transaction.fee !== 'string') {
    fail(ERROR_CODES.INVALID_FEE, 'Transaction fee must be a canonical decimal string.');
  }
  requireCanonicalDecimal(transaction.fee, ERROR_CODES.NON_CANONICAL_DECIMAL,
    'Transaction fee is not a canonical decimal.');
  if (!decimalUnitsAtLeast(transaction.fee, MIN_FEE_UNITS)) {
    fail(ERROR_CODES.INVALID_FEE, 'Transaction fee must be at least 0.001 BNKR.');
  }

  if (!isSafeInteger(transaction.nonce) || transaction.nonce < 1) {
    fail(ERROR_CODES.INVALID_NONCE, 'Transaction nonce must be a positive safe integer.');
  }
  if (!isSafeInteger(transaction.timestamp) || transaction.timestamp <= 0) {
    fail(ERROR_CODES.INVALID_INTEGER, 'Transaction timestamp must be a positive safe integer.');
  }
  requireCanonicalBase64(transaction.signature, 64, ERROR_CODES.INVALID_SIGNATURE,
    'Transaction signature must be a canonical 64-byte Ed25519 signature.');

  return `{"sender":${quote(transaction.sender)}` +
    `,"recipient":${quote(transaction.recipient)}` +
    `,"amount":${quote(transaction.amount)}` +
    `,"fee":${quote(transaction.fee)}` +
    `,"nonce":${encodeInteger(transaction.nonce)}` +
    `,"timestamp":${encodeInteger(transaction.timestamp)}` +
    `,"signature":${quote(transaction.signature)}}`;
}

/**
 * Closed two-field reward projection `R2` (spec section 4.5).
 */
export function canonicalReward(reward) {
  requirePlainObject(reward, ERROR_CODES.INVALID_REWARD_TYPE, 'Block reward must be an object.');
  requireExactKeys(reward, REWARD_FIELDS, {
    extraCode: ERROR_CODES.EXTRA_REWARD_FIELD,
    label: 'reward'
  });
  requireCanonicalBase64(reward.recipient, 32, ERROR_CODES.INVALID_KEY,
    'Reward recipient must be a canonical 32-byte Ed25519 public key.');
  if (typeof reward.amount !== 'string') {
    fail(ERROR_CODES.INVALID_REWARD_TYPE, 'Reward amount must be a canonical decimal string.');
  }
  requireCanonicalDecimal(reward.amount, ERROR_CODES.NON_CANONICAL_DECIMAL,
    'Reward amount is not a canonical decimal.');
  return `{"recipient":${quote(reward.recipient)},"amount":${quote(reward.amount)}}`;
}

/**
 * Total V2 header serializer. There is no coercion, no default, and no reliance
 * on JSON.stringify property omission.
 */
export function serializeV2Header(header, {
  allowDerived = false,
  expectedNetworkId = null
} = {}) {
  requirePlainObject(header, ERROR_CODES.INVALID_BLOCK, 'Block header must be a plain object.');
  requireExactKeys(header, V2_HEADER_FIELDS, {
    allowed: allowDerived ? ['hash', 'chainWork'] : [],
    label: 'header'
  });

  validateV2Version(header.version);

  if (typeof header.networkId !== 'string' || !ASCII_NETWORK_CANDIDATE_PATTERN.test(header.networkId)) {
    fail(ERROR_CODES.INVALID_NETWORK_ID,
      'Block networkId must be ASCII matching ^[A-Z0-9-]{1,64}$.');
  }
  // A different-but-well-formed network identity is a network mismatch, not a
  // malformed field. Lowercase case-variants therefore report the mismatch when
  // an expected identity is supplied, while trailing spaces, zero-width joiners,
  // and homoglyphs remain structurally invalid.
  if (expectedNetworkId !== null && expectedNetworkId !== undefined &&
    header.networkId !== expectedNetworkId) {
    fail(ERROR_CODES.NETWORK_ID_MISMATCH,
      `Block networkId ${header.networkId} does not match ${expectedNetworkId}.`);
  }
  if (!NETWORK_ID_PATTERN.test(header.networkId)) {
    fail(ERROR_CODES.INVALID_NETWORK_ID,
      'Block networkId must be ASCII matching ^[A-Z0-9-]{1,64}$.');
  }

  if (!isSafeInteger(header.height) || header.height < 1) {
    fail(ERROR_CODES.INVALID_HEIGHT, 'Block height must be a safe integer of at least 1.');
  }
  if (!isSafeInteger(header.timestamp)) {
    fail(ERROR_CODES.INVALID_INTEGER, 'Block timestamp must be a safe integer.');
  }
  if (typeof header.prevHash !== 'string' || !HEX64_PATTERN.test(header.prevHash)) {
    fail(ERROR_CODES.INVALID_PREV_HASH, 'Block prevHash must be 64 lowercase hexadecimal characters.');
  }
  if (!isSafeInteger(header.difficulty) || header.difficulty < 1 || header.difficulty > MAX_DIFFICULTY) {
    fail(ERROR_CODES.INVALID_DIFFICULTY,
      `Block difficulty must be a safe integer between 1 and ${MAX_DIFFICULTY}.`);
  }
  if (!isSafeInteger(header.nonce) || header.nonce < 0) {
    fail(ERROR_CODES.INVALID_NONCE, 'Block nonce must be a non-negative safe integer.');
  }
  requireCanonicalBase64(header.miner, 32, ERROR_CODES.INVALID_KEY,
    'Block miner must be a canonical 32-byte Ed25519 public key.');
  if (!Array.isArray(header.transactions)) {
    fail(ERROR_CODES.INVALID_TRANSACTIONS, 'Block transactions must be an array.');
  }
  if (header.transactions.length > MAX_TX_PER_BLOCK) {
    fail(ERROR_CODES.TOO_MANY_TRANSACTIONS,
      `Block transactions exceed the ${MAX_TX_PER_BLOCK}-transaction limit.`);
  }
  const transactions = header.transactions.map(canonicalT7);
  const reward = canonicalReward(header.reward);
  if (header.message !== null) {
    fail(ERROR_CODES.NON_NULL_MESSAGE, 'A V2 block message must be null.');
  }

  const preimage = `{"version":2` +
    `,"networkId":${quote(header.networkId)}` +
    `,"height":${encodeInteger(header.height)}` +
    `,"timestamp":${encodeInteger(header.timestamp)}` +
    `,"prevHash":${quote(header.prevHash)}` +
    `,"difficulty":${encodeInteger(header.difficulty)}` +
    `,"nonce":${encodeInteger(header.nonce)}` +
    `,"miner":${quote(header.miner)}` +
    `,"transactions":[${transactions.join(',')}]` +
    `,"reward":${reward}` +
    ',"message":null}';

  // Every V2 string alphabet is ASCII, so the UTF-8 byte length equals the
  // JavaScript string length. The assertion keeps that invariant explicit.
  const bytes = preimage.length;
  if (bytes > MAX_BLOCK_PREIMAGE_BYTES) {
    fail(ERROR_CODES.PREIMAGE_TOO_LARGE,
      `Block preimage exceeds the ${MAX_BLOCK_PREIMAGE_BYTES}-byte limit.`);
  }
  return preimage;
}

/**
 * Admission-side closed-schema check for a received or persisted V2 block.
 * Hashing uses the eleven-field projection; admission rejects every other key
 * except the two derived fields when they are explicitly allowed.
 */
export function assertV2BlockShape(block, {
  allowDerived = false,
  requireDerived = false,
  expectedNetworkId = null
} = {}) {
  requirePlainObject(block, ERROR_CODES.INVALID_BLOCK, 'Block must be a plain object.');
  requireExactKeys(block, V2_HEADER_FIELDS, {
    allowed: allowDerived ? ['hash', 'chainWork'] : [],
    label: 'header'
  });
  if (requireDerived) {
    if (!hasOwn(block, 'hash') || block.hash === undefined) {
      fail(ERROR_CODES.MISSING_FIELD, 'Missing required persisted field "hash".');
    }
    if (!hasOwn(block, 'chainWork') || block.chainWork === undefined) {
      fail(ERROR_CODES.MISSING_FIELD, 'Missing required persisted field "chainWork".');
    }
  }
  return serializeV2Header(projectV2Header(block), { expectedNetworkId });
}

/**
 * Era 1 admission is intentionally permissive about storage metadata. The
 * historical projection ignores it, and §6.5 forbids rejecting history for
 * carrying fields that never entered the hash.
 */
export function assertEra1BlockShape(block) {
  requirePlainObject(block, ERROR_CODES.INVALID_BLOCK, 'Block must be a plain object.');
  if (block.version === undefined) return;
  if (!isSafeInteger(block.version)) {
    fail(ERROR_CODES.INVALID_VERSION_TYPE, 'Era 1 block version must be absent or the safe integer 1.');
  }
  if (block.version !== 1) {
    fail(ERROR_CODES.UNSUPPORTED_VERSION,
      `Block version ${block.version} is not valid before the V2 activation height.`);
  }
}

/**
 * Era selection and preimage construction. This is the single function the
 * server hashes and the browser worker uses. Era 1 stored bytes are never
 * re-serialized through the V2 path.
 */
export function canonicalBlockPreimage(block, { expectedNetworkId = null } = {}) {
  requirePlainObject(block, ERROR_CODES.INVALID_BLOCK, 'Block must be a plain object.');
  const version = block.version;
  if (version === undefined) return serializeV1Header(block);
  if (!isSafeInteger(version)) {
    fail(ERROR_CODES.INVALID_VERSION_TYPE, 'Block version must be an absent value, 1, or 2.');
  }
  if (version === 1) return serializeV1Header(block);
  if (version === 2) {
    return serializeV2Header(projectV2Header(block), { expectedNetworkId });
  }
  fail(ERROR_CODES.UNSUPPORTED_VERSION, `Unsupported block version ${version}.`);
}

function bytesToHex(bytes) {
  let output = '';
  for (const value of bytes) output += value.toString(16).padStart(2, '0');
  return output;
}

/**
 * WebCrypto SHA-256 over the exact UTF-8 bytes. Available in browsers, workers,
 * and modern Node, so vector and parity tests share one digest implementation.
 */
export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    fail(ERROR_CODES.CRYPTO_UNAVAILABLE, 'WebCrypto SHA-256 is unavailable in this runtime.');
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function canonicalBlockHash(block, options = {}) {
  return sha256Hex(canonicalBlockPreimage(block, options));
}

export async function transactionId(transaction) {
  return sha256Hex(canonicalT7(transaction));
}

// ===========================================================================
// Strict JSON parsing: duplicate keys and trailing data are fatal
// ===========================================================================

export class JsonStructureError extends Error {
  constructor(message, code = ERROR_CODES.JSON_INVALID) {
    super(message);
    this.name = 'JsonStructureError';
    this.code = code;
  }
}

function isDigit(character) {
  return character >= '0' && character <= '9';
}

/**
 * Single-pass structural scan that rejects duplicate object keys, depth
 * overflow, malformed JSON, and trailing data without building a value.
 *
 * The code names are configurable so the HTTP transport can keep its historical
 * `DUPLICATE_JSON_KEY` / `JSON_INVALID` codes while the canonical V2 vector
 * runner reports `DUPLICATE_KEY` / `TRAILING_DATA`.
 */
export function assertNoDuplicateJsonKeys(text, {
  maxDepth = 64,
  duplicateCode = 'DUPLICATE_JSON_KEY',
  trailingCode = ERROR_CODES.JSON_INVALID,
  invalidCode = ERROR_CODES.JSON_INVALID
} = {}) {
  if (typeof text !== 'string') {
    throw new JsonStructureError('JSON payload must be text.', invalidCode);
  }

  let index = 0;
  const length = text.length;

  const failScan = (message, code = invalidCode) => {
    throw new JsonStructureError(message, code);
  };

  const skipWhitespace = () => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  };

  const scanString = () => {
    if (text[index] !== '"') failScan('JSON strings must be quoted.');
    const start = index;
    index += 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return text.slice(start, index);
      }
      if (code === 0x5c) {
        index += 2;
        continue;
      }
      if (code < 0x20) failScan('JSON strings must not contain raw control characters.');
      index += 1;
    }
    return failScan('Unterminated JSON string.');
  };

  let scanValue;

  const scanObject = (depth) => {
    index += 1; // '{'
    const keys = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') failScan('JSON object keys must be strings.');
      const rawKey = scanString();
      let key;
      try {
        key = JSON.parse(rawKey);
      } catch {
        return failScan('JSON object key is not a valid string.', invalidCode);
      }
      if (keys.has(key)) {
        failScan(`Duplicate JSON object key "${key}".`, duplicateCode);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') failScan('JSON object key must be followed by a colon.');
      index += 1;
      scanValue(depth + 1);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return;
      }
      failScan('JSON object members must be separated by commas.');
    }
  };

  const scanArray = (depth) => {
    index += 1; // '['
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    for (;;) {
      scanValue(depth + 1);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return;
      }
      failScan('JSON array elements must be separated by commas.');
    }
  };

  scanValue = (depth) => {
    if (depth > maxDepth) failScan(`JSON nesting exceeds ${maxDepth} levels.`, ERROR_CODES.JSON_TOO_DEEP);
    skipWhitespace();
    const character = text[index];
    if (character === '{') return scanObject(depth);
    if (character === '[') return scanArray(depth);
    if (character === '"') {
      scanString();
      return;
    }
    if (character === 't' || character === 'f' || character === 'n') {
      const literal = character === 't' ? 'true' : character === 'f' ? 'false' : 'null';
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
      return failScan('Invalid JSON literal.');
    }
    if (character === '-' || isDigit(character)) {
      if (text[index] === '-') index += 1;
      if (text[index] === '0') {
        index += 1;
      } else if (isDigit(text[index]) && text[index] !== '0') {
        while (isDigit(text[index])) index += 1;
      } else {
        return failScan('Invalid JSON number.');
      }
      if (text[index] === '.') {
        index += 1;
        if (!isDigit(text[index])) return failScan('Invalid JSON number.');
        while (isDigit(text[index])) index += 1;
      }
      if (text[index] === 'e' || text[index] === 'E') {
        index += 1;
        if (text[index] === '+' || text[index] === '-') index += 1;
        if (!isDigit(text[index])) return failScan('Invalid JSON number.');
        while (isDigit(text[index])) index += 1;
      }
      return;
    }
    failScan('Unexpected token in JSON.');
  };

  skipWhitespace();
  if (index >= length) failScan('JSON body is empty.');
  scanValue(0);
  skipWhitespace();
  if (index !== length) failScan('Unexpected trailing data after the JSON value.', trailingCode);
}

/**
 * Parser boundary for a V2 block/header payload.
 */
export function parseCanonicalJson(text, { maxDepth = 64 } = {}) {
  try {
    assertNoDuplicateJsonKeys(text, {
      maxDepth,
      duplicateCode: ERROR_CODES.DUPLICATE_KEY,
      trailingCode: ERROR_CODES.TRAILING_DATA,
      invalidCode: ERROR_CODES.JSON_INVALID
    });
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof JsonStructureError) throw error;
    throw new CanonicalError(ERROR_CODES.JSON_INVALID, 'JSON payload is not valid JSON.');
  }
}
