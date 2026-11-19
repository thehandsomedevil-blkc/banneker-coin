// Read-only derivation of the compiled Mainnet Checkpoint 1 (Q-2, height 731).
//
// The live database is never opened in place. It is copied byte-for-byte to the
// OS temp directory, the copy is read, and the copy is removed. The source file
// hash cannot change because no write handle is ever opened on it.
//
// Usage:
//   node scripts/derive-mainnet-checkpoint.mjs [path-to-db]
//
// Exit code 0 means the derived tuple matches the compiled anchor in
// shared/protocol.js. Any mismatch is fatal.

import { createClient } from '@libsql/client';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COMPILED_MAINNET_CHECKPOINTS
} from '../server/ledger.js';
import {
  deriveCheckpoint,
  verifyAncestry
} from '../server/checkpoints.js';
import { GENESIS_HASH } from '../server/ledger.js';
import { MAINNET_CHECKPOINT_ANCHORS } from '../shared/protocol.js';

const source = path.resolve(process.argv[2] || 'bannekercoin.db');
const anchor = MAINNET_CHECKPOINT_ANCHORS[0];
const compiled = COMPILED_MAINNET_CHECKPOINTS.find(entry => entry.height === anchor.height);

const sourceStat = await stat(source);
const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-derive-'));
const snapshot = path.join(directory, 'snapshot.db');
await copyFile(source, snapshot);

const client = createClient({ url: `file:${snapshot.replace(/\\/g, '/')}` });
let result;
try {
  const rows = (await client.execute('SELECT json FROM blocks ORDER BY height')).rows;
  const blocks = rows.map(row => JSON.parse(row.json));
  if (blocks.length === 0) throw new Error('Database contains no blocks.');
  const tipHeight = blocks[blocks.length - 1].height;
  if (tipHeight < anchor.height) {
    throw new Error(`Chain tip ${tipHeight} is below anchor height ${anchor.height}.`);
  }
  const ancestry = verifyAncestry(blocks, anchor.height, { genesisHash: GENESIS_HASH });
  const derived = deriveCheckpoint(blocks, anchor.height, { genesisHash: GENESIS_HASH });
  result = { tipHeight, blocks: blocks.length, ancestry, derived };
} finally {
  client.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const mismatches = [];
if (!compiled) mismatches.push('Compiled anchor is missing from server/ledger.js.');
for (const field of ['networkId', 'protocolVersion', 'height', 'blockHash', 'chainWork', 'genesisHash']) {
  if (compiled?.[field] !== result.derived[field]) {
    mismatches.push(`${field}: compiled=${compiled?.[field]} derived=${result.derived[field]}`);
  }
}

console.log(JSON.stringify({
  source,
  sourceBytes: sourceStat.size,
  readOnly: 'source copied before opening; no write handle on the source',
  tipHeight: result.tipHeight,
  ancestryVerified: result.ancestry.verified,
  derived: result.derived,
  matchesCompiledAnchor: mismatches.length === 0,
  mismatches
}, null, 2));

if (mismatches.length) process.exitCode = 1;
