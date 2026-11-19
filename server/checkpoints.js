// Checkpoint verification and continuity (correction spec §8–§9, C-03/C-04).
//
// A checkpoint is a compiled fact about a chain, not a trust input from the
// database. Nothing in this module reads a stored `block.hash` as evidence:
// every digest is recomputed from the canonical preimage under the era that
// the height requires. A forged `hash` column therefore cannot ratify a
// forged preimage (TE-63).
//
// The active set is empty by default. Q-2 (heights and hashes) is unresolved,
// so no checkpoint may be selected here or by default configuration.

import { createHash } from 'node:crypto';
import {
  BNKR_NETWORK_ID,
  MAX_DIFFICULTY,
  assertEra1BlockShape,
  assertV2BlockShape,
  canonicalBlockPreimage
} from '../shared/canonical.js';

export const CHECKPOINT_MANIFEST_VERSION = 1;
export const DEFAULT_CHECKPOINT_BURIAL = 100;
export const DEFAULT_PUBLICATION_WINDOW_DAYS = 14;
export const CHECKPOINT_ENV = 'BANNEKER_CHECKPOINTS';
export const CHECKPOINT_BURIAL_ENV = 'BANNEKER_CHECKPOINT_BURIAL';

export const CHECKPOINT_SET_STATES = Object.freeze([
  'UNCONFIGURED',
  'NOT_YET_APPLICABLE',
  'APPLICABLE',
  'VIOLATED',
  'UNSUPPORTED_PROTOCOL_VERSION'
]);

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ENTRY_FIELDS = new Set([
  'networkId',
  'protocolVersion',
  'height',
  'blockHash',
  'chainWork',
  'genesisHash'
]);
const MANIFEST_FIELDS = new Set([
  'version',
  'networkId',
  'genesisHash',
  'sequence',
  'previousManifestDigest',
  'publishedAt',
  'checkpoints'
]);

export class CheckpointError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CheckpointError';
    // Conflict and violation errors are fatal for startup/admission, not
    // client mistakes. A peer seeing this must stop, not retry.
    this.statusCode = details.statusCode ?? 409;
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CheckpointError(code, message, details);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isHex64(value) {
  return typeof value === 'string' && HEX64.test(value);
}

export function isCanonicalDecimal(value) {
  return typeof value === 'string' && DECIMAL.test(value);
}

export function workForDifficulty(difficulty) {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > MAX_DIFFICULTY) {
    fail('CHECKPOINT_INVALID', `Difficulty ${difficulty} is outside the supported range.`, {
      statusCode: 400
    });
  }
  return 16n ** BigInt(difficulty);
}

function assertSafeHeight(value, label = 'Checkpoint height') {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('CHECKPOINT_INVALID', `${label} must be a positive safe integer.`, { statusCode: 400 });
  }
}

function requireExactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CHECKPOINT_INVALID', `${label} must be an object.`, { statusCode: 400 });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('CHECKPOINT_INVALID', `${label} has unsupported field "${key}".`, {
        statusCode: 400,
        field: key
      });
    }
  }
}

/**
 * Returns the era a block at `height` must use. Activation is unscheduled by
 * default, so every height is Era 1 until an operator selects H.
 */
export function eraOfHeight(height, activationHeight = null) {
  return activationHeight !== null && activationHeight !== undefined && height >= activationHeight ? 2 : 1;
}

function assertBlockEra(block, height, { activationHeight, networkId }) {
  const era = eraOfHeight(height, activationHeight);
  if (era === 2) {
    if (block?.version !== 2) {
      fail('ERA_MISMATCH', `Block ${height} must use version 2 at or above activation height ${activationHeight}.`, {
        statusCode: 400,
        height,
        expected: 2,
        actual: block?.version
      });
    }
    assertV2BlockShape(block, { allowDerived: true, expectedNetworkId: networkId });
  } else {
    if (block?.version !== undefined && block.version !== 1) {
      fail('ERA_MISMATCH', `Block ${height} must not use version ${block.version} below activation height.`, {
        statusCode: 400,
        height,
        expected: 1,
        actual: block.version
      });
    }
    assertEra1BlockShape(block);
  }
  return era;
}

function canonicalHashOf(block, height, options) {
  assertBlockEra(block, height, options);
  return sha256Hex(canonicalBlockPreimage(block));
}

function indexByHeight(blocks, { requireContiguous = true } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    fail('CHECKPOINT_ANCESTRY_MISSING', 'Checkpoint verification requires a non-empty block history.');
  }
  const byHeight = new Map();
  for (const block of blocks) {
    if (!block || !Number.isSafeInteger(block.height)) {
      fail('CHECKPOINT_ANCESTRY_MISSING', 'Block history contains a block without a safe height.');
    }
    if (byHeight.has(block.height)) {
      fail('CHECKPOINT_ANCESTRY_MISSING', `Block history contains duplicate height ${block.height}.`);
    }
    byHeight.set(block.height, block);
  }
  if (requireContiguous) {
    const heights = [...byHeight.keys()].sort((a, b) => a - b);
    if (heights[0] !== 0) {
      fail('CHECKPOINT_ANCESTRY_MISSING', 'Block history does not start at genesis.');
    }
    for (let index = 1; index < heights.length; index += 1) {
      if (heights[index] !== heights[index - 1] + 1) {
        fail('CHECKPOINT_ANCESTRY_MISSING', `Block history has a gap between heights ${heights[index - 1]} and ${heights[index]}.`);
      }
    }
  }
  return byHeight;
}

/**
 * §8.4 full-ancestry walk. Every hash, every `prevHash` link, every PoW target,
 * and every cumulative work value is recomputed from canonical bytes.
 */
export function verifyAncestry(blocks, topHeight, {
  genesisHash,
  networkId = BNKR_NETWORK_ID,
  activationHeight = null,
  requireChainWork = true
} = {}) {
  if (!isHex64(genesisHash)) {
    fail('CHECKPOINT_INVALID', 'A genesis hash is required to verify ancestry.', { statusCode: 400 });
  }
  if (!Number.isSafeInteger(topHeight) || topHeight < 1) {
    fail('CHECKPOINT_INVALID', 'Ancestry top height must be a positive safe integer.');
  }

  const byHeight = indexByHeight(blocks);
  const top = byHeight.get(topHeight);
  if (!top) {
    fail('CHECKPOINT_ANCESTRY_MISSING', `Block history is missing height ${topHeight}.`, { height: topHeight });
  }

  const options = { activationHeight, networkId };
  const genesis = byHeight.get(0);
  const genesisComputed = canonicalHashOf(genesis, 0, options);
  if (genesisComputed !== genesisHash) {
    fail('GENESIS_MISMATCH', 'Recomputed genesis hash does not match the network genesis.', {
      expected: genesisHash,
      actual: genesisComputed
    });
  }

  let parentHash = genesisComputed;
  let cumulative = 0n;
  for (let height = 1; height <= topHeight; height += 1) {
    const block = byHeight.get(height);
    if (!block) {
      fail('CHECKPOINT_ANCESTRY_MISSING', `Block history is missing ancestor height ${height}.`, { height });
    }
    const computed = canonicalHashOf(block, height, options);
    if (!computed.startsWith('0'.repeat(block.difficulty))) {
      fail('POW_INVALID', `Block ${height} does not meet its proof-of-work target.`, { height });
    }
    if (block.prevHash !== parentHash) {
      fail('ANCESTRY_LINK_BROKEN', `Block ${height} does not link to the recomputed parent hash.`, {
        height,
        expected: parentHash,
        actual: block.prevHash
      });
    }
    cumulative += workForDifficulty(block.difficulty);
    if (block.chainWork !== undefined && String(block.chainWork) !== cumulative.toString()) {
      fail('CHAINWORK_MISMATCH', `Block ${height} chainWork does not match recomputed cumulative work.`, {
        height,
        expected: cumulative.toString(),
        actual: block.chainWork
      });
    }
    if (requireChainWork && block.chainWork === undefined) {
      fail('CHAINWORK_MISMATCH', `Block ${height} is missing its cumulative chainWork.`, {
        height,
        expected: cumulative.toString()
      });
    }
    parentHash = computed;
  }

  return { verified: true, topHeight, topHash: parentHash, chainWork: cumulative.toString() };
}

function findBlock(byHeight, height) {
  const block = byHeight.get(height);
  if (!block) {
    fail('CHECKPOINT_BLOCK_MISSING', `Checkpoint block at height ${height} is missing.`, { height });
  }
  return block;
}

/**
 * §8.3 normative verification. The computed hash — never `block.hash` — is the
 * value compared with the compiled constant.
 */
export function verifyCheckpoint(checkpoint, blocks, {
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  activationHeight = null
} = {}) {
  requireExactFields(checkpoint, ENTRY_FIELDS, 'Checkpoint');
  if (checkpoint.networkId !== networkId) {
    fail('NETWORK_ID_MISMATCH', `Checkpoint networkId ${checkpoint.networkId} does not match ${networkId}.`, {
      expected: networkId,
      actual: checkpoint.networkId
    });
  }
  if (!isHex64(genesisHash)) {
    fail('CHECKPOINT_INVALID', 'A genesis hash is required to verify a checkpoint.', { statusCode: 400 });
  }
  if (checkpoint.genesisHash !== genesisHash) {
    fail('GENESIS_MISMATCH', 'Checkpoint genesisHash does not match the network genesis.', {
      expected: genesisHash,
      actual: checkpoint.genesisHash
    });
  }
  assertSafeHeight(checkpoint.height);
  if (![1, 2].includes(checkpoint.protocolVersion)) {
    fail('UNSUPPORTED_PROTOCOL_VERSION', `Checkpoint protocolVersion ${checkpoint.protocolVersion} is not supported.`, {
      statusCode: 400
    });
  }
  if (!isHex64(checkpoint.blockHash)) {
    fail('CHECKPOINT_INVALID', 'Checkpoint blockHash must be 64 lowercase hex characters.', { statusCode: 400 });
  }
  if (!isCanonicalDecimal(checkpoint.chainWork)) {
    fail('CHECKPOINT_INVALID', 'Checkpoint chainWork must be a canonical decimal string.', { statusCode: 400 });
  }

  const expectedEra = eraOfHeight(checkpoint.height, activationHeight);
  if (checkpoint.protocolVersion !== expectedEra) {
    fail('ERA_MISMATCH', `Checkpoint protocolVersion ${checkpoint.protocolVersion} does not match era ${expectedEra}.`, {
      height: checkpoint.height,
      expected: expectedEra,
      actual: checkpoint.protocolVersion
    });
  }

  const byHeight = indexByHeight(blocks);
  const block = findBlock(byHeight, checkpoint.height);
  if (block.height !== checkpoint.height) {
    fail('HEIGHT_MISMATCH', 'Checkpoint block height does not match the tuple.', {
      expected: checkpoint.height,
      actual: block.height
    });
  }

  const options = { activationHeight, networkId };
  const computed = canonicalHashOf(block, checkpoint.height, options);
  if (computed !== checkpoint.blockHash) {
    fail('CHECKPOINT_HASH_MISMATCH', 'Recomputed checkpoint hash does not match the compiled constant.', {
      height: checkpoint.height,
      expected: checkpoint.blockHash,
      actual: computed
    });
  }
  if (!computed.startsWith('0'.repeat(block.difficulty))) {
    fail('POW_INVALID', `Checkpoint block ${checkpoint.height} does not meet its proof-of-work target.`, {
      height: checkpoint.height
    });
  }

  if (checkpoint.height >= 1) {
    const parent = findBlock(byHeight, checkpoint.height - 1);
    const parentHash = canonicalHashOf(parent, checkpoint.height - 1, options);
    if (block.prevHash !== parentHash) {
      fail('PREV_HASH_INVALID', `Checkpoint block ${checkpoint.height} does not link to its predecessor.`, {
        height: checkpoint.height,
        expected: parentHash,
        actual: block.prevHash
      });
    }
  }

  const ancestry = verifyAncestry(blocks, checkpoint.height, {
    genesisHash,
    networkId,
    activationHeight
  });
  if (ancestry.chainWork !== checkpoint.chainWork) {
    fail('CHAINWORK_MISMATCH', `Checkpoint chainWork does not match recomputed work through height ${checkpoint.height}.`, {
      height: checkpoint.height,
      expected: checkpoint.chainWork,
      actual: ancestry.chainWork
    });
  }

  return {
    verified: true,
    height: checkpoint.height,
    blockHash: computed,
    chainWork: ancestry.chainWork,
    protocolVersion: checkpoint.protocolVersion
  };
}

/**
 * §8.5 total state function for one checkpoint.
 */
export function checkpointState(checkpoint, blocks, options = {}) {
  const tipHeight = Array.isArray(blocks) && blocks.length
    ? blocks.reduce((tip, block) => Number.isSafeInteger(block?.height) && block.height > tip ? block.height : tip, 0)
    : 0;
  if (tipHeight < checkpoint.height) return 'NOT_YET_APPLICABLE';
  try {
    verifyCheckpoint(checkpoint, blocks, options);
    return 'APPLICABLE';
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_PROTOCOL_VERSION') return 'UNSUPPORTED_PROTOCOL_VERSION';
    return 'VIOLATED';
  }
}

// ---------------------------------------------------------------------------
// Manifest normalization and continuity (K-1 … K-12)
// ---------------------------------------------------------------------------

function normalizeCheckpointEntry(entry, { networkId, genesisHash, index }) {
  requireExactFields(entry, ENTRY_FIELDS, `Checkpoint ${index}`);
  const entryNetworkId = entry.networkId ?? networkId;
  const entryGenesisHash = entry.genesisHash ?? genesisHash;
  if (entryNetworkId !== networkId) {
    fail('NETWORK_ID_MISMATCH', `Checkpoint ${index} networkId does not match the manifest network.`, {
      expected: networkId,
      actual: entryNetworkId
    });
  }
  if (entryGenesisHash !== genesisHash) {
    fail('GENESIS_MISMATCH', `Checkpoint ${index} genesisHash does not match the manifest genesis.`, {
      expected: genesisHash,
      actual: entryGenesisHash
    });
  }
  assertSafeHeight(entry.height);
  if (![1, 2].includes(entry.protocolVersion)) {
    fail('UNSUPPORTED_PROTOCOL_VERSION', `Checkpoint ${index} has an unsupported protocolVersion.`, {
      statusCode: 400,
      actual: entry.protocolVersion
    });
  }
  if (!isHex64(entry.blockHash)) {
    fail('CHECKPOINT_INVALID', `Checkpoint ${index} blockHash must be 64 lowercase hex characters.`, {
      statusCode: 400
    });
  }
  if (!isCanonicalDecimal(entry.chainWork)) {
    fail('CHECKPOINT_INVALID', `Checkpoint ${index} chainWork must be a canonical decimal string.`, {
      statusCode: 400
    });
  }
  return {
    networkId: entryNetworkId,
    protocolVersion: entry.protocolVersion,
    height: entry.height,
    blockHash: entry.blockHash,
    chainWork: entry.chainWork,
    genesisHash: entryGenesisHash
  };
}

function normalizePublishedAt(value) {
  if (value === undefined || value === null) return null;
  const millis = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Date.parse(value));
  if (!Number.isSafeInteger(millis) || millis < 0) {
    fail('CHECKPOINT_INVALID', 'Manifest publishedAt must be an ISO timestamp or millisecond integer.', {
      statusCode: 400
    });
  }
  return millis;
}

export function emptyCheckpointManifest({ networkId = BNKR_NETWORK_ID, genesisHash } = {}) {
  if (!isHex64(genesisHash)) {
    fail('CHECKPOINT_INVALID', 'A genesis hash is required to describe a checkpoint set.', { statusCode: 400 });
  }
  return {
    version: CHECKPOINT_MANIFEST_VERSION,
    networkId,
    genesisHash,
    sequence: 0,
    previousManifestDigest: null,
    publishedAt: null,
    checkpoints: []
  };
}

/**
 * Accepts a manifest object, a bare tuple array, or empty/unset configuration.
 */
export function normalizeCheckpointManifest(value, {
  networkId = BNKR_NETWORK_ID,
  genesisHash
} = {}) {
  if (!isHex64(genesisHash)) {
    fail('CHECKPOINT_INVALID', 'A genesis hash is required to normalize a checkpoint set.', { statusCode: 400 });
  }
  if (value === undefined || value === null || value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.checkpoints) && value.checkpoints.length === 0)) {
    return emptyCheckpointManifest({ networkId, genesisHash });
  }

  let manifest = value;
  if (typeof manifest === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(manifest);
    } catch (error) {
      fail('CHECKPOINT_INVALID', `Checkpoint configuration is not valid JSON: ${error.message}`, {
        statusCode: 400
      });
    }
    manifest = parsed;
  }
  if (Array.isArray(manifest)) {
    manifest = {
      version: CHECKPOINT_MANIFEST_VERSION,
      networkId,
      genesisHash,
      sequence: 1,
      previousManifestDigest: null,
      checkpoints: manifest
    };
  }
  requireExactFields(manifest, MANIFEST_FIELDS, 'Checkpoint manifest');
  if (manifest.version !== undefined && manifest.version !== CHECKPOINT_MANIFEST_VERSION) {
    fail('CHECKPOINT_INVALID', `Checkpoint manifest version ${manifest.version} is not supported.`, {
      statusCode: 400
    });
  }
  const manifestNetworkId = manifest.networkId ?? networkId;
  const manifestGenesisHash = manifest.genesisHash ?? genesisHash;
  if (manifestNetworkId !== networkId) {
    fail('NETWORK_ID_MISMATCH', 'Checkpoint manifest belongs to a different network.', {
      expected: networkId,
      actual: manifestNetworkId
    });
  }
  if (manifestGenesisHash !== genesisHash) {
    fail('GENESIS_MISMATCH', 'Checkpoint manifest belongs to a different genesis.', {
      expected: genesisHash,
      actual: manifestGenesisHash
    });
  }
  const sequence = manifest.sequence ?? (Array.isArray(manifest.checkpoints) && manifest.checkpoints.length ? 1 : 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    fail('CHECKPOINT_INVALID', 'Checkpoint manifest sequence must be a non-negative safe integer.', {
      statusCode: 400
    });
  }
  const previousManifestDigest = manifest.previousManifestDigest ?? null;
  if (previousManifestDigest !== null && !isHex64(previousManifestDigest)) {
    fail('CHECKPOINT_INVALID', 'Checkpoint manifest previousManifestDigest must be null or 64 lowercase hex characters.', {
      statusCode: 400
    });
  }
  if (!Array.isArray(manifest.checkpoints)) {
    fail('CHECKPOINT_INVALID', 'Checkpoint manifest checkpoints must be an array.', { statusCode: 400 });
  }

  const checkpoints = manifest.checkpoints.map((entry, index) =>
    normalizeCheckpointEntry(entry, { networkId, genesisHash, index })
  );
  // K-3 monotonic height: append-only anchors, no retroactive insertion.
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (checkpoints[index].height <= checkpoints[index - 1].height) {
      fail('CHECKPOINT_HEIGHT_ORDER', 'Checkpoint heights must be strictly increasing.', {
        previous: checkpoints[index - 1].height,
        actual: checkpoints[index].height
      });
    }
  }

  return {
    version: CHECKPOINT_MANIFEST_VERSION,
    networkId: manifestNetworkId,
    genesisHash: manifestGenesisHash,
    sequence,
    previousManifestDigest,
    publishedAt: normalizePublishedAt(manifest.publishedAt),
    checkpoints
  };
}

function manifestBody(manifest) {
  return {
    version: CHECKPOINT_MANIFEST_VERSION,
    networkId: manifest.networkId,
    genesisHash: manifest.genesisHash,
    sequence: manifest.sequence,
    previousManifestDigest: manifest.previousManifestDigest,
    publishedAt: manifest.publishedAt,
    checkpoints: manifest.checkpoints.map(checkpoint => ({
      networkId: checkpoint.networkId,
      protocolVersion: checkpoint.protocolVersion,
      height: checkpoint.height,
      blockHash: checkpoint.blockHash,
      chainWork: checkpoint.chainWork,
      genesisHash: checkpoint.genesisHash
    }))
  };
}

/** SHA-256 of the canonical manifest body. */
export function computeManifestDigest(manifest) {
  return sha256Hex(JSON.stringify(manifestBody(manifest)));
}

/** SHA-256 of the sorted checkpoint tuples, used for peer-set comparison. */
export function computeCheckpointSetDigest(checkpoints) {
  const sorted = [...checkpoints].sort((a, b) => a.height - b.height);
  return sha256Hex(JSON.stringify(sorted.map(checkpoint => ({
    networkId: checkpoint.networkId,
    protocolVersion: checkpoint.protocolVersion,
    height: checkpoint.height,
    blockHash: checkpoint.blockHash,
    chainWork: checkpoint.chainWork,
    genesisHash: checkpoint.genesisHash
  }))));
}

/**
 * Derives a checkpoint tuple from a locally held chain (K-7). The hash and
 * cumulative work come from the canonical walk, never from stored fields.
 */
export function deriveCheckpoint(blocks, height, {
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  activationHeight = null
} = {}) {
  const ancestry = verifyAncestry(blocks, height, { networkId, genesisHash, activationHeight });
  return {
    networkId,
    protocolVersion: eraOfHeight(height, activationHeight),
    height,
    blockHash: ancestry.topHash,
    chainWork: ancestry.chainWork,
    genesisHash
  };
}

/**
 * Structural + continuity validation. K-7 derivation is applied when `blocks`
 * is supplied; without chain data the caller can only establish structure, so
 * the result reports which checkpoints remain underived.
 */
export function validateCheckpointSet(value, {
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  priorManifest = null,
  tipHeight = undefined,
  burial = DEFAULT_CHECKPOINT_BURIAL,
  enforceBurial = tipHeight !== undefined,
  enforcePublication = false,
  publicationWindowDays = DEFAULT_PUBLICATION_WINDOW_DAYS,
  expectedManifestDigest = null,
  now = Date.now(),
  blocks = null,
  activationHeight = null,
  recovery = false
} = {}) {
  const manifest = normalizeCheckpointManifest(value, { networkId, genesisHash });
  const manifestDigest = computeManifestDigest(manifest);
  const checkpointSetDigest = computeCheckpointSetDigest(manifest.checkpoints);
  const effectiveTip = Number.isSafeInteger(tipHeight)
    ? tipHeight
    : (Array.isArray(blocks) && blocks.length ? blocks[blocks.length - 1].height : undefined);

  // K-10 binary binding.
  if (expectedManifestDigest !== null && expectedManifestDigest !== manifestDigest) {
    fail('CHECKPOINT_MANIFEST_DIGEST_MISMATCH', 'Compiled manifest digest does not match the published manifest.', {
      expected: expectedManifestDigest,
      actual: manifestDigest
    });
  }

  if (priorManifest !== null) {
    const prior = normalizeCheckpointManifest(priorManifest, { networkId, genesisHash });
    const priorDigest = computeManifestDigest(prior);

    // K-1 append-only.
    const currentHeights = new Set(manifest.checkpoints.map(checkpoint => checkpoint.height));
    for (const checkpoint of prior.checkpoints) {
      if (!currentHeights.has(checkpoint.height)) {
        fail('CHECKPOINT_REMOVED', `Checkpoint at height ${checkpoint.height} was removed from the set.`, {
          height: checkpoint.height
        });
      }
    }
    // K-2 immutable values.
    const currentByHeight = new Map(manifest.checkpoints.map(checkpoint => [checkpoint.height, checkpoint]));
    for (const checkpoint of prior.checkpoints) {
      const current = currentByHeight.get(checkpoint.height);
      for (const field of ['networkId', 'protocolVersion', 'blockHash', 'chainWork', 'genesisHash']) {
        if (current[field] !== checkpoint[field]) {
          fail('CHECKPOINT_VALUE_CHANGED', `Checkpoint at height ${checkpoint.height} changed its ${field}.`, {
            height: checkpoint.height,
            field,
            expected: checkpoint[field],
            actual: current[field]
          });
        }
      }
    }
    // K-3 new heights must be greater than the prior maximum.
    const priorMax = prior.checkpoints.length
      ? Math.max(...prior.checkpoints.map(checkpoint => checkpoint.height))
      : 0;
    for (const checkpoint of manifest.checkpoints) {
      if (!prior.checkpoints.some(priorCheckpoint => priorCheckpoint.height === checkpoint.height) &&
        checkpoint.height <= priorMax) {
        fail('CHECKPOINT_HEIGHT_ORDER', 'A new checkpoint may not be inserted below the prior maximum height.', {
          priorMax,
          actual: checkpoint.height
        });
      }
    }
    // K-9 manifest chaining. Recovery is not a new release: it re-verifies the
    // very same manifest (K-12), so sequence/digest chaining is checked only
    // when the set is being advanced.
    if (recovery) {
      // K-12 recovery uses the same set: a recovered node may not substitute,
      // extend, or truncate the anchors it was already enforcing.
      if (manifestDigest !== priorDigest) {
        fail('CHECKPOINT_RECOVERY_SET_CHANGED', 'Recovery must re-verify the existing checkpoint set, not replace it.');
      }
    } else {
      if (manifest.sequence !== prior.sequence + 1) {
        fail('CHECKPOINT_MANIFEST_CHAIN_BROKEN', 'Checkpoint manifest sequence does not extend the prior manifest.', {
          expected: prior.sequence + 1,
          actual: manifest.sequence
        });
      }
      if (manifest.previousManifestDigest !== priorDigest) {
        fail('CHECKPOINT_MANIFEST_CHAIN_BROKEN', 'Checkpoint manifest does not chain to the prior manifest digest.', {
          expected: priorDigest,
          actual: manifest.previousManifestDigest
        });
      }
    }
  } else if (manifest.sequence > 1) {
    fail('CHECKPOINT_MANIFEST_CHAIN_UNVERIFIED', 'A chained manifest requires the prior manifest to verify its digest chain.');
  }

  // K-8 publication-before-use. Policy only when the operator supplies a
  // publication timestamp; an unsigned timestamp is not authenticity.
  if (enforcePublication) {
    if (manifest.publishedAt === null) {
      fail('CHECKPOINT_PUBLICATION_UNVERIFIED', 'Checkpoint manifest has no publication timestamp.');
    }
    const required = publicationWindowDays * 24 * 60 * 60 * 1000;
    if (now - manifest.publishedAt < required) {
      fail('CHECKPOINT_PUBLICATION_WINDOW', 'Checkpoint manifest has not completed its publication window.', {
        publishedAt: manifest.publishedAt,
        requiredMs: required
      });
    }
  }

  // K-5 network and genesis are checked during normalization. K-6 burial.
  if (enforceBurial && Number.isSafeInteger(effectiveTip)) {
    for (const checkpoint of manifest.checkpoints) {
      if (checkpoint.height > effectiveTip - burial) {
        fail('CHECKPOINT_NOT_BURIED', `Checkpoint height ${checkpoint.height} is not buried by ${burial} blocks below tip ${effectiveTip}.`, {
          height: checkpoint.height,
          tipHeight: effectiveTip,
          burial
        });
      }
    }
  }

  const underived = [];
  if (blocks !== null) {
    for (const checkpoint of manifest.checkpoints) {
      if (Number.isSafeInteger(effectiveTip) && checkpoint.height <= effectiveTip) {
        verifyCheckpoint(checkpoint, blocks, { networkId, genesisHash, activationHeight });
      } else {
        underived.push(checkpoint.height);
      }
    }
  }

  return {
    manifest,
    checkpoints: manifest.checkpoints,
    manifestDigest,
    checkpointSetDigest,
    underived: blocks === null
      ? manifest.checkpoints.map(checkpoint => checkpoint.height)
      : underived
  };
}

/**
 * Rejects a candidate chain that changes any applicable checkpoint. This runs
 * before cumulative work is compared (Rule N-1).
 */
export function assertCheckpointsForCandidate(checkpoints, blocks, {
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  activationHeight = null
} = {}) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return { verified: true, checked: [] };
  if (!Array.isArray(blocks) || blocks.length === 0) {
    fail('NOT_AN_ARRAY', 'Candidate chain must be a non-empty array.');
  }
  const tipHeight = blocks[blocks.length - 1]?.height;
  if (!Number.isSafeInteger(tipHeight)) {
    fail('CHECKPOINT_VIOLATION', 'Candidate chain does not expose a safe tip height.');
  }
  const checked = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.height > tipHeight) continue;
    try {
      verifyCheckpoint(checkpoint, blocks, { networkId, genesisHash, activationHeight });
      checked.push({ height: checkpoint.height, state: 'APPLICABLE' });
    } catch (error) {
      if (error instanceof CheckpointError) {
        fail('CHECKPOINT_VIOLATION',
          `Candidate chain conflicts with the checkpoint at height ${checkpoint.height}: ${error.message}`, {
            height: checkpoint.height,
            cause: error.code,
            expected: checkpoint.blockHash,
            actual: error.details?.actual ?? null,
            details: error.details
          });
      }
      throw error;
    }
  }
  return { verified: true, checked };
}

/**
 * Aggregates §8.5 states for the local chain and reports structured errors.
 * Never repairs, never falls back to a stored hash.
 */
export function evaluateCheckpointSet(checkpoints, blocks, options = {}) {
  const manifestDigest = options.manifestDigest ?? null;
  const checkpointSetDigest = options.checkpointSetDigest ?? null;
  if (!checkpoints || checkpoints.length === 0) {
    return {
      checkpointState: 'UNCONFIGURED',
      checkpoints: [],
      checkpointErrors: [],
      checkpointSetDigest,
      manifestDigest
    };
  }
  const statuses = [];
  const errors = [];
  let aggregate = 'NOT_YET_APPLICABLE';
  for (const checkpoint of checkpoints) {
    const state = checkpointState(checkpoint, blocks, options);
    statuses.push({ height: checkpoint.height, state, blockHash: checkpoint.blockHash });
    if (state === 'VIOLATED') {
      aggregate = 'VIOLATED';
      try {
        verifyCheckpoint(checkpoint, blocks, options);
      } catch (error) {
        errors.push({
          height: checkpoint.height,
          code: error.code || 'CHECKPOINT_VIOLATION',
          message: error.message,
          details: error.details ?? {}
        });
      }
    } else if (state === 'UNSUPPORTED_PROTOCOL_VERSION') {
      if (aggregate !== 'VIOLATED') aggregate = 'UNSUPPORTED_PROTOCOL_VERSION';
    } else if (state === 'APPLICABLE' && aggregate === 'NOT_YET_APPLICABLE') {
      aggregate = 'APPLICABLE';
    }
  }
  return {
    checkpointState: aggregate,
    checkpoints: statuses,
    checkpointErrors: errors,
    checkpointSetDigest,
    manifestDigest
  };
}

/**
 * §14.6 peer checkpoint comparison. Compare only; never adopt.
 */
export function compareCheckpointSets(localCheckpoints, peerCheckpoints) {
  const local = Array.isArray(localCheckpoints) ? localCheckpoints : [];
  const peer = Array.isArray(peerCheckpoints) ? peerCheckpoints : [];
  const peerByHeight = new Map(peer.map(checkpoint => [checkpoint.height, checkpoint]));
  const common = [];
  for (const checkpoint of local) {
    const other = peerByHeight.get(checkpoint.height);
    if (!other) continue;
    for (const field of ['protocolVersion', 'blockHash', 'chainWork', 'networkId', 'genesisHash']) {
      if (checkpoint[field] !== other[field]) {
        return {
          compatible: false,
          conflict: true,
          height: checkpoint.height,
          field,
          local: checkpoint,
          peer: other
        };
      }
    }
    common.push(checkpoint.height);
  }
  const localOnly = local.length - common.length;
  const peerOnly = peer.length - common.length;
  if (common.length === 0) {
    return {
      compatible: false,
      conflict: false,
      reason: 'NO_COMMON_CHECKPOINT',
      common: [],
      localOnly,
      peerOnly
    };
  }
  const prefer = peerOnly > localOnly ? 'peer' : (localOnly > peerOnly ? 'local' : 'either');
  return {
    compatible: true,
    conflict: false,
    common,
    localOnly,
    peerOnly,
    prefer
  };
}
