// Paged chain exchange (correction spec §14.8, C-14/C-16/R-17).
//
// A page is a small, self-describing unit. The receiver verifies identity,
// ordering, size, and the hash chain *before* the blocks are handed to the
// validator, so a hostile peer can neither exhaust memory nor splice pages.
//
// The envelope body has a fixed field order. `pageHash` is the SHA-256 of that
// body (without `pageHash`), and `prevPageHash` links a page to its predecessor.

import { createHash } from 'node:crypto';
import { BNKR_NETWORK_ID } from '../shared/canonical.js';
import { fetchPeerJson } from './security.js';

export const MAX_CHAIN_BLOCKS = 100_000;
export const MAX_CHAIN_BYTES = 256 * 1024 * 1024;
export const MAX_PAGE_BLOCKS = 500;
export const MAX_PAGE_BYTES = 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_PAGES = Math.ceil(MAX_CHAIN_BLOCKS / MAX_PAGE_BLOCKS);
export const PROTOCOL_VERSION = 2;

const HEX64 = /^[0-9a-f]{64}$/;

export class PageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PageError';
    this.code = code;
    // A malformed or hostile peer page is a bad gateway, not a client mistake.
    this.statusCode = details.statusCode ?? 502;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PageError(code, message, details);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isHex64(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function isHeight(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPageIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requirePageObject(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    fail('PAGE_INVALID', 'Peer page must be a JSON object.');
  }
}

/**
 * The canonical page body. Field order is part of the digest contract; changing
 * it is a protocol change, not a formatting choice.
 */
export function canonicalPageBody(page) {
  return {
    networkId: page.networkId,
    genesisHash: page.genesisHash,
    protocolVersion: page.protocolVersion,
    fromHeight: page.fromHeight,
    toHeight: page.toHeight,
    pageIndex: page.pageIndex,
    prevPageHash: page.prevPageHash ?? null,
    checkpointSetDigest: page.checkpointSetDigest ?? null,
    tipHeight: page.tipHeight ?? null,
    blocks: page.blocks
  };
}

export function computePageHash(page) {
  return sha256Hex(JSON.stringify(canonicalPageBody(page)));
}

/**
 * Builds one bounded page from a contiguous ascending chain slice.
 *
 * `fromHeight` is the requested start. Blocks below it are ignored, and the page
 * stops before `maxBlocks`, `maxBytes`, or `toHeight` would be exceeded. A page
 * that cannot hold its first block is refused rather than silently truncated.
 */
export function buildBlockPage({
  blocks,
  fromHeight,
  tipHeight,
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  protocolVersion = PROTOCOL_VERSION,
  checkpointSetDigest = null,
  pageIndex = 0,
  prevPageHash = null,
  toHeight = Number.MAX_SAFE_INTEGER,
  maxBlocks = MAX_PAGE_BLOCKS,
  maxBytes = MAX_PAGE_BYTES
} = {}) {
  if (!Array.isArray(blocks)) fail('PAGE_INVALID', 'Block history must be an array.', { statusCode: 500 });
  if (!isHeight(fromHeight)) fail('PAGE_INVALID', 'fromHeight must be a non-negative safe integer.', { statusCode: 400 });
  if (!isHex64(genesisHash)) fail('PAGE_INVALID', 'A genesis hash is required to build a page.', { statusCode: 400 });
  if (!isPageIndex(pageIndex)) fail('PAGE_INVALID', 'pageIndex must be a non-negative safe integer.', { statusCode: 400 });

  const ascending = [...blocks]
    .filter(block => Number.isSafeInteger(block?.height) && block.height >= fromHeight && block.height <= toHeight)
    .sort((left, right) => left.height - right.height);

  const selected = [];
  // Leave room for the envelope, digests, and JSON punctuation. The cap is a
  // transport bound, so a conservative estimate is safer than an exact one.
  const envelopeReserve = 1024;
  let used = envelopeReserve;
  for (const block of ascending) {
    if (selected.length >= maxBlocks) break;
    if (selected.length && block.height !== selected[selected.length - 1].height + 1) break;
    const bytes = Buffer.byteLength(JSON.stringify(block), 'utf8') + 1;
    if (selected.length === 0 && bytes + envelopeReserve > maxBytes) {
      fail('PAGE_BLOCK_TOO_LARGE', `Block at height ${block.height} exceeds the ${maxBytes}-byte page limit.`, {
        height: block.height,
        maxBytes
      });
    }
    if (used + bytes > maxBytes) break;
    selected.push(block);
    used += bytes;
  }

  const effectiveTip = Number.isSafeInteger(tipHeight)
    ? tipHeight
    : (blocks.length ? blocks.reduce((tip, block) => Math.max(tip, block.height || 0), 0) : 0);
  const body = {
    networkId,
    genesisHash,
    protocolVersion,
    fromHeight,
    toHeight: selected.length ? selected[selected.length - 1].height : fromHeight - 1,
    pageIndex,
    prevPageHash,
    checkpointSetDigest,
    tipHeight: effectiveTip,
    blocks: selected
  };
  return { ...body, pageHash: computePageHash(body) };
}

/**
 * Verifies one page before its blocks are trusted. The caller supplies the
 * expected position from its own cursor; a page cannot choose where it goes.
 */
export function verifyBlockPage(page, {
  expectedFromHeight,
  expectedPageIndex = 0,
  expectedPrevPageHash = null,
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  protocolVersion = PROTOCOL_VERSION,
  checkpointSetDigest = undefined,
  maxBlocks = MAX_PAGE_BLOCKS,
  maxBytes = MAX_PAGE_BYTES,
  allowEmpty = true
} = {}) {
  requirePageObject(page);

  // Identity first: nothing in `blocks` is touched until the page claims to be
  // for this network, genesis, and protocol era.
  if (page.networkId !== networkId) {
    fail('NETWORK_ID_MISMATCH', `Peer page networkId ${page.networkId} does not match ${networkId}.`, {
      expected: networkId,
      actual: page.networkId
    });
  }
  if (!isHex64(genesisHash)) {
    fail('PAGE_INVALID', 'A genesis hash is required to verify a page.', { statusCode: 400 });
  }
  if (page.genesisHash !== genesisHash) {
    fail('GENESIS_MISMATCH', 'Peer page genesisHash does not match the local genesis.', {
      expected: genesisHash,
      actual: page.genesisHash
    });
  }
  if (page.protocolVersion !== protocolVersion) {
    fail('UNSUPPORTED_PROTOCOL_VERSION',
      `Peer page protocolVersion ${page.protocolVersion} is not supported by this binary.`, {
        expected: protocolVersion,
        actual: page.protocolVersion
      });
  }
  // K-11: a peer serving a different anchor set is refused, never compared by
  // work. The digest is over the canonical tuples, so equality means the same
  // (networkId, height, blockHash, chainWork) facts.
  if (checkpointSetDigest !== undefined && checkpointSetDigest !== null &&
    (page.checkpointSetDigest ?? null) !== checkpointSetDigest) {
    fail('CHECKPOINT_SET_MISMATCH', 'Peer page belongs to a different checkpoint set.', {
      expected: checkpointSetDigest,
      actual: page.checkpointSetDigest ?? null
    });
  }
  if (!isHeight(page.fromHeight) || !isPageIndex(page.pageIndex)) {
    fail('PAGE_INVALID', 'Peer page has an invalid height or page index.');
  }
  if (isHeight(expectedFromHeight) && page.fromHeight !== expectedFromHeight) {
    fail('PAGE_HEIGHT_MISMATCH', `Peer page starts at ${page.fromHeight}, expected ${expectedFromHeight}.`, {
      expected: expectedFromHeight,
      actual: page.fromHeight
    });
  }
  if (page.pageIndex !== expectedPageIndex) {
    fail('PAGE_INDEX_MISMATCH', `Peer page index ${page.pageIndex}, expected ${expectedPageIndex}.`, {
      expected: expectedPageIndex,
      actual: page.pageIndex
    });
  }
  if ((page.prevPageHash ?? null) !== (expectedPrevPageHash ?? null)) {
    fail('PAGE_PREV_HASH_MISMATCH', 'Peer page does not chain to the previous page.', {
      expected: expectedPrevPageHash,
      actual: page.prevPageHash ?? null
    });
  }
  if (!isHex64(page.pageHash)) {
    fail('PAGE_INVALID', 'Peer pageHash must be 64 lowercase hex characters.');
  }
  if (!Array.isArray(page.blocks)) {
    fail('PAGE_INVALID', 'Peer page blocks must be an array.');
  }
  if (page.blocks.length > maxBlocks) {
    fail('PAGE_TOO_MANY_BLOCKS', `Peer page contains ${page.blocks.length} blocks; the limit is ${maxBlocks}.`, {
      maxBlocks
    });
  }
  if (!Number.isSafeInteger(page.toHeight)) {
    fail('PAGE_INVALID', 'Peer page toHeight must be a safe integer.');
  }

  const serialized = JSON.stringify(page);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    fail('PAGE_TOO_LARGE', `Peer page is ${bytes} bytes; the limit is ${maxBytes}.`, { maxBytes, bytes });
  }

  const expectedToHeight = page.fromHeight + page.blocks.length - 1;
  if (page.toHeight !== expectedToHeight) {
    fail('PAGE_HEIGHT_MISMATCH', `Peer page toHeight ${page.toHeight} does not match its block range.`, {
      expected: expectedToHeight,
      actual: page.toHeight
    });
  }
  if (!allowEmpty && page.blocks.length === 0) {
    fail('PAGE_EMPTY', 'Peer page contains no blocks.');
  }

  for (let index = 0; index < page.blocks.length; index += 1) {
    const block = page.blocks[index];
    if (!block || block.height !== page.fromHeight + index) {
      fail('PAGE_GAP', `Peer page block at position ${index} has the wrong height.`, {
        expected: page.fromHeight + index,
        actual: block?.height ?? null
      });
    }
  }

  const computedHash = computePageHash(page);
  if (computedHash !== page.pageHash) {
    fail('PAGE_HASH_MISMATCH', 'Peer pageHash does not match the canonical page body.', {
      expected: computedHash,
      actual: page.pageHash
    });
  }

  return {
    blocks: page.blocks,
    pageHash: computedHash,
    pageIndex: page.pageIndex,
    fromHeight: page.fromHeight,
    toHeight: page.toHeight,
    tipHeight: Number.isSafeInteger(page.tipHeight) ? page.tipHeight : null,
    checkpointSetDigest: typeof page.checkpointSetDigest === 'string' ? page.checkpointSetDigest : null
  };
}

/**
 * Client-side paged fetch with hard per-page, total-page, and total-byte bounds.
 * Each page is verified against the cursor before its blocks are appended.
 */
export async function fetchPeerChain(origin, {
  networkId = BNKR_NETWORK_ID,
  genesisHash,
  protocolVersion = PROTOCOL_VERSION,
  checkpointSetDigest = null,
  allowPrivate = false,
  lookup = undefined,
  timeoutMs = 8000,
  pageBlocks = MAX_PAGE_BLOCKS,
  maxPages = MAX_SYNC_PAGES,
  maxBlocks = MAX_CHAIN_BLOCKS,
  maxBytes = MAX_CHAIN_BYTES,
  maxPageBytes = MAX_PAGE_BYTES
} = {}) {
  if (!isHex64(genesisHash)) {
    fail('PAGE_INVALID', 'A genesis hash is required to sync a peer chain.', { statusCode: 400 });
  }
  if (!Number.isSafeInteger(pageBlocks) || pageBlocks < 1 || pageBlocks > MAX_PAGE_BLOCKS) {
    fail('PAGE_INVALID', `pageBlocks must be between 1 and ${MAX_PAGE_BLOCKS}.`, { statusCode: 400 });
  }

  let cursor = 0;
  let expectedPageIndex = 0;
  let previousPageHash = null;
  let tipHeight = null;
  let totalBytes = 0;
  const blocks = [];
  const pageHashes = [];

  while (expectedPageIndex < maxPages) {
    const requestedTo = cursor + pageBlocks - 1;
    const query = `from=${cursor}&to=${requestedTo}&page=${expectedPageIndex}` +
      (previousPageHash ? `&prev=${previousPageHash}` : '');
    const page = await fetchPeerJson(
      `${origin}/api/peer/blocks?${query}`,
      { maxBytes: maxPageBytes, timeoutMs, allowPrivate, lookup }
    );
    const verified = verifyBlockPage(page, {
      expectedFromHeight: cursor,
      expectedPageIndex,
      expectedPrevPageHash: previousPageHash,
      networkId,
      genesisHash,
      protocolVersion,
      checkpointSetDigest,
      maxBlocks: pageBlocks,
      maxBytes: maxPageBytes
    });

    if (verified.blocks.length === 0) break;
    if (blocks.length + verified.blocks.length > maxBlocks) {
      fail('PAGE_CHAIN_TOO_LONG', `Peer chain exceeds the ${maxBlocks}-block sync limit.`, { maxBlocks });
    }

    totalBytes += Buffer.byteLength(JSON.stringify(verified.blocks), 'utf8');
    if (totalBytes > maxBytes) {
      fail('PAGE_CHAIN_TOO_LARGE', `Peer chain exceeds the ${maxBytes}-byte sync limit.`, { maxBytes });
    }

    blocks.push(...verified.blocks);
    pageHashes.push(verified.pageHash);
    if (tipHeight === null && verified.tipHeight !== null) tipHeight = verified.tipHeight;

    const reachedTip = tipHeight !== null && verified.toHeight >= tipHeight;
    const shortPage = verified.blocks.length < pageBlocks;
    if (reachedTip || (shortPage && tipHeight === null)) break;

    cursor = verified.toHeight + 1;
    previousPageHash = verified.pageHash;
    expectedPageIndex += 1;
  }

  if (tipHeight !== null && blocks.length > 0 && blocks[blocks.length - 1].height < tipHeight) {
    fail('PAGE_SYNC_INCOMPLETE', `Paged sync stopped at height ${blocks[blocks.length - 1].height} below peer tip ${tipHeight}.`, {
      height: blocks[blocks.length - 1].height,
      tipHeight
    });
  }

  return {
    blocks,
    pages: pageHashes.length,
    pageHashes,
    bytes: totalBytes,
    tipHeight,
    checkpointSetDigest
  };
}
