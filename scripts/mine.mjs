#!/usr/bin/env node
// Minimal CLI miner for a BNKR node you control.
//
// It never opens a wallet or a database. It asks the local node for a template,
// finds a proof with the same canonical preimage used by the browser worker,
// and submits the block. Rewards are paid to --miner, your Ed25519 public key.
//
// The exported helpers are pure enough to unit-test; the CLI entry point only
// runs when this file is executed directly.

import { buildCandidate } from '../src/miner.worker.js';
import { hashBlock } from '../server/ledger.js';
import { pathToFileURL } from 'node:url';

export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
export const DEFAULT_DELAY_MS = 3000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_RETRIES = 6;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30000;
export const MAX_STALE_TEMPLATE_RETRIES = 10;

export function usage() {
  return [
    'Usage:',
    '  npm run mine -- --miner <BASE64_PUBLIC_KEY> [options]',
    '',
    'Options:',
    '  --origin <url>      Node API origin (default: BNKR_NODE_URL or http://127.0.0.1:4174)',
    '  --blocks <n>        Blocks to mine; 0 means until stopped (default: 1)',
    '  --max-height <n>    Stop cleanly (exit 0) once chain height reaches <n>',
    '  --delay <ms>        Delay between blocks (default: 3000)',
    '  --timeout <ms>      Per-request timeout in milliseconds (default: 60000)',
    '  --help              Show this message'
  ].join('\n');
}

function argValue(args, name, fallback = null) {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function parseHeight(value, label, { allowZero = false } = {}) {
  const parsed = Number.parseInt(value, 10);
  const valid = allowZero ? parsed >= 0 : parsed > 0;
  if (!Number.isSafeInteger(parsed) || !valid || String(parsed) !== String(value).trim()) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer.`);
  }
  return parsed;
}

export function parseArgs(args, env = process.env) {
  if (args.includes('--help')) return { help: true };

  const originRaw = argValue(args, 'origin') || env.BNKR_NODE_URL || 'http://127.0.0.1:4174';
  const miner = argValue(args, 'miner');
  const blocksRaw = argValue(args, 'blocks', '1');
  const maxHeightRaw = argValue(args, 'max-height');
  const delayRaw = argValue(args, 'delay', String(DEFAULT_DELAY_MS));
  const timeoutRaw = argValue(args, 'timeout', String(DEFAULT_TIMEOUT_MS));

  if (!miner) throw new Error('A --miner public key is required.');
  if (Buffer.from(miner, 'base64').length !== 32) {
    throw new Error('--miner must be a base64-encoded 32-byte Ed25519 public key.');
  }

  const blocks = parseHeight(blocksRaw, '--blocks', { allowZero: true });
  const delayMs = parseHeight(delayRaw, '--delay', { allowZero: true });
  const timeoutMs = parseHeight(timeoutRaw, '--timeout');
  const maxHeight = maxHeightRaw === null ? null : parseHeight(maxHeightRaw, '--max-height');

  return {
    help: false,
    origin: String(originRaw).replace(/\/+$/, ''),
    miner,
    maxBlocks: blocks === 0 ? Infinity : blocks,
    maxHeight,
    delayMs,
    timeoutMs
  };
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.max(0, Math.round(Number(text) * 1000));
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function backoffDelay(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Retry attempt must be non-negative.');
  return Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
}

export async function requestJson(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return {
    status: response.status,
    ok: response.ok,
    retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
    body,
    text
  };
}

export async function withRetry(operation, {
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  sleep = defaultSleep,
  onRetry = null,
  retryableStatuses = RETRYABLE_STATUSES
} = {}) {
  let result = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await operation(attempt);
    } catch (error) {
      if (attempt >= retries) throw error;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      if (onRetry) onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
      continue;
    }

    if (result?.ok) return result;
    if (!retryableStatuses.has(result?.status) || attempt >= retries) return result;

    // Retry-After wins over the exponential schedule when it is longer.
    const delayMs = Math.max(
      backoffDelay(attempt, baseDelayMs, maxDelayMs),
      result.retryAfterMs || 0
    );
    if (onRetry) onRetry({
      attempt: attempt + 1,
      delayMs,
      status: result.status,
      retryAfterMs: result.retryAfterMs
    });
    await sleep(delayMs);
  }
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runMiner(options, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = console.log,
  build = buildCandidate,
  hash = hashBlock,
  shouldContinue = () => true,
  retryOptions = {}
} = {}) {
  const {
    origin, miner, maxBlocks = Infinity, maxHeight = null,
    delayMs = DEFAULT_DELAY_MS, timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const query = new URLSearchParams({ miner });
  const templateUrl = `${origin}/api/mining/template?${query}`;
  const submitUrl = `${origin}/api/mining/submit`;
  const retry = {
    retries: DEFAULT_RETRIES,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    sleep,
    ...retryOptions
  };

  let mined = 0;
  let staleStreak = 0;

  log(
    `BNKR CLI miner -> ${origin} ` +
    `(${maxBlocks === Infinity ? 'continuous' : `${maxBlocks} block(s)`}, ` +
    `timeout ${timeoutMs}ms, delay ${delayMs}ms` +
    `${maxHeight === null ? '' : `, max height ${maxHeight}`})`
  );

  while (shouldContinue() && mined < maxBlocks) {
    const templateResult = await withRetry(
      () => requestJson(templateUrl, {}, { timeoutMs, fetchImpl }),
      retry
    );
    if (!templateResult.ok) {
      throw new Error(`Template request failed: ${templateResult.status} ${templateResult.text?.slice(0, 300) || ''}`);
    }
    const template = templateResult.body;

    const currentHeight = Number.isSafeInteger(template?.height) ? template.height - 1 : null;
    if (maxHeight !== null && currentHeight !== null && currentHeight >= maxHeight) {
      log(`Chain height ${currentHeight} reached --max-height ${maxHeight}; stopping.`);
      return { mined, stoppedByMaxHeight: true };
    }

    const started = Date.now();
    let nonce = 0;
    let block = null;
    for (;;) {
      const candidate = build(template, nonce);
      const digest = hash(candidate);
      if (digest.startsWith('0'.repeat(candidate.difficulty))) {
        block = { ...candidate, hash: digest };
        break;
      }
      nonce += 1;
      if (!shouldContinue()) break;
    }
    if (!block) break;

    const submitResult = await withRetry(
      () => requestJson(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(block)
      }, { timeoutMs, fetchImpl }),
      retry
    );

    if (submitResult.status === 400) {
      // The chain moved while we were mining. Fetch a fresh template instead of
      // treating the stale-height race as a fatal error.
      staleStreak += 1;
      if (staleStreak > MAX_STALE_TEMPLATE_RETRIES) {
        throw new Error(`Template kept going stale after ${MAX_STALE_TEMPLATE_RETRIES} attempts.`);
      }
      log(`Stale template at height ${block.height}; fetching a fresh one.`);
      continue;
    }
    if (!submitResult.ok) {
      throw new Error(`Submit failed: ${submitResult.status} ${submitResult.text?.slice(0, 300) || ''}`);
    }

    staleStreak = 0;
    mined += 1;
    log(
      `height ${submitResult.body?.height ?? block.height}  hash ${block.hash}  ` +
      `nonce ${nonce}  ${Date.now() - started}ms`
    );

    if (mined < maxBlocks) await sleep(delayMs);
  }

  return { mined, stoppedByMaxHeight: false };
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }

  let running = true;
  process.on('SIGINT', () => {
    running = false;
    console.log('\nStopping after the current block...');
  });

  const result = await runMiner(options, { shouldContinue: () => running });
  console.log(`Done. Mined ${result.mined} block(s).`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(error => {
    console.error(`Miner error: ${error?.message || error}`);
    console.error(usage());
    process.exitCode = 1;
  });
}
