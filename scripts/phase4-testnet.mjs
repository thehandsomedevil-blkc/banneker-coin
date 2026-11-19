// Phase 4 live two-node V2 rehearsal (not a public testnet; Q-6 is still open).
//
// Two real server processes, two isolated temporary databases, and a full
// lifecycle across the Era 1 -> Era 2 boundary:
//
//   1. mine heights 1 (Era 1), 2 and 3 (Era 2)
//   2. prove an immature V2 coinbase cannot be spent before maturity
//   3. mine past maturity, broadcast a signed Ed25519 T7 transaction, mine it
//   4. sync node 2 from node 1 over the paged /api/peer/blocks transport
//   5. compare tips, validation, account state, and the recipient balance
//
// The mainnet databases are never referenced. Both node databases live in an
// OS temp directory and are deleted at the end.
//
// Usage: node scripts/phase4-testnet.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import nacl from 'nacl';
import {
  COIN,
  NETWORK_ID,
  hashBlock,
  parseAmount
} from '../server/ledger.js';
import { buildCandidate } from '../src/miner.worker.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT_1 = 4184;
const PORT_2 = 4185;
const ORIGIN_1 = `http://127.0.0.1:${PORT_1}`;
const ORIGIN_2 = `http://127.0.0.1:${PORT_2}`;
const ACTIVATION_HEIGHT = 2;
const MATURITY = 5;

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isolatedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never inherit a remote database or a mainnet consensus override.
    if (key.startsWith('TURSO_') || key.startsWith('BANNEKER_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

async function request(url, { method = 'GET', body = null, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error */ }
  return { ok: response.ok, status: response.status, json, text };
}

function mine(template) {
  let nonce = 0;
  for (;;) {
    const block = buildCandidate(template, nonce);
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

async function mineNext(origin, miner) {
  const query = new URLSearchParams({ miner });
  const template = await request(`${origin}/api/mining/template?${query}`);
  assert.equal(template.ok, true, `template failed: ${template.text}`);
  const block = mine(template.json);
  const submitted = await request(`${origin}/api/mining/submit`, { method: 'POST', body: block });
  assert.equal(submitted.ok, true, `block ${block.height} rejected: ${submitted.text}`);
  return block;
}

function signedTransaction(pair, recipient, amount, fee, nonce) {
  const payload = {
    sender: base64(pair.publicKey),
    recipient: base64(recipient),
    amount,
    fee,
    nonce,
    timestamp: Date.now()
  };
  const message = JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    String(parseAmount(amount)),
    String(parseAmount(fee)),
    nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    signature: base64(nacl.sign.detached(Buffer.from(message), pair.secretKey))
  };
}

async function waitForNode(child, origin, label, output) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early (code ${child.exitCode}):\n${output.text}`);
    }
    try {
      const health = await request(`${origin}/health`, { timeoutMs: 1_000 });
      if (health.status === 200) return health.json;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      throw new Error(`${label} did not become ready:\n${output.text}`);
    }
    await sleep(50);
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(3_000).then(() => false)
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(3_000)]);
  }
}

const summary = {
  activationHeight: ACTIVATION_HEIGHT,
  coinbaseMaturity: MATURITY,
  networkId: NETWORK_ID,
  blocks: [],
  immatureSpend: null,
  transaction: null,
  sync: null,
  tips: null,
  validation: null,
  recipientBalance: null
};

const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-phase4-testnet-'));
const db1 = path.join(directory, 'testnet-node-1.db');
const db2 = path.join(directory, 'testnet-node-2.db');
const children = [];

function spawnNode(port, dbPath, label) {
  const output = { text: '' };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: isolatedEnv({
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      BANNEKER_DB: dbPath,
      BANNEKER_PEERS: '',
      BANNEKER_V2_ACTIVATION_HEIGHT: String(ACTIVATION_HEIGHT),
      BANNEKER_COINBASE_MATURITY: String(MATURITY),
      BANNEKER_ALLOW_PRIVATE_PEERS: '1',
      NODE_ENV: 'test'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8').on('data', chunk => { output.text += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output.text += chunk; });
  child.label = label;
  children.push(child);
  return { child, output };
}

try {
  const node1 = spawnNode(PORT_1, db1, 'node-1');
  const node2 = spawnNode(PORT_2, db2, 'node-2');

  const health1 = await waitForNode(node1.child, ORIGIN_1, 'node-1', node1.output);
  const health2 = await waitForNode(node2.child, ORIGIN_2, 'node-2', node2.output);

  const nodeInfo1 = (await request(`${ORIGIN_1}/api/node`)).json;
  assert.equal(health1.accountsValid, true);
  assert.equal(health1.ok, true);
  assert.equal(nodeInfo1.v2ActivationHeight, ACTIVATION_HEIGHT);
  assert.equal(nodeInfo1.coinbaseMaturity, MATURITY);
  assert.equal(nodeInfo1.targetBlockSeconds, 60);
  assert.equal(nodeInfo1.halvingInterval, 210_000);
  assert.equal(health2.accountsValid, true);

  const miner = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const minerAddress = base64(miner.publicKey);
  const recipientAddress = base64(recipient.publicKey);

  // --- Era 1 -> Era 2 boundary -------------------------------------------
  const block1 = await mineNext(ORIGIN_1, minerAddress);
  const block2 = await mineNext(ORIGIN_1, minerAddress);
  const block3 = await mineNext(ORIGIN_1, minerAddress);

  assert.equal(block1.height, 1);
  assert.equal(block1.version ?? 1, 1, 'height 1 must remain Era 1');
  assert.equal(block2.height, 2);
  assert.equal(block2.version, 2, 'height 2 must be the first Era 2 block');
  assert.equal(block2.networkId, NETWORK_ID);
  assert.equal(block3.height, 3);
  assert.equal(block3.version, 2);
  summary.blocks = [block1, block2, block3].map(block => ({
    height: block.height,
    version: block.version ?? 1,
    hash: block.hash,
    chainWork: block.chainWork,
    reward: block.reward?.amount ?? null
  }));

  // --- Immature coinbase spend is rejected -------------------------------
  // At tip 3 the next inclusion height is 4. Rewards from heights 2 and 3 are
  // immature (2 + 5 > 4 and 3 + 5 > 4), so only the height-1 reward is
  // spendable. A 100 BNKR spend must be refused.
  const immatureTransaction = signedTransaction(miner, recipient.publicKey, '100', '0.001', 1);
  const immature = await request(`${ORIGIN_1}/api/tx`, {
    method: 'POST',
    body: immatureTransaction
  });
  assert.equal(immature.ok, false, 'immature coinbase spend must be rejected');
  assert.match(immature.text, /spendable confirmed balance|immature/i);
  summary.immatureSpend = {
    tipHeight: 3,
    nextHeight: 4,
    amount: '100',
    status: immature.status,
    rejected: true,
    message: immature.json?.error || immature.text
  };

  // --- Mine past maturity ------------------------------------------------
  for (const expected of [4, 5, 6, 7]) {
    const block = await mineNext(ORIGIN_1, minerAddress);
    assert.equal(block.height, expected);
    assert.equal(block.version, 2);
  }

  // At tip 7 the next inclusion height is 8: rewards from heights 2 and 3 are
  // mature, rewards from 4..7 are not.
  const transfer = signedTransaction(miner, recipient.publicKey, '1', '0.001', 1);
  const accepted = await request(`${ORIGIN_1}/api/tx`, { method: 'POST', body: transfer });
  assert.equal(accepted.ok, true, `valid transfer rejected: ${accepted.text}`);
  assert.equal(accepted.status, 202);
  summary.transaction = {
    sender: transfer.sender,
    recipient: transfer.recipient,
    amount: transfer.amount,
    fee: transfer.fee,
    nonce: transfer.nonce,
    accepted: true,
    status: accepted.status
  };

  const mempool = await request(`${ORIGIN_1}/api/mempool`);
  assert.equal(mempool.json.transactions.length, 1);

  const block8 = await mineNext(ORIGIN_1, minerAddress);
  assert.equal(block8.height, 8);
  assert.equal(block8.version, 2);
  assert.equal(block8.transactions.length, 1);
  assert.equal(block8.transactions[0].signature, transfer.signature);
  summary.blocks.push({
    height: block8.height,
    version: block8.version,
    hash: block8.hash,
    chainWork: block8.chainWork,
    transactions: block8.transactions.length
  });

  // --- Paged peer sync: node 2 <- node 1 ---------------------------------
  const addPeer = await request(`${ORIGIN_2}/api/peers`, {
    method: 'POST',
    body: { url: ORIGIN_1 }
  });
  assert.equal(addPeer.ok, true, `adding peer failed: ${addPeer.text}`);
  const sync = await request(`${ORIGIN_2}/api/peers/sync`, { method: 'POST' });
  assert.equal(sync.ok, true, `sync failed: ${sync.text}`);
  const syncEntry = sync.json.results.find(entry => entry.peer === ORIGIN_1);
  assert.ok(syncEntry, 'sync did not report node 1');
  assert.equal(syncEntry.error, undefined, `sync error: ${syncEntry.error}`);
  summary.sync = {
    from: ORIGIN_1,
    to: ORIGIN_2,
    transport: '/api/peer/blocks (paged)',
    pages: syncEntry.pages ?? null,
    bytes: syncEntry.bytes ?? null,
    replaced: syncEntry.replaced ?? null
  };

  // --- Both nodes must agree ---------------------------------------------
  const [page1, page2] = await Promise.all([
    request(`${ORIGIN_1}/api/peer/blocks?from=8&to=8&page=0`),
    request(`${ORIGIN_2}/api/peer/blocks?from=8&to=8&page=0`)
  ]);
  assert.equal(page1.ok, true);
  assert.equal(page2.ok, true);
  const tip1 = page1.json.blocks[0];
  const tip2 = page2.json.blocks[0];
  assert.equal(tip1.height, 8);
  assert.equal(tip1.hash, block8.hash);
  assert.equal(tip2.hash, tip1.hash);
  assert.equal(tip2.chainWork, tip1.chainWork);

  const [validate1, validate2] = await Promise.all([
    request(`${ORIGIN_1}/api/validate`),
    request(`${ORIGIN_2}/api/validate`)
  ]);
  for (const [label, validate] of [['node-1', validate1], ['node-2', validate2]]) {
    assert.equal(validate.ok, true, `${label} validate failed: ${validate.text}`);
    assert.equal(validate.json.valid, true, `${label} chain invalid: ${validate.json.error}`);
    assert.equal(validate.json.accountsValid, true, `${label} accounts invalid: ${JSON.stringify(validate.json.accountErrors)}`);
    assert.equal(validate.json.height, 8);
    assert.equal(validate.json.healthy, true);
  }

  const [state1, state2] = await Promise.all([
    request(`${ORIGIN_1}/api/state?address=${encodeURIComponent(recipientAddress)}`),
    request(`${ORIGIN_2}/api/state?address=${encodeURIComponent(recipientAddress)}`)
  ]);
  assert.equal(state1.json.height, state2.json.height);
  assert.equal(state1.json.chainWork, state2.json.chainWork);
  assert.equal(state1.json.balance, 1 * COIN);
  assert.equal(state2.json.balance, 1 * COIN);
  assert.equal(state1.json.accountsValid, true);
  assert.equal(state2.json.accountsValid, true);

  summary.tips = {
    node1: { height: state1.json.height, chainWork: state1.json.chainWork, hash: tip1.hash },
    node2: { height: state2.json.height, chainWork: state2.json.chainWork, hash: tip2.hash },
    identical: state1.json.height === state2.json.height &&
      state1.json.chainWork === state2.json.chainWork &&
      tip1.hash === tip2.hash
  };
  summary.validation = {
    node1: { valid: validate1.json.valid, accountsValid: validate1.json.accountsValid, healthy: validate1.json.healthy },
    node2: { valid: validate2.json.valid, accountsValid: validate2.json.accountsValid, healthy: validate2.json.healthy }
  };
  summary.recipientBalance = {
    node1Units: state1.json.balance,
    node2Units: state2.json.balance,
    bnkr: state1.json.balance / COIN
  };

  console.log(JSON.stringify({ ok: true, summary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error?.stack || error?.message || String(error),
    summary
  }, null, 2));
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  await sleep(250);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    .catch(error => console.warn(`Temp cleanup warning: ${error.message}`));
}
