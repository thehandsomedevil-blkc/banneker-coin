// Browser mining worker.
//
// The preimage and digest come from shared/canonical.js, the same module the
// Node validator uses. This module deliberately imports no Node built-in so the
// browser bundle and `node --test` exercise identical bytes.
//
// The template carries its era: a V2 template has `version: 2` and `networkId`;
// an Era 1 template has neither. `buildCandidate` therefore never guesses an
// era, and an old cached worker cannot silently submit a V1-shaped block after
// activation.

import { canonicalBlockPreimage, sha256Hex } from '../shared/canonical.js';

const BATCH_SIZE = 128;
const REPORT_INTERVAL_MS = 500;

export function buildCandidate(template, nonce) {
  const header = {
    height: template.height,
    timestamp: template.timestamp,
    prevHash: template.prevHash,
    difficulty: template.difficulty,
    nonce,
    miner: template.miner,
    transactions: template.transactions,
    reward: template.reward,
    message: template.message
  };
  if (template.version === 2) {
    return {
      version: 2,
      networkId: template.networkId,
      ...header
    };
  }
  return header;
}

function preimageOptions(template) {
  return template.version === 2 ? { expectedNetworkId: template.networkId } : {};
}

/**
 * Hashes one bounded nonce range. Returns the found block or the next nonce so
 * a caller can yield to the event loop between batches.
 */
export async function mineBatch(template, startNonce, batchSize = BATCH_SIZE, shouldContinue = () => true) {
  const prefix = '0'.repeat(template.difficulty);
  const end = startNonce + batchSize;
  let nonce = startNonce;
  while (nonce < end) {
    if (!shouldContinue()) {
      return { block: null, nextNonce: nonce, hashes: nonce - startNonce, stopped: true };
    }
    const block = buildCandidate(template, nonce);
    const hash = await sha256Hex(canonicalBlockPreimage(block, preimageOptions(template)));
    nonce += 1;
    if (hash.startsWith(prefix)) {
      return {
        block: { ...block, hash },
        hash,
        nextNonce: nonce,
        hashes: nonce - startNonce,
        stopped: false
      };
    }
  }
  return { block: null, nextNonce: nonce, hashes: nonce - startNonce, stopped: false };
}

/**
 * Searches from `startNonce` until a proof is found, the caller cancels, or
 * `maxHashes` is reached. `maxHashes` exists so tests and diagnostics can bound
 * an intentionally hard search.
 */
export async function findProof(template, {
  startNonce = 0,
  batchSize = BATCH_SIZE,
  shouldContinue = () => true,
  onProgress = null,
  maxHashes = Infinity
} = {}) {
  let nonce = startNonce;
  let totalHashes = 0;
  while (totalHashes < maxHashes) {
    const size = Math.min(batchSize, maxHashes - totalHashes);
    const result = await mineBatch(template, nonce, size, shouldContinue);
    nonce = result.nextNonce;
    totalHashes += result.hashes;
    if (result.block) return { ...result, totalHashes };
    if (result.stopped) return null;
    if (onProgress) onProgress({ nonce, hashes: totalHashes });
    if (!shouldContinue()) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

let active = false;
let template = null;
let nextNonce = 0;
let reportHashes = 0;
let lastReport = typeof performance !== 'undefined' ? performance.now() : 0;
let generation = 0;

function emit(message) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.postMessage(message);
  }
}

async function mineLoop(token) {
  while (active && token === generation) {
    const result = await mineBatch(
      template,
      nextNonce,
      BATCH_SIZE,
      () => active && token === generation
    );
    nextNonce = result.nextNonce;
    reportHashes += result.hashes;

    const now = performance.now();
    if (now - lastReport >= REPORT_INTERVAL_MS) {
      emit({
        type: 'progress',
        nonce: nextNonce,
        hashesPerSecond: Math.round(reportHashes * 1000 / (now - lastReport))
      });
      reportHashes = 0;
      lastReport = now;
    }

    if (result.block) {
      active = false;
      emit({ type: 'found', block: result.block, hashes: reportHashes });
      return;
    }
    if (result.stopped) return;

    // Yield so a stop message can be delivered between batches.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.onmessage = event => {
    if (event.data.type === 'stop') {
      active = false;
      generation += 1;
      emit({ type: 'stopped' });
    } else if (event.data.type === 'start') {
      template = event.data.template;
      nextNonce = 0;
      reportHashes = 0;
      lastReport = performance.now();
      active = true;
      generation += 1;
      void mineLoop(generation);
    }
  };
}
