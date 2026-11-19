import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import nacl from 'nacl';
import {
  normalizeClientIp,
  blockedAddressReason,
  assertPeerHostAllowed,
  assertNoDuplicateJsonKeys,
  parseStrictJson,
  readBoundedJson,
  fetchPeerJson,
  PEER_LIMITS,
  PROTECTION_STATUS
} from './security.js';
import { NETWORK_ID, hashBlock } from './ledger.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('rate-limit keys canonicalize IPv4-mapped addresses and group IPv6 clients by /64', () => {
  assert.equal(normalizeClientIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeClientIp('2001:db8:abcd:12::1'), 'v6:2001:db8:abcd:12::/64');
  assert.equal(normalizeClientIp('2001:db8:abcd:0012:ffff::1'), 'v6:2001:db8:abcd:12::/64');
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function withNode(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-api-test-'));
  const port = await unusedPort();
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
    const deadline = Date.now() + 10_000;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test node exited early: ${output}`);
      try {
        const response = await fetch(`${origin}/api/node`);
        ready = response.ok;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!ready) throw new Error(`Test node did not become ready: ${output}`);
    await run(origin);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function signedDustTransaction() {
  const sender = nacl.sign.keyPair();
  const recipient = nacl.sign.keyPair();
  const payload = {
    sender: Buffer.from(sender.publicKey).toString('base64'),
    recipient: Buffer.from(recipient.publicKey).toString('base64'),
    amount: '0.00999999',
    fee: '0.001',
    nonce: 1,
    timestamp: Date.now()
  };
  const message = JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    '999999',
    '100000',
    payload.nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    signature: Buffer.from(nacl.sign.detached(Buffer.from(message), sender.secretKey))
      .toString('base64')
  };
}

function signedTransaction(pair, recipient, amount, nonce, fee = '0.001') {
  const payload = {
    sender: Buffer.from(pair.publicKey).toString('base64'),
    recipient: Buffer.from(recipient).toString('base64'),
    amount,
    fee,
    nonce,
    timestamp: Date.now()
  };
  const message = JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    String(Math.round(Number(amount) * 100_000_000)),
    String(Math.round(Number(fee) * 100_000_000)),
    payload.nonce,
    payload.timestamp
  ]);
  return {
    ...payload,
    signature: Buffer.from(nacl.sign.detached(Buffer.from(message), pair.secretKey)).toString('base64')
  };
}

function mine(template) {
  let nonce = 0;
  while (true) {
    const block = { ...template, nonce };
    const hash = hashBlock(block);
    if (hash.startsWith('0'.repeat(block.difficulty))) return { ...block, hash };
    nonce += 1;
  }
}

test('API rate-limits transaction submission bursts by client IP', async () => {
  await withNode(async origin => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await fetch(`${origin}/api/tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 400);
    }
    const limited = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

test('API rejects dust, oversized JSON, and untrusted browser origins', async () => {
  await withNode(async origin => {
    const nodeInfo = await fetch(`${origin}/api/node`);
    const node = await nodeInfo.json();
    assert.equal(node.chainWork, '0');
    assert.equal(node.networkId, NETWORK_ID);
    assert.equal(node.protocolUpgradeHeight, 136);
    assert.equal(node.protections.rateLimiting, true);
    assert.equal(node.protections.transactionLimitPerMinute, 15);
    assert.equal(node.protections.peerBanning, true);
    assert.equal(nodeInfo.headers.get('x-content-type-options'), 'nosniff');

    const integrityResponse = await fetch(`${origin}/api/validate`);
    const integrity = await integrityResponse.json();
    assert.equal(integrity.valid, true);
    assert.equal(integrity.chainWork, '0');
    assert.equal(integrity.protections.securityHeaders, true);

    const dust = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedDustTransaction())
    });
    assert.equal(dust.status, 400);
    assert.match((await dust.json()).error, /at least 0\.01 BNKR/);

    const future = signedTransactionWithFutureTimestamp();
    const futureResponse = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(future)
    });
    assert.equal(futureResponse.status, 400);
    assert.match((await futureResponse.json()).error, /too far in the future/);

    const oversized = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(65 * 1024) })
    });

    function signedTransactionWithFutureTimestamp() {
      const sender = nacl.sign.keyPair();
      const recipient = nacl.sign.keyPair();
      const payload = {
        sender: Buffer.from(sender.publicKey).toString('base64'),
        recipient: Buffer.from(recipient.publicKey).toString('base64'),
        amount: '1',
        fee: '0.001',
        nonce: 1,
        timestamp: Date.now() + 180_000
      };
      const message = JSON.stringify([
        NETWORK_ID,
        payload.sender,
        payload.recipient,
        '100000000',
        '100000',
        payload.nonce,
        payload.timestamp
      ]);
      return {
        ...payload,
        signature: Buffer.from(nacl.sign.detached(Buffer.from(message), sender.secretKey))
          .toString('base64')
      };
    }
    assert.equal(oversized.status, 413);

    const forbiddenOrigin = await fetch(`${origin}/api/state`, {
      headers: { origin: 'https://untrusted.example' }
    });
    assert.equal(forbiddenOrigin.status, 403);
    assert.equal(forbiddenOrigin.headers.get('x-frame-options'), 'DENY');
  });
});

test('API rejects forged signatures with a clear error without auto-banning the client', async () => {
  await withNode(async origin => {
    const sender = nacl.sign.keyPair();
    const recipient = nacl.sign.keyPair();
    const transaction = {
      sender: Buffer.from(sender.publicKey).toString('base64'),
      recipient: Buffer.from(recipient.publicKey).toString('base64'),
      amount: '1',
      fee: '0.001',
      nonce: 1,
      timestamp: Date.now(),
      signature: Buffer.from(nacl.sign.detached(Buffer.from('not the signed transaction'), sender.secretKey))
        .toString('base64')
    };
    const rejected = await fetch(`${origin}/api/peer/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(transaction)
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /signature verification failed/i);

    const allowed = await fetch(`${origin}/api/node`);
    assert.equal(allowed.status, 200);
  });
});

test('API rejects blocks with invalid proof of work with a clear error without auto-banning the client', async () => {
  await withNode(async origin => {
    const miner = nacl.sign.keyPair();
    const minerAddress = Buffer.from(miner.publicKey).toString('base64');
    const templateResponse = await fetch(`${origin}/api/mining/template?miner=${encodeURIComponent(minerAddress)}`);
    const template = await templateResponse.json();
    const rejected = await fetch(`${origin}/api/peer/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...template, hash: 'f'.repeat(64) })
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /proof of work/i);

    const allowed = await fetch(`${origin}/api/state`);
    assert.equal(allowed.status, 200);
  });
});

test('API accepts and mempools a valid 10 BNKR transfer from the UI payload shape', async () => {
  await withNode(async origin => {
    const miner = nacl.sign.keyPair();
    const recipient = nacl.sign.keyPair();
    const minerAddress = Buffer.from(miner.publicKey).toString('base64');

    const templateResponse = await fetch(`${origin}/api/mining/template?miner=${encodeURIComponent(minerAddress)}`);
    assert.equal(templateResponse.status, 200);
    const template = await templateResponse.json();
    const block = mine(template);
    const submit = await fetch(`${origin}/api/mining/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(block)
    });
    assert.equal(submit.status, 201);

    const tx = signedTransaction(miner, recipient.publicKey, '10', 1, '0.001');
    const response = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tx)
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.transaction.amount, '10');
    assert.equal(body.transaction.fee, '0.001');

    const mempool = await (await fetch(`${origin}/api/mempool`)).json();
    assert.equal(mempool.transactions.length, 1);
    assert.equal(mempool.transactions[0].amount, '10');
    assert.equal(mempool.transactions[0].sender, minerAddress);
  });
});

// ---------------------------------------------------------------------------
// Phase 1: SSRF screening, strict JSON, and bounded peer reads
// ---------------------------------------------------------------------------

test('peer screening blocks loopback, private, link-local, metadata, multicast, and unspecified addresses', async () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1', '239.255.255.255', '255.255.255.255',
    '::1', '::',
    '::ffff:169.254.169.254', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1'
  ];
  for (const address of blocked) {
    assert.ok(blockedAddressReason(address), `${address} should be blocked`);
    await assert.rejects(
      assertPeerHostAllowed(address),
      error => error.code === 'PEER_ADDRESS_BLOCKED',
      `${address} should be refused`
    );
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(blockedAddressReason(address), null, `${address} should be allowed`);
  }
});

test('private-address relaxation is opt-in and never unblocks multicast or unspecified ranges', async () => {
  assert.equal(blockedAddressReason('127.0.0.1', { allowPrivate: true }), null);
  assert.equal(blockedAddressReason('10.1.2.3', { allowPrivate: true }), null);
  assert.equal(blockedAddressReason('fe80::1', { allowPrivate: true }), null);
  assert.ok(blockedAddressReason('224.0.0.1', { allowPrivate: true }));
  assert.ok(blockedAddressReason('0.0.0.0', { allowPrivate: true }));

  const records = await assertPeerHostAllowed('127.0.0.1', { allowPrivate: true });
  assert.equal(records[0].address, '127.0.0.1');
});

test('hostname screening refuses a name when any resolved address is private', async () => {
  const mixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 }
  ];
  await assert.rejects(
    assertPeerHostAllowed('example.test', { lookup: mixed }),
    error => error.code === 'PEER_ADDRESS_BLOCKED'
  );

  const publicOnly = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.deepEqual(
    await assertPeerHostAllowed('example.test', { lookup: publicOnly }),
    [{ address: '93.184.216.34', family: 4 }]
  );

  const unresolvable = async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
  await assert.rejects(
    assertPeerHostAllowed('missing.test', { lookup: unresolvable }),
    error => error.code === 'PEER_RESOLUTION_FAILED'
  );
});

test('strict JSON rejects duplicate keys at every nesting level', () => {
  assert.throws(() => assertNoDuplicateJsonKeys('{"a":1,"a":2}'), error => error.code === 'DUPLICATE_JSON_KEY');
  assert.throws(() => assertNoDuplicateJsonKeys('{"a":{"b":1,"b":2}}'), error => error.code === 'DUPLICATE_JSON_KEY');
  assert.throws(() => assertNoDuplicateJsonKeys('{"a":[{"x":1}],"a":[]}'), error => error.code === 'DUPLICATE_JSON_KEY');
  assert.throws(() => assertNoDuplicateJsonKeys('{"a":1,"\\u0061":2}'), error => error.code === 'DUPLICATE_JSON_KEY');
  assert.doesNotThrow(() => assertNoDuplicateJsonKeys('{"a":[{"x":1},{"x":2}],"b":null}'));

  assert.throws(() => assertNoDuplicateJsonKeys('{"a":1} trailing'), error => error.code === 'JSON_INVALID');
  assert.throws(() => assertNoDuplicateJsonKeys('{"a":1'), error => error.code === 'JSON_INVALID');
  assert.throws(() => assertNoDuplicateJsonKeys(''), error => error.code === 'JSON_INVALID');

  let nested = '';
  for (let depth = 0; depth < 10; depth += 1) nested += '{"k":';
  nested += '1' + '}'.repeat(10);
  assert.throws(() => assertNoDuplicateJsonKeys(nested, { maxDepth: 4 }), error => error.code === 'JSON_TOO_DEEP');

  assert.deepEqual(parseStrictJson('{"a":[1,2,{"b":"c"}]}'), { a: [1, 2, { b: 'c' }] });
});

test('bounded peer reads abort oversized bodies and reject non-JSON content types', async () => {
  const ok = new Response(JSON.stringify({ chain: [] }), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
  assert.deepEqual(await readBoundedJson(ok, { maxBytes: 1024 }), { chain: [] });

  const oversized = new Response(`{"chain":"${'x'.repeat(4096)}"}`, {
    headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(
    readBoundedJson(oversized, { maxBytes: 256 }),
    error => error.code === 'PEER_RESPONSE_TOO_LARGE'
  );

  const declaredTooLarge = {
    headers: new Headers({ 'content-type': 'application/json', 'content-length': '2048' }),
    body: null
  };
  await assert.rejects(
    readBoundedJson(declaredTooLarge, { maxBytes: 256 }),
    error => error.code === 'PEER_RESPONSE_TOO_LARGE'
  );

  const html = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    readBoundedJson(html, { maxBytes: 1024 }),
    error => error.code === 'PEER_CONTENT_TYPE_INVALID'
  );

  const duplicate = new Response('{"a":1,"a":2}', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    readBoundedJson(duplicate, { maxBytes: 1024 }),
    error => error.code === 'PEER_JSON_INVALID'
  );
});

async function withPeerServer(run) {
  const server = createHttpServer((req, res) => {
    res.on('error', () => {});
    if (req.url === '/node') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'The Banneker Coin', ticker: 'BNKR' }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/node' });
      res.end();
      return;
    }
    if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"chain":"');
      for (let index = 0; index < 8; index += 1) res.write('x'.repeat(16 * 1024));
      res.end('"}');
      return;
    }
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('peer transport refuses private hosts by default, rejects redirects, and caps the body', async () => {
  await withPeerServer(async origin => {
    await assert.rejects(
      fetchPeerJson(`${origin}/node`),
      error => error.code === 'PEER_ADDRESS_BLOCKED'
    );

    const info = await fetchPeerJson(`${origin}/node`, { allowPrivate: true });
    assert.equal(info.ticker, 'BNKR');

    await assert.rejects(
      fetchPeerJson(`${origin}/redirect`, { allowPrivate: true }),
      error => error.code === 'PEER_REDIRECT_REFUSED'
    );

    await assert.rejects(
      fetchPeerJson(`${origin}/huge`, { allowPrivate: true, maxBytes: 1024 }),
      error => error.code === 'PEER_RESPONSE_TOO_LARGE'
    );

    await assert.rejects(
      fetchPeerJson(`${origin}/html`, { allowPrivate: true }),
      error => error.code === 'PEER_CONTENT_TYPE_INVALID'
    );
  });
});

test('API rejects duplicate JSON keys before a handler can act on them', async () => {
  await withNode(async origin => {
    const duplicate = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sender":"a","sender":"b","recipient":"c","amount":"1","fee":"0.001","nonce":1,"timestamp":1,"signature":"x"}'
    });
    assert.equal(duplicate.status, 400);
    const body = await duplicate.json();
    assert.equal(body.code, 'DUPLICATE_JSON_KEY');
    assert.match(body.error, /Duplicate JSON object key "sender"/);

    const malformed = await fetch(`${origin}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sender":"a",}'
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'JSON_INVALID');
  });
});

test('block routes admit bodies above 64 KiB without raising the limit everywhere', async () => {
  await withNode(async origin => {
    const largeBody = JSON.stringify({ payload: 'x'.repeat(100 * 1024) });

    const blockResponse = await fetch(`${origin}/api/mining/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: largeBody
    });
    // Rejected by block validation, not by the body parser.
    assert.equal(blockResponse.status, 400);
    assert.notEqual((await blockResponse.json()).code, 'BODY_TOO_LARGE');

    const oversizeBlock = await fetch(`${origin}/api/mining/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(9 * 1024 * 1024) })
    });
    assert.equal(oversizeBlock.status, 413);
    assert.equal((await oversizeBlock.json()).code, 'BODY_TOO_LARGE');

    const sharedRoute = await fetch(`${origin}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: largeBody
    });
    assert.equal(sharedRoute.status, 413);
  });
});

test('block admission bound is 8 MiB while the shared API bound stays 64 KiB', () => {
  assert.equal(PEER_LIMITS.maxBlockBytes, 8 * 1024 * 1024);
  assert.equal(PROTECTION_STATUS.maxJsonBodyBytes, 64 * 1024);
  assert.equal(PROTECTION_STATUS.maxBlockBytes, PEER_LIMITS.maxBlockBytes);
  assert.equal(PROTECTION_STATUS.peerRedirectPolicy, 'error');
  assert.equal(PROTECTION_STATUS.duplicateJsonKeys, 'rejected');
});
