#!/usr/bin/env node
// Minimal CLI miner for a BNKR node you control.
//
// It never opens a wallet or a database. It asks the local node for a template,
// finds a proof with the same canonical preimage used by the browser worker,
// and submits the block. Rewards are paid to --miner, your Ed25519 public key.

import { buildCandidate } from '../src/miner.worker.js';
import { hashBlock } from '../server/ledger.js';

const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function usage() {
  return [
    'Usage:',
    '  npm run mine -- --miner <BASE64_PUBLIC_KEY> [options]',
    '',
    'Options:',
    '  --origin <url>   Node API origin (default: BNKR_NODE_URL or http://127.0.0.1:4174)',
    '  --blocks <n>     Blocks to mine; 0 means until stopped (default: 1)',
    '  --timeout <ms>   Per-request timeout in milliseconds (default: 60000)',
    '  --help           Show this message'
  ].join('\n');
}

if (args.includes('--help')) {
  console.log(usage());
  process.exit(0);
}

try {
  const origin = (arg('origin') || process.env.BNKR_NODE_URL || 'http://127.0.0.1:4174').replace(/\/+$/, '');
  const miner = arg('miner');
  const blocksRaw = arg('blocks', '1');
  const blocksParsed = Number.parseInt(blocksRaw, 10);
  const timeoutRaw = arg('timeout', '60000');
  const timeoutMs = Number.parseInt(timeoutRaw, 10);

  if (!miner) throw new Error('A --miner public key is required.');
  if (Buffer.from(miner, 'base64').length !== 32) {
    throw new Error('--miner must be a base64-encoded 32-byte Ed25519 public key.');
  }
  if (!Number.isInteger(blocksParsed) || blocksParsed < 0) {
    throw new Error('--blocks must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer in milliseconds.');
  }

  const maxBlocks = blocksParsed === 0 ? Infinity : blocksParsed;
  let running = true;
  process.on('SIGINT', () => {
    running = false;
    console.log('\nStopping after the current block...');
  });

  async function getJson(url, init = {}) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
    return body;
  }

  let mined = 0;
  console.log(
    `BNKR CLI miner -> ${origin} ` +
    `(${maxBlocks === Infinity ? 'continuous' : `${maxBlocks} block(s)`}, timeout ${timeoutMs}ms)`
  );

  while (running && mined < maxBlocks) {
    const query = new URLSearchParams({ miner });
    const template = await getJson(`${origin}/api/mining/template?${query}`);
    const started = Date.now();
    let nonce = 0;
    let block = null;

    for (;;) {
      const candidate = buildCandidate(template, nonce);
      const hash = hashBlock(candidate);
      if (hash.startsWith('0'.repeat(candidate.difficulty))) {
        block = { ...candidate, hash };
        break;
      }
      nonce += 1;
      if (!running) break;
    }

    if (!block) break;

    const submitted = await getJson(`${origin}/api/mining/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(block)
    });
    mined += 1;
    console.log(
      `height ${submitted?.height ?? block.height}  hash ${block.hash}  ` +
      `nonce ${nonce}  ${Date.now() - started}ms`
    );

    if (mined < maxBlocks) await new Promise(resolve => setTimeout(resolve, 250));
  }

  console.log(`Done. Mined ${mined} block(s).`);
} catch (error) {
  console.error(`Miner error: ${error?.message || error}`);
  console.error(usage());
  process.exitCode = 1;
}
