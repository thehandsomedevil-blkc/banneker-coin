// Regression coverage for the two height-5,000 live-node issues:
//   1. replay of already-synced history must not depend on the local wall clock
//   2. read endpoints must stay O(page), not O(chain), on 5,000+ block chains
//
// The 5,000+ block case uses structurally realistic synthetic blocks for the
// hot pagination path; full proof-of-work replay remains covered by the normal
// ledger tests (a genuinely mined 5,000-block fixture is far too slow to build
// inside `node --test`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'nacl';
import {
  createLedger,
  hashBlock,
  pageBlocksDescending,
  validateChain
} from './ledger.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const minerAddress = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64');

function mine(template) {
  let nonce = 0;
  for (;;) {
    const block = { ...template, nonce };
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

/**
 * Builds an Era 1 chain at difficulty 1 whose timestamps are intentionally
 * ahead of the validator's clock. It is the shape of a chain synced from a
 * node whose clock is ahead of the validating node.
 */
async function buildClockSkewedChain(count) {
  const ledger = await createLedger(':memory:');
  try {
    const genesis = (await ledger.getBlocks())[0];
    const firstTimestamp = Date.now() + 300_000;
    const blocks = [genesis];
    let previous = genesis;
    for (let height = 1; height <= count; height += 1) {
      const template = await ledger.miningTemplate(minerAddress);
      const block = mine({
        ...template,
        height,
        prevHash: previous.hash,
        timestamp: firstTimestamp + height * 1000,
        difficulty: 1
      });
      block.chainWork = (BigInt(previous.chainWork || '0') + 16n).toString();
      blocks.push(block);
      previous = block;
    }
    return blocks;
  } finally {
    ledger.close();
  }
}

test('a 5,000+ block chain is paged newest-first without a full-chain copy', () => {
  const blocks = Array.from({ length: 5201 }, (_unused, height) => ({
    height,
    hash: `00000${String(height).padStart(4, '0')}abcdef`,
    miner: `miner-${height}`,
    timestamp: 1_793_491_200_000 + height * 1000
  }));

  const started = performance.now();
  const first = pageBlocksDescending(blocks, { limit: 25, offset: 0 });
  const elapsed = performance.now() - started;

  assert.equal(first.total, 5201);
  assert.equal(first.blocks.length, 25);
  assert.equal(first.blocks[0].height, 5200);
  assert.equal(first.blocks[24].height, 5176);
  assert.ok(elapsed < 250, `page extraction took ${elapsed.toFixed(1)}ms for 5,201 blocks`);

  const searched = pageBlocksDescending(blocks, { limit: 25, offset: 0, search: '5199' });
  assert.equal(searched.total, 1);
  assert.equal(searched.blocks[0].height, 5199);
});

test('clock-skewed synced history replays valid while fresh submissions stay strict', async () => {
  const blocks = await buildClockSkewedChain(12);

  // The exported strict helper still rejects a future timestamp, which is the
  // correct rule for untrusted input and new block submission.
  const strict = validateChain(blocks);
  assert.equal(strict.valid, false);
  assert.match(strict.error, /far in the future/);

  // Replay of already-accepted history is bound by hash + median time past
  // only, so a lagging local clock cannot produce a false "Chain Invalid".
  const replay = validateChain(blocks, { enforceWallClock: false });
  assert.equal(replay.valid, true, replay.error);
  assert.equal(replay.height, 12);
  assert.equal(replay.supply, 12 * 50 * 100_000_000);
});

test('deep validation is cached per snapshot generation and invalidated on change', async () => {
  const ledger = await createLedger(':memory:');
  try {
    const first = await ledger.cachedDeepValidation();
    assert.equal(first.valid, true);
    assert.strictEqual(await ledger.cachedDeepValidation(), first,
      'repeated polls with an unchanged tip must reuse the verdict');

    const template = await ledger.miningTemplate(minerAddress);
    await ledger.acceptBlock(mine(template));

    const afterBlock = await ledger.cachedDeepValidation();
    assert.notStrictEqual(afterBlock, first, 'a new snapshot must invalidate the cache');
    assert.equal(afterBlock.height, 1);
    assert.equal(afterBlock.valid, true);
  } finally {
    ledger.close();
  }
});

async function withNode(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-large-chain-test-'));
  const port = await new Promise((resolve, reject) => {
    const probe = spawn(process.execPath, ['-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    probe.stdout.on('data', chunk => { text += chunk; });
    probe.on('exit', () => resolve(Number(text.trim())));
    probe.on('error', reject);
  });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: origin,
      BANNEKER_DB: path.join(directory, 'bannekercoin.db'),
      BANNEKER_PEERS: '',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  try {
    let ready = false;
    const deadline = Date.now() + 20_000;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test node exited: ${output}`);
      try {
        const response = await fetch(`${origin}/health`);
        ready = response.status === 200;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!ready) throw new Error(`Test node did not become ready: ${output}`);
    await run(origin);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('stats, blocks, validate and peer endpoints respond without 503 under repeated polls', async () => {
  await withNode(async origin => {
    const paths = [
      '/api/stats',
      '/api/blocks?limit=25&offset=0',
      '/api/validate',
      '/api/peer/chain',
      '/api/peer/blocks?from=0&to=9&page=0'
    ];
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(paths.map(async target => {
        const started = performance.now();
        const response = await fetch(`${origin}${target}`);
        const elapsed = performance.now() - started;
        assert.equal(response.status, 200, `${target} returned ${response.status}`);
        assert.ok(elapsed < 10_000, `${target} took ${elapsed.toFixed(1)}ms`);
        return response.json();
      }));
    }

    const stats = await (await fetch(`${origin}/api/stats`)).json();
    assert.equal(stats.height, 0);
    assert.equal(stats.protocolVersion, 2);
    assert.equal(stats.healthy, true);
    assert.equal(stats.blocks, undefined, 'stats must not serialize block history');

    const peerChain = await (await fetch(`${origin}/api/peer/chain`)).json();
    assert.equal(peerChain.height, 0);
    assert.equal(peerChain.truncated, false);
    assert.ok(peerChain.chain.length <= 500, 'peer chain response must be bounded');
  });
});
