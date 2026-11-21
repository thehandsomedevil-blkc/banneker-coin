// F-07 regression coverage: hardened headers must be present on every response,
// including static assets and error responses.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  SECURITY_HEADERS,
  applySecurityHeaders,
  securityHeadersMiddleware
} from './securityHeaders.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

test('security header values match the hardened production policy', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' https:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*\*/);

  assert.equal(SECURITY_HEADERS['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
});

test('applySecurityHeaders and the middleware set every value and continue the chain', () => {
  const calls = [];
  const res = { set: values => calls.push(values) };
  assert.equal(applySecurityHeaders(res), res);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ...SECURITY_HEADERS });

  let continued = false;
  securityHeadersMiddleware({}, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.deepEqual(calls[1], { ...SECURITY_HEADERS });
  assert.throws(() => applySecurityHeaders(null), /set\(\)/);
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

test('API, static, and error responses all carry the security headers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bnkr-headers-test-'));
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
      NODE_ENV: 'production'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      try {
        const response = await fetch(`${origin}/health`);
        ready = response.status === 200 || response.status === 503;
      } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `server did not start: ${output}`);

    const routes = [
      ['/api/node', undefined],
      ['/health', undefined],
      ['/', undefined],
      ['/api/state', { headers: { origin: 'https://untrusted.example' } }]
    ];
    for (const [route, options] of routes) {
      const response = await fetch(`${origin}${route}`, options);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name.toLowerCase()), value, `${name} missing on ${route}`);
      }
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
