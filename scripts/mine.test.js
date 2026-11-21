import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  backoffDelay,
  parseArgs,
  parseRetryAfter,
  runMiner,
  withRetry
} from './mine.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicKey = Buffer.alloc(32, 7).toString('base64');

function jsonResponse(status, body, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (name === 'retry-after' ? retryAfter : null) },
    text: async () => JSON.stringify(body),
    body
  };
}

function templateAt(height, miner = publicKey) {
  return {
    height,
    timestamp: 1_700_000_000_000,
    prevHash: 'a'.repeat(64),
    difficulty: 1,
    miner,
    transactions: [],
    reward: { recipient: miner, amount: '50.00000000' },
    message: null
  };
}

const stubBuild = (template, nonce) => ({ height: template.height, nonce, difficulty: template.difficulty });
const stubHash = () => '0proof';

test('parseArgs applies safe defaults and parses all mining flags', () => {
  const defaults = parseArgs(['--miner', publicKey]);
  assert.equal(defaults.origin, 'http://127.0.0.1:4174');
  assert.equal(defaults.maxBlocks, 1);
  assert.equal(defaults.maxHeight, null);
  assert.equal(defaults.delayMs, DEFAULT_DELAY_MS);
  assert.equal(defaults.timeoutMs, DEFAULT_TIMEOUT_MS);

  const configured = parseArgs([
    '--miner', publicKey,
    '--origin', 'https://node.example/',
    '--blocks', '0',
    '--max-height', '5000',
    '--delay', '1500',
    '--timeout', '1234'
  ], { BNKR_NODE_URL: 'https://ignored.example' });
  assert.equal(configured.origin, 'https://node.example');
  assert.equal(configured.maxBlocks, Infinity);
  assert.equal(configured.maxHeight, 5000);
  assert.equal(configured.delayMs, 1500);
  assert.equal(configured.timeoutMs, 1234);

  const fromEnv = parseArgs(['--miner', publicKey], { BNKR_NODE_URL: 'https://env.example/' });
  assert.equal(fromEnv.origin, 'https://env.example');
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs rejects invalid flags instead of starting an unsafe run', () => {
  assert.throws(() => parseArgs([]), /--miner/);
  assert.throws(() => parseArgs(['--miner', 'not-a-key']), /32-byte/);
  assert.throws(() => parseArgs(['--miner', publicKey, '--delay', '-5']), /--delay/);
  assert.throws(() => parseArgs(['--miner', publicKey, '--timeout', '0']), /--timeout/);
  assert.throws(() => parseArgs(['--miner', publicKey, '--max-height', '1.5']), /--max-height/);
  assert.throws(() => parseArgs(['--miner', publicKey, '--delay']), /--delay needs a value/);
});

test('Retry-After parsing and exponential backoff are bounded', () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:27:50 GMT');
  assert.equal(parseRetryAfter('12'), 12000);
  assert.equal(parseRetryAfter('0.025'), 25);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now), 10000);
  assert.equal(parseRetryAfter('garbage', now), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(backoffDelay(0, 1000, 30_000), 1000);
  assert.equal(backoffDelay(3, 1000, 30_000), 8000);
  assert.equal(backoffDelay(20, 1000, 30_000), 30_000);
});

test('withRetry honors Retry-After on 429 and backs off on transient 503', async () => {
  const sleeps = [];
  const attempts = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) return { status: 429, ok: false, retryAfterMs: 25, text: 'rate limited' };
    if (calls === 2) return { status: 503, ok: false, retryAfterMs: null, text: 'unavailable' };
    return { status: 200, ok: true, body: { done: true } };
  }, {
    sleep: async ms => sleeps.push(ms),
    onRetry: detail => attempts.push(detail),
    baseDelayMs: 5,
    maxDelayMs: 100
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 10]);
  assert.equal(attempts[0].status, 429);
  assert.equal(attempts[1].status, 503);
});

test('withRetry retries network timeouts but leaves non-retryable statuses to the caller', async () => {
  let calls = 0;
  const recovered = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('The operation was aborted due to timeout');
    return { status: 200, ok: true };
  }, { sleep: async () => {}, baseDelayMs: 1, maxDelayMs: 1 });
  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);

  let badCalls = 0;
  const stale = await withRetry(async () => {
    badCalls += 1;
    return { status: 400, ok: false, text: 'stale height' };
  }, { sleep: async () => {} });
  assert.equal(stale.status, 400);
  assert.equal(badCalls, 1);

  await assert.rejects(
    withRetry(async () => { throw new Error('offline'); }, { retries: 2, sleep: async () => {} }),
    /offline/
  );
});

test('runMiner stops cleanly at --max-height without submitting a block', async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    return jsonResponse(200, templateAt(6));
  };
  const result = await runMiner(
    { origin: 'https://node', miner: publicKey, maxHeight: 5, maxBlocks: 5 },
    { fetchImpl, sleep: async () => {}, log: message => logs.push(message) }
  );

  assert.equal(result.stoppedByMaxHeight, true);
  assert.equal(result.mined, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/mining\/template/);
  assert.ok(logs.some(message => /max-height 5/.test(message)));
});

test('runMiner refetches a fresh template after a stale 400 instead of crashing', async () => {
  let templateCalls = 0;
  let submitCalls = 0;
  const logs = [];
  const fetchImpl = async url => {
    if (String(url).includes('/api/mining/template')) {
      templateCalls += 1;
      return jsonResponse(200, templateAt(templateCalls === 1 ? 2 : 5));
    }
    submitCalls += 1;
    if (submitCalls === 1) {
      return jsonResponse(400, { error: 'Block height does not extend the current chain.' });
    }
    return jsonResponse(200, { height: 2 });
  };

  const result = await runMiner(
    { origin: 'https://node', miner: publicKey, maxBlocks: 5, maxHeight: 4, delayMs: 1 },
    {
      fetchImpl,
      sleep: async () => {},
      log: message => logs.push(message),
      build: stubBuild,
      hash: stubHash,
      retryOptions: { sleep: async () => {}, baseDelayMs: 1, maxDelayMs: 1 }
    }
  );

  assert.equal(result.stoppedByMaxHeight, true);
  assert.equal(result.mined, 0);
  assert.equal(templateCalls, 2);
  assert.equal(submitCalls, 1);
  assert.ok(logs.some(message => /Stale template/.test(message)));
});

test('runMiner waits the configured delay between successful blocks', async () => {
  let submitCalls = 0;
  const sleeps = [];
  const fetchImpl = async url => {
    if (String(url).includes('/api/mining/template')) return jsonResponse(200, templateAt(2));
    submitCalls += 1;
    return jsonResponse(200, { height: 2 });
  };

  const result = await runMiner(
    { origin: 'https://node', miner: publicKey, maxBlocks: 2, delayMs: 2500 },
    {
      fetchImpl,
      sleep: async ms => sleeps.push(ms),
      log: () => {},
      build: stubBuild,
      hash: stubHash,
      retryOptions: { sleep: async () => {} }
    }
  );

  assert.equal(result.mined, 2);
  assert.equal(submitCalls, 2);
  assert.deepEqual(sleeps, [2500]);
});

test('CLI process exits 0 when the chain already meets --max-height', async () => {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/mining/template')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(templateAt(6)));
      return;
    }
    response.writeHead(500);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const child = spawn(process.execPath, [
      'scripts/mine.mjs',
      '--miner', publicKey,
      '--origin', `http://127.0.0.1:${port}`,
      '--max-height', '5'
    ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    assert.equal(code, 0);
    assert.match(stdout, /max-height 5/);
    assert.match(stdout, /Mined 0 block\(s\)/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
