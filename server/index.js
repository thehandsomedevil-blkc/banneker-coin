import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLedgerWithRetry,
  MAX_SUPPLY,
  COIN,
  HALVING_INTERVAL,
  TARGET_BLOCK_SECONDS,
  PROTOCOL_UPGRADE_HEIGHT
} from './ledger.js';
import {
  createRateLimiter,
  normalizeClientIp,
  PROTECTION_STATUS,
  PEER_LIMITS,
  assertNoDuplicateJsonKeys,
  assertPeerHostAllowed,
  fetchPeer,
  fetchPeerJson,
  isPublicAdvertisedOrigin,
  parsePeerUrl
} from './security.js';
import {
  MAX_PAGE_BLOCKS,
  buildBlockPage,
  fetchPeerChain
} from './paging.js';
import { securityHeadersMiddleware } from './securityHeaders.js';
import { resolveBuildIdentity } from './buildIdentity.js';
import {
  createFaultRecorder,
  registrationFaultIdentifiers,
  submissionFaultIdentifiers
} from './peerFaults.js';

const app = express();
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || '0.0.0.0'; // Changed from 127.0.0.1 for production

// The URL this node advertises to peers. PUBLIC_URL is canonical; SELF_URL and
// NODE_URL are accepted so a second node needs no code edits when the platform
// uses a different variable name.
const advertisedUrl = process.env.PUBLIC_URL || process.env.SELF_URL || process.env.NODE_URL;
const publicUrl = (advertisedUrl && String(advertisedUrl).trim())
  ? String(advertisedUrl).trim().replace(/\/+$/, '')
  : `http://${host}:${port}`;

// DB_PATH is the neutral alias for a second node; the legacy BANNEKER_DB and
// BLACKCOIN_DB names keep working. Every .db file stays outside version control.
const dbPath = process.env.BANNEKER_DB || process.env.BLACKCOIN_DB || process.env.DB_PATH ||
  path.resolve(process.cwd(), 'bannekercoin.db');

// Explicit local-testing escape hatch for the peer SSRF screen. It relaxes
// loopback/private/link-local ranges only; multicast and unspecified ranges
// stay blocked. It must never be set on a production node.
const allowPrivatePeers = /^(?:1|true|yes|on)$/i.test(String(
  process.env.ALLOW_LOCAL_PEERS || process.env.BANNEKER_ALLOW_PRIVATE_PEERS || ''
).trim());

// A node must not try to register an internal default origin with a peer.
// Without an explicit public HTTPS URL we still serve the site and can pull
// from seeds, but we skip outbound registration instead of emitting a
// http://0.0.0.0:$PORT identity that another node correctly rejects as self.
const canAdvertisePublicly = Boolean(advertisedUrl) &&
  (allowPrivatePeers || isPublicAdvertisedOrigin(publicUrl));
if (process.env.NODE_ENV === 'production' && !allowPrivatePeers && !canAdvertisePublicly) {
  console.warn('PUBLIC_URL is missing or not a public HTTPS origin; peer registration is disabled. Set PUBLIC_URL to this node\'s external URL.');
}

function positiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Peer tables are independent per node, so a failed startup POST leaves a
// one-way edge until something retries. The periodic loop re-registers with
// seeds and known peers on a per-peer cooldown, and also asks known peers for
// the peers they know so missing transitive edges can be learned. The env
// overrides exist for tests and slow environments; production defaults are
// five minutes and 30 seconds respectively.
const registrationRetryMs = positiveIntEnv('PEER_REGISTRATION_RETRY_MS', 300_000);
const peerMaintenanceIntervalMs = positiveIntEnv('PEER_MAINTENANCE_INTERVAL_MS', 30_000);
const maxDiscoveredPeers = positiveIntEnv('MAX_DISCOVERED_PEERS', 32);
const registrationLastAttempt = new Map();
const registrationInFlight = new Set();
const discoveryInFlight = new Set();
const verifiedDiscoveryOrigins = new Set();
const MAX_PEER_LIST_RESPONSE_BYTES = 64 * 1024;

// Build identity is resolved from platform env vars or the checked-out git HEAD
// and reported verbatim by /api/node and /health. No secrets are included.
const { buildId, sourceCommit } = resolveBuildIdentity();
const storageKind = process.env.TURSO_DATABASE_URL ? 'turso' : 'local';
const buildIdentity = Object.freeze({ buildId, sourceCommit, storage: storageKind });

// A per-process ID lets a node recognize its own public URL even when
// PUBLIC_URL is missing. URL-based self checks only know the local fallback
// origin, so a hosted node could otherwise learn its own Render URL as a peer.
const instanceId = randomUUID();

const PERMANENT_SYNC_CODES = new Set([
  'PEER_ADDRESS_BLOCKED',
  'PEER_URL_INVALID',
  'PEER_CONTENT_TYPE_INVALID',
  'PEER_REDIRECT_REFUSED',
  'NETWORK_ID_MISMATCH',
  'GENESIS_MISMATCH',
  'CHECKPOINT_VIOLATION',
  'CHECKPOINT_SET_MISMATCH',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'CHAIN_TOO_LONG',
  'CHAIN_TOO_LARGE',
  'HEIGHT_GAP',
  'ERA_VIOLATION'
]);

function isPermanentSyncError(error) {
  const code = error?.code;
  if (typeof code !== 'string') return false;
  return PERMANENT_SYNC_CODES.has(code) || code.startsWith('PAGE_');
}

function parsePageHeight(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    const error = new Error(`${name} must be a non-negative decimal integer.`);
    error.code = 'PAGE_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const height = Number(text);
  if (!Number.isSafeInteger(height)) {
    const error = new Error(`${name} is outside the safe integer range.`);
    error.code = 'PAGE_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return height;
}

// The port is bound before any database work begins. Until this resolves,
// /health and /api requests receive 503 INITIALIZING instead of taking the
// process down with an unhandled Turso socket error.
const BACKGROUND_RETRY_MS = 30_000;
let ledger = null;
let ledgerInitError = null;
let ledgerRetryAt = null;
let backgroundRetryTimer = null;
let initializationInFlight = false;
let shuttingDown = false;
const faultRecorder = createFaultRecorder(() => ledger);

function stopBackgroundRetry() {
  if (backgroundRetryTimer) clearTimeout(backgroundRetryTimer);
  backgroundRetryTimer = null;
  ledgerRetryAt = null;
}

function scheduleBackgroundRetry() {
  if (shuttingDown || ledger || backgroundRetryTimer) return;
  ledgerRetryAt = Date.now() + BACKGROUND_RETRY_MS;
  backgroundRetryTimer = setTimeout(() => {
    backgroundRetryTimer = null;
    void initializeLedger({ background: true });
  }, BACKGROUND_RETRY_MS);
  backgroundRetryTimer.unref();
  console.warn(`Ledger initialization failed; retrying in ${BACKGROUND_RETRY_MS / 1000}s.`);
}

async function initializeLedger({ background = false } = {}) {
  if (initializationInFlight || ledger || shuttingDown) return;
  initializationInFlight = true;
  try {
    ledger = await createLedgerWithRetry(dbPath, {}, {
      attempts: 10,
      maxDelayMs: 10_000,
      label: background ? 'Background ledger initialization' : 'Ledger initialization',
      onRetry: ({ attempt, attempts, delayMs, error }) => {
        console.warn(`Ledger initialization failed (attempt ${attempt}/${attempts}): ${error?.message || error}. Retrying in ${delayMs}ms...`);
      }
    });
    ledgerInitError = null;
    stopBackgroundRetry();
    if (shuttingDown) {
      ledger.close();
      ledger = null;
      return;
    }
    console.log(background ? 'Ledger initialized after background retry.' : 'Ledger initialized.');
    await startPeerSync();
  } catch (error) {
    ledgerInitError = error;
    console.error(`${background ? 'Background ledger retry' : 'Ledger initialization'} failed after all attempts: ${error?.message || error}`);
    scheduleBackgroundRetry();
  } finally {
    initializationInFlight = false;
  }
}

// Seed peers. SEED_PEERS is the neutral name used by the Node B template; the
// legacy BANNEKER_PEERS / BLACKCOIN_PEERS names remain supported.
const configuredPeers = [...new Set(
  (process.env.SEED_PEERS || process.env.PEERS || process.env.BANNEKER_PEERS || process.env.BLACKCOIN_PEERS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
)];

// Origins that identify this node. Used by both the seed bootstrap and the
// registration endpoint so a node can never add or sync from itself.
const selfOrigins = new Set([
  publicUrl.toLowerCase(),
  `http://127.0.0.1:${port}`.toLowerCase(),
  `http://localhost:${port}`.toLowerCase(),
  `http://0.0.0.0:${port}`.toLowerCase()
]);

function isSelfPeer(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  return selfOrigins.has(origin.trim().replace(/\/+$/, '').toLowerCase());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.disable('x-powered-by');
// Trust the upstream proxy chain unconditionally so req.ip and rate-limiting
// use the real client from X-Forwarded-For instead of a shared load-balancer IP.
app.set('trust proxy', true);
const trustProxyHops = process.env.TRUST_PROXY_HOPS;
if (trustProxyHops !== undefined && String(trustProxyHops).trim() !== '') {
  const hops = Number(trustProxyHops);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  }
  app.set('trust proxy', hops);
}

app.use(securityHeadersMiddleware);

// Configure static files BEFORE API middleware to avoid 403s on assets
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(webRoot));

app.use((req, res, next) => {
  // If request is not for /api or /health, serve index.html. /health is a
  // supervisor endpoint and must never be answered with the SPA shell.
  if (req.method === 'GET' && req.path !== '/health' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(webRoot, 'index.html'));
  }
  next();
});

// Readiness gate. Render only needs the socket to open; this keeps the process
// alive while Turso wakes and makes the initializing state explicit to clients.
app.use((req, res, next) => {
  const isApi = req.path.startsWith('/api');
  const isHealth = req.path === '/health' || req.path.startsWith('/health/');
  if (!isApi && !isHealth) return next();
  if (ledger) return next();
  res.set('Cache-Control', 'no-store');
  if (ledgerInitError) {
    const retryInSeconds = ledgerRetryAt === null
      ? null
      : Math.max(0, Math.ceil((ledgerRetryAt - Date.now()) / 1000));
    return res.status(503).json({
      ok: false,
      reason: 'INITIALIZATION_FAILED',
      ...(retryInSeconds !== null ? { retryInSeconds } : {}),
      error: ledgerInitError?.message || 'Ledger initialization failed.'
    });
  }
  return res.status(503).json({ ok: false, reason: 'INITIALIZING' });
});

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
);
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.add('http://127.0.0.1:5173');
  allowedOrigins.add('http://localhost:5173');
}

app.use('/api', createRateLimiter({ limit: PROTECTION_STATUS.apiLimitPerMinute }));
app.use('/api/mining/submit', createRateLimiter({ limit: 30 }));
const transactionLimiter = createRateLimiter({
  limit: PROTECTION_STATUS.transactionLimitPerMinute
});
app.use('/api/tx', transactionLimiter);
app.use('/api/peer/tx', transactionLimiter);
const readLimiter = createRateLimiter({ limit: PROTECTION_STATUS.readLimitPerMinute });
app.use(['/api/state', '/api/blocks', '/api/validate', '/api/peer/chain', '/api/peer/blocks', '/health'], readLimiter);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return res.status(403).json({ error: 'Origin is not allowed.' });
    }
    const sameOrigin = `${req.protocol}://${req.get('host')}` === originUrl.origin;
    if (!sameOrigin && !allowedOrigins.has(originUrl.origin)) {
      return res.status(403).json({ error: 'Origin is not allowed.' });
    }
    res.set('Access-Control-Allow-Origin', originUrl.origin);
    res.vary('Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

async function peerIdentity(req) {
  const source = req.get('origin-peer');
  if (!source) return null;
  try {
    const origin = cleanPeerUrl(source);
    const peers = await ledger.getPeers();
    return peers.some(peer => peer.url === origin) ? `peer:${origin}` : null;
  } catch {
    return null;
  }
}

app.use('/api', async (req, res, next) => {
  const identifiers = [`ip:${normalizeClientIp(req.ip || req.socket.remoteAddress)}`];
  const source = await peerIdentity(req);
  if (source) identifiers.push(source);
  for (const identifier of identifiers) {
    const ban = await ledger.isPeerBanned(identifier);
    if (ban) {
      return res.status(403).json({
        error: 'This client is temporarily banned for invalid consensus submissions.',
        bannedUntil: ban.bannedUntil,
        score: ban.score
      });
    }
  }
  next();
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Body parser that additionally rejects duplicate JSON keys. The check runs in
// the `verify` hook, before express.json hands a last-wins object to any route,
// so { "amount": "1", "amount": "1000" } can never be smuggled past a handler.
function strictJsonParser({ limit }) {
  const parser = express.json({
    limit,
    strict: true,
    type: 'application/json',
    verify: (req, _res, buffer) => {
      try {
        assertNoDuplicateJsonKeys(buffer.toString('utf8'));
      } catch (error) {
        if (!Number.isInteger(error.statusCode)) error.statusCode = 400;
        req.strictJsonError = error;
      }
    }
  });
  return (req, res, next) => parser(req, res, error => {
    if (error) return next(error);
    if (req.strictJsonError) return next(req.strictJsonError);
    return next();
  });
}

// Two parsers, two bounds, one validator (correction spec §3.7, §14.8). The
// global /api limit stays at 64 KiB so /api/state and /api/tx cannot be used
// as an 8 MiB denial-of-service multiplier. Only the block routes get the
// 8 MiB admission bound that matches MAX_BLOCK_PREIMAGE_BYTES.
const blockJsonParser = strictJsonParser({ limit: PEER_LIMITS.maxBlockBytes });
const apiJsonParser = strictJsonParser({ limit: PROTECTION_STATUS.maxJsonBodyBytes });
app.use(['/api/mining/submit', '/api/peer/block'], blockJsonParser);
app.use('/api', apiJsonParser);

// Express skips ordinary middleware after a parser error, so this error handler
// must sit immediately after the parsers to fault malformed peer payloads.
app.use('/api/peer', async (error, req, _res, next) => {
  const source = await peerIdentity(req);
  await faultRecorder.recordMany(
    submissionFaultIdentifiers(req, source),
    `malformed peer payload: ${error?.code || error?.type || 'INVALID_JSON'}`,
    1
  );
  next(error);
});

const cleanPeerUrl = value => parsePeerUrl(value).origin;

let cachedSeedOrigins = null;
function seedPeerOrigins() {
  if (cachedSeedOrigins) return cachedSeedOrigins;
  const origins = [];
  for (const seed of configuredPeers) {
    try {
      const origin = cleanPeerUrl(seed);
      if (isSelfPeer(origin)) {
        console.warn(`Ignoring self seed ${seed}.`);
        continue;
      }
      origins.push(origin);
    } catch (error) {
      console.warn(`Ignoring invalid seed ${seed}: ${error?.message || error}`);
    }
  }
  cachedSeedOrigins = origins;
  return origins;
}

/**
 * A remote origin is only usable as a peer when it advertises the same
 * compiled network identity. This is shared by inbound registration and
 * transitive discovery so neither path can add a lookalike service.
 */
function isCompatiblePeerInfo(info) {
  const identity = ledger.getChainIdentity();
  return info?.name === 'The Banneker Coin' &&
    info?.ticker === 'BNKR' &&
    info?.networkId === identity.networkId &&
    info?.genesisHash === identity.genesisHash &&
    info?.protocolVersion === identity.protocolVersion &&
    info?.checkpointSetDigest === identity.checkpointSetDigest &&
    info?.v2ActivationHeight === identity.v2ActivationHeight;
}

async function acceptSubmission(req, kind, accept) {
  try {
    return await accept();
  } catch (error) {
    // Invalid signatures, hashes, checkpoints and malformed consensus payloads
    // now count toward the advertised peer ban instead of being free probes.
    const code = typeof error?.code === 'string' ? error.code : 'INVALID_SUBMISSION';
    const reason = `${kind} rejected: ${code}`;
    const source = req?.get ? await peerIdentity(req) : null;
    await faultRecorder.recordMany(submissionFaultIdentifiers(req, source), reason, 1);
    throw error;
  }
}

/**
 * Registers this node with a remote peer. The remote re-verifies our identity
 * by fetching /api/node from the advertised URL, so a successful 2xx means the
 * peer has added us to its own peer list — this is the reverse half of
 * bidirectional discovery.
 */
async function registerWithPeer(peer) {
  if (!canAdvertisePublicly) {
    console.warn(`Not registering with ${peer}: PUBLIC_URL is not a public HTTPS origin.`);
    return false;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchPeer(`${peer}/api/peers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin-peer': publicUrl },
        body: JSON.stringify({ url: publicUrl }),
        timeoutMs: 8_000,
        allowPrivate: allowPrivatePeers
      });
      try { await response.body?.cancel(); } catch {}
      if (!response.ok) throw new Error(`Peer registration returned HTTP ${response.status}.`);
      registrationLastAttempt.set(peer, Date.now());
      await ledger.updatePeer(peer);
      console.log(`Registered with peer ${peer}.`);
      return true;
    } catch (error) {
      if (attempt >= 3) {
        registrationLastAttempt.set(peer, Date.now());
        try { await ledger.updatePeer(peer, error.message); } catch {}
        console.warn(`Could not register with peer ${peer}: ${error.message}`);
        return false;
      }
      await sleep(1000 * attempt);
    }
  }
  return false;
}

/**
 * Seeds are applied only after the ledger exists. The previous top-level loop
 * ran before initialization and silently failed on every configured peer.
 */
async function bootstrapPeers() {
  for (const peer of configuredPeers) {
    let origin;
    try {
      origin = cleanPeerUrl(peer);
      if (isSelfPeer(origin)) {
        console.warn(`Skipping self peer ${peer}.`);
        continue;
      }
      await assertPeerHostAllowed(new URL(origin).hostname, { allowPrivate: allowPrivatePeers });
      await ledger.addPeer(origin);
    } catch (error) {
      console.warn(`Skipping configured peer ${peer}: ${error?.message || error}`);
      continue;
    }
    await registerWithPeer(origin);
  }
}

/**
 * Learns peers that our peers already know. This closes gaps such as
 * canonical ↔ node-b ↔ black without dashboard changes: canonical asks
 * node-b for its peer table, verifies the returned origin directly, and adds
 * it locally. The retry pass that follows registers with the new peer, which
 * creates the missing reverse edge on that peer.
 *
 * Discovery is deliberately narrow: origins come only from peers we already
 * trust enough to sync from, are normalized as bare origins, screened against
 * SSRF targets, and must serve a compatible /api/node identity before use.
 */
async function discoverTransitivePeers() {
  // Discovery only reads peers we already have and adds what we learn locally.
  // It must work even when this node cannot advertise itself; only the
  // registration retry below depends on a valid public PUBLIC_URL.
  if (!ledger) return;

  let knownPeers;
  try {
    knownPeers = await ledger.getPeers();
  } catch (error) {
    console.warn(`Peer discovery skipped: unable to read peers (${error?.message || error})`);
    return;
  }

  const known = new Set(knownPeers.map(peer => peer.url));
  let added = 0;

  for (const source of known) {
    if (added >= maxDiscoveredPeers) break;
    if (isSelfPeer(source) || discoveryInFlight.has(source)) continue;

    discoveryInFlight.add(source);
    try {
      await assertPeerHostAllowed(new URL(source).hostname, { allowPrivate: allowPrivatePeers });

      // A hosted node without PUBLIC_URL cannot recognize its own external
      // hostname by URL. The per-process ID is authoritative: if this source
      // answers with our ID, the entry is stale self-peering and is removed.
      let self = false;
      try {
        const info = await fetchPeerJson(`${source}/api/node`, {
          maxBytes: PEER_LIMITS.maxPeerNodeInfoBytes,
          timeoutMs: 5_000,
          allowPrivate: allowPrivatePeers
        });
        self = info?.instanceId === instanceId;
      } catch (error) {
        console.warn(`Self-check for ${source} failed: ${error?.message || error}`);
      }
      if (self) {
        await ledger.removePeer(source);
        known.delete(source);
        verifiedDiscoveryOrigins.delete(source);
        console.log(`Removed self peer ${source}.`);
        continue;
      }

      const payload = await fetchPeerJson(`${source}/api/peers`, {
        maxBytes: MAX_PEER_LIST_RESPONSE_BYTES,
        timeoutMs: 5_000,
        allowPrivate: allowPrivatePeers
      });
      const entries = Array.isArray(payload) ? payload : payload?.peers;
      if (!Array.isArray(entries)) throw new Error('Peer list is not an array.');

      for (const entry of entries.slice(0, maxDiscoveredPeers)) {
        if (added >= maxDiscoveredPeers) break;
        const value = typeof entry === 'string' ? entry : entry?.url;
        if (typeof value !== 'string' || !value.trim()) continue;

        try {
          const origin = cleanPeerUrl(value);
          if (isSelfPeer(origin) || origin === source || known.has(origin) ||
            verifiedDiscoveryOrigins.has(origin)) continue;
          if (!allowPrivatePeers && !isPublicAdvertisedOrigin(origin)) {
            throw new Error('discovered peer is not a public HTTPS origin');
          }
          await assertPeerHostAllowed(new URL(origin).hostname, { allowPrivate: allowPrivatePeers });
          const info = await fetchPeerJson(`${origin}/api/node`, {
            maxBytes: PEER_LIMITS.maxPeerNodeInfoBytes,
            timeoutMs: 5_000,
            allowPrivate: allowPrivatePeers
          });
          if (info?.instanceId === instanceId) continue;
          if (!isCompatiblePeerInfo(info)) throw new Error('incompatible BNKR peer identity');
          await ledger.addPeer(origin);
          verifiedDiscoveryOrigins.add(origin);
          known.add(origin);
          added += 1;
          console.log(`Discovered peer ${origin} via ${source}.`);
        } catch (error) {
          console.warn(`Skipping discovered peer ${value}: ${error?.message || error}`);
        }
      }
    } catch (error) {
      console.warn(`Peer discovery from ${source} failed: ${error?.message || error}`);
    } finally {
      discoveryInFlight.delete(source);
    }
  }
}

/**
 * Periodically re-register with configured seeds and known peers. A remote
 * peer's table is an independent database, so a startup POST that failed while
 * that peer was booting leaves a one-way edge. The per-peer cooldown keeps the
 * retry cheap while allowing the mesh to heal without a manual redeploy.
 */
async function retryPeerRegistrations() {
  if (!ledger || !canAdvertisePublicly) return;

  let knownPeers;
  try {
    knownPeers = await ledger.getPeers();
  } catch (error) {
    console.warn(`Registration retry skipped: unable to read peers (${error?.message || error})`);
    return;
  }

  const knownByUrl = new Map(knownPeers.map(peer => [peer.url, peer]));
  const candidates = [...new Set([...seedPeerOrigins(), ...knownByUrl.keys()])];
  const now = Date.now();

  for (const peer of candidates) {
    if (isSelfPeer(peer) || registrationInFlight.has(peer)) continue;
    const lastAttempt = registrationLastAttempt.get(peer) || 0;
    if (now - lastAttempt < registrationRetryMs) continue;

    registrationInFlight.add(peer);
    registrationLastAttempt.set(peer, now);
    try {
      await assertPeerHostAllowed(new URL(peer).hostname, { allowPrivate: allowPrivatePeers });
      if (!knownByUrl.has(peer)) await ledger.addPeer(peer);
      await registerWithPeer(peer);
    } catch (error) {
      try { await ledger.updatePeer(peer, error?.message || String(error)); } catch {}
      console.warn(`Registration retry for ${peer}: ${error?.message || error}`);
    } finally {
      registrationInFlight.delete(peer);
    }
  }
}

async function postPeer(peer, endpoint, payload) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchPeer(`${peer}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin-peer': canAdvertisePublicly ? publicUrl : '' },
        body: JSON.stringify(payload),
        timeoutMs: 5_000,
        allowPrivate: allowPrivatePeers
      });
      // The broadcast result is the status code; the body is never trusted.
      try { await response.body?.cancel(); } catch {}
      if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}.`);
      await ledger.updatePeer(peer);
      return;
    } catch (error) {
      if (attempt >= 3) {
        try { await ledger.updatePeer(peer, error.message); } catch {}
        console.warn(`Peer ${peer} ${endpoint}: ${error.message}`);
        return;
      }
      await sleep(1000 * attempt);
    }
  }
}

async function broadcast(endpoint, payload, skipPeer = null) {
  const peers = await ledger.getPeers();
  await Promise.all(peers.filter(peer => peer.url !== skipPeer && !isSelfPeer(peer.url))
    .map(peer => postPeer(peer.url, endpoint, payload)));
}

async function synchronizePeers() {
  const results = [];
  let peers = [];
  try {
    peers = await ledger.getPeers();
  } catch (error) {
    console.warn(`Peer sync skipped: unable to read peers (${error?.message || error})`);
    return results;
  }
  const identity = ledger.getChainIdentity();
  for (const peer of peers) {
    if (isSelfPeer(peer.url)) continue;
    let synced = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        // Paged exchange: the peer never chooses which page we accept, and each
        // page is hash-chained and size-bounded before its blocks are validated.
        const remote = await fetchPeerChain(peer.url, {
          networkId: identity.networkId,
          genesisHash: identity.genesisHash,
          protocolVersion: identity.protocolVersion,
          checkpointSetDigest: identity.checkpointSetDigest,
          allowPrivate: allowPrivatePeers,
          timeoutMs: 8_000
        });
        if (!Array.isArray(remote?.blocks) || remote.blocks.length === 0) {
          throw new Error('Peer chain response does not contain any blocks.');
        }
        const result = await ledger.replaceChain(remote.blocks);
        await ledger.updatePeer(peer.url);
        results.push({ peer: peer.url, ...result, pages: remote.pages, bytes: remote.bytes });
        synced = true;
        break;
      } catch (error) {
        lastError = error;
        // Configuration, identity, and checkpoint conflicts are permanent;
        // retrying cannot help and may mask an operator error.
        if (isPermanentSyncError(error) || attempt >= 3) break;
        await sleep(1000 * attempt);
      }
    }
    if (!synced) {
      const permanent = isPermanentSyncError(lastError);
      await faultRecorder.record(
        `peer:${peer.url}`,
        `peer sync rejected: ${lastError?.code || lastError?.message || 'SYNC_FAILED'}`,
        permanent ? 2 : 1
      );
      try { await ledger.updatePeer(peer.url, lastError?.message || 'Peer sync failed'); } catch {}
      console.warn(`Peer sync ${peer.url}: ${lastError?.message || lastError}`);
      results.push({ peer: peer.url, error: lastError?.message || String(lastError), code: lastError?.code ?? null });
    }
  }
  return results;
}

app.get('/api/node', asyncRoute(async (_req, res) => {
  const state = await ledger.networkState();
  const identity = ledger.getChainIdentity();
  const peers = await ledger.getPeers();
  res.json({
    name: 'The Banneker Coin',
    ticker: 'BNKR',
    instanceId,
    ...buildIdentity,
    networkId: identity.networkId,
    protocolVersion: identity.protocolVersion,
    genesisHash: identity.genesisHash,
    protocolUpgradeHeight: PROTOCOL_UPGRADE_HEIGHT,
    v2ActivationHeight: identity.v2ActivationHeight,
    coinbaseMaturity: identity.coinbaseMaturity,
    targetBlockSeconds: identity.targetBlockSeconds,
    halvingInterval: identity.halvingInterval,
    checkpointSetDigest: identity.checkpointSetDigest,
    manifestDigest: identity.manifestDigest,
    checkpointBurial: identity.checkpointBurial,
    checkpointState: state.checkpointState,
    accountsValid: state.accountsValid,
    height: state.height,
    chainWork: state.chainWork,
    peers: peers.length,
    protections: PROTECTION_STATUS
  });
}));

app.get('/health', asyncRoute(async (_req, res) => {
  let health;
  try {
    health = await ledger.validateStoredChain();
  } catch (error) {
    console.error(`Health check failed: ${error?.message || error}`);
    return res.status(503).json({ ok: false, reasonCode: 'STORAGE_UNREACHABLE' });
  }
  const identity = ledger.getChainIdentity();
  let reasonCode = null;
  if (health.checkpointState === 'VIOLATED') reasonCode = 'CHECKPOINT_VIOLATION';
  else if (health.checkpointState === 'UNSUPPORTED_PROTOCOL_VERSION') reasonCode = 'UNSUPPORTED_PROTOCOL_VERSION';
  else if (!health.valid) reasonCode = 'CHAIN_INVALID';
  else if (!health.storageValid) reasonCode = 'STORAGE_MISMATCH';
  else if (!health.accountsValid) reasonCode = 'ACCOUNT_STATE_MISMATCH';

  res.set('Cache-Control', 'no-store');
  res.status(reasonCode ? 503 : 200).json({
    ok: reasonCode === null,
    ...(reasonCode ? { reasonCode } : {}),
    ...buildIdentity,
    protocolVersion: identity.protocolVersion,
    networkId: identity.networkId,
    genesisHash: identity.genesisHash,
    checkpointSetDigest: identity.checkpointSetDigest,
    manifestDigest: identity.manifestDigest,
    height: health.height,
    checkpointState: health.checkpointState,
    accountsValid: health.accountsValid
  });
}));

app.get('/api/state', asyncRoute(async (req, res) => {
  const address = req.query.address ? String(req.query.address) : null;
  const state = await ledger.networkState(address);
  const peers = await ledger.getPeers();
  res.json({
    ...state,
    maxSupply: MAX_SUPPLY,
    coin: COIN,
    halvingInterval: HALVING_INTERVAL,
    targetBlockSeconds: TARGET_BLOCK_SECONDS,
    peers
  });
}));

app.get('/api/blocks', asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const search = String(req.query.search || '').slice(0, 128);
  res.json(await ledger.listBlocks({ limit, offset, search }));
}));

app.get('/api/mempool', asyncRoute(async (_req, res) => {
  res.json({ transactions: await ledger.getMempool() });
}));

app.get('/api/validate', asyncRoute(async (_req, res) => {
  res.json({ ...await ledger.validateStoredChain(), protections: PROTECTION_STATUS });
}));

app.get('/api/mining/template', asyncRoute(async (req, res) => {
  res.json(await ledger.miningTemplate(String(req.query.miner || '')));
}));

app.post('/api/tx', asyncRoute(async (req, res) => {
  const transaction = await acceptSubmission(req, 'transaction', () => ledger.acceptTransaction(req.body));
  res.status(202).json({ accepted: true, transaction });
  void broadcast('/api/peer/tx', transaction);
}));

app.post('/api/mining/submit', asyncRoute(async (req, res) => {
  const result = await acceptSubmission(req, 'block', () => ledger.acceptBlock(req.body));
  res.status(201).json({ accepted: true, ...result });
  void broadcast('/api/peer/block', result.block);
}));

app.get('/api/peers', asyncRoute(async (_req, res) => {
  res.json({ peers: await ledger.getPeers() });
}));

app.post('/api/peers', asyncRoute(async (req, res) => {
  let peer;
  try {
    peer = cleanPeerUrl(req.body?.url);
  } catch (error) {
    await faultRecorder.recordMany(
      registrationFaultIdentifiers(req),
      `invalid peer URL: ${error?.code || 'PEER_URL_INVALID'}`,
      1
    );
    throw error;
  }
  if (isSelfPeer(peer)) {
    await faultRecorder.recordMany(
      registrationFaultIdentifiers(req, peer),
      'self-peering rejected',
      1
    );
    return res.status(400).json({ error: 'A node cannot peer with itself.' });
  }
  let info;
  try {
    info = await fetchPeerJson(`${peer}/api/node`, {
      maxBytes: PEER_LIMITS.maxPeerNodeInfoBytes,
      timeoutMs: 5_000,
      allowPrivate: allowPrivatePeers
    });
  } catch (error) {
    await faultRecorder.recordMany(
      registrationFaultIdentifiers(req, peer),
      `peer registration probe failed: ${error?.code || 'PEER_UNREACHABLE'}`,
      1
    );
    throw error;
  }
  if (!isCompatiblePeerInfo(info)) {
    await faultRecorder.recordMany(
      registrationFaultIdentifiers(req, peer),
      'peer identity mismatch',
      1
    );
    throw new Error('The URL did not identify a compatible BNKR node.');
  }
  await ledger.addPeer(peer);
  await ledger.updatePeer(peer);
  const peers = await ledger.getPeers();
  res.status(201).json({ peer, peers });
  void synchronizePeers();
}));

app.get('/api/peer/chain', asyncRoute(async (_req, res) => {
  const state = await ledger.networkState();
  res.json({ chain: await ledger.getBlocks(), chainWork: state.chainWork });
}));

/**
 * One bounded page of the chain. The caller supplies the cursor (`from`), the
 * page number, and the previous page hash, and the server echoes them inside a
 * hash-covered envelope. The server never reads the whole chain to answer.
 */
app.get('/api/peer/blocks', asyncRoute(async (req, res) => {
  const from = parsePageHeight(req.query.from, 'from');
  if (from === null) {
    const error = new Error('from is required.');
    error.code = 'PAGE_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const requestedTo = parsePageHeight(req.query.to, 'to');
  const pageIndex = parsePageHeight(req.query.page, 'page') ?? 0;
  const prevPageHash = req.query.prev === undefined || req.query.prev === '' ? null : String(req.query.prev);
  if (prevPageHash !== null && !/^[0-9a-f]{64}$/.test(prevPageHash)) {
    const error = new Error('prev must be 64 lowercase hex characters.');
    error.code = 'PAGE_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (requestedTo !== null && requestedTo < from) {
    const error = new Error('to must be greater than or equal to from.');
    error.code = 'PAGE_INVALID';
    error.statusCode = 400;
    throw error;
  }

  // The server, not the caller, owns the page size. `from + 499` can exceed the
  // safe integer range, so clamp before it reaches SQL.
  const upper = Math.max(from, Math.min(
    requestedTo ?? Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER - 1,
    from + MAX_PAGE_BLOCKS - 1
  ));
  const identity = ledger.getChainIdentity();
  const [blocks, tipHeight] = await Promise.all([
    ledger.getBlockRange(from, upper, { limit: MAX_PAGE_BLOCKS }),
    ledger.getTipHeight()
  ]);
  const page = buildBlockPage({
    blocks,
    fromHeight: from,
    toHeight: upper,
    tipHeight,
    networkId: identity.networkId,
    genesisHash: identity.genesisHash,
    protocolVersion: identity.protocolVersion,
    checkpointSetDigest: identity.checkpointSetDigest,
    pageIndex,
    prevPageHash
  });
  res.set('Cache-Control', 'no-store');
  res.json(page);
}));

app.post('/api/peers/sync', asyncRoute(async (_req, res) => {
  const results = await synchronizePeers();
  const state = await ledger.networkState();
  res.json({ results, chainWork: state.chainWork });
}));

app.post('/api/peer/tx', asyncRoute(async (req, res) => {
  const transaction = await acceptSubmission(req, 'transaction', () => ledger.acceptTransaction(req.body));
  res.status(202).json({ accepted: true, transaction });
  const source = req.get('origin-peer') || null;
  void broadcast('/api/peer/tx', transaction, source);
}));

app.post('/api/peer/block', asyncRoute(async (req, res) => {
  const result = await acceptSubmission(req, 'block', () => ledger.acceptBlock(req.body));
  res.status(201).json({ accepted: true, height: result.height, chainWork: result.chainWork });
  const source = req.get('origin-peer') || null;
  void broadcast('/api/peer/block', result.block, source);
}));

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'the configured';
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Request body exceeds the ${formatBytes(error.limit)} limit.`,
      code: 'BODY_TOO_LARGE'
    });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Request body must be valid JSON.', code: 'JSON_INVALID' });
  }
  if (typeof error?.code === 'string' && Number.isInteger(error?.statusCode)) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  const status = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : /invalid|not valid|must |insufficient|does not|cannot|failed|rejected|nonce|signature|amount|key|timestamp|reward|difficulty|proof|chain|parent|transaction|block/i.test(message)
      ? 400
      : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: message });
});

async function startPeerSync() {
  if (!ledger) return;
  try {
    // Seed registration first: the remote learns about us, then we pull its
    // chain. Both halves are needed for a symmetric peer relationship.
    await bootstrapPeers();
    await discoverTransitivePeers();
    const peers = await ledger.getPeers();
    if (peers.length) void synchronizePeers().catch(error => console.warn(`Startup peer sync failed: ${error?.message || error}`));
  } catch (error) {
    console.warn(`Startup peer discovery failed: ${error?.message || error}`);
  }
}

// Bind the port before touching the database so Render sees an open socket
// immediately. Ledger creation and retry happen in the background; all API and
// health traffic receives 503 INITIALIZING until the ledger is ready.
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`BNKR node listening at http://0.0.0.0:${port}`);
  void initializeLedger();
});

let peerMaintenanceRunning = false;
const peerSyncInterval = setInterval(async () => {
  if (!ledger || peerMaintenanceRunning) return;
  peerMaintenanceRunning = true;
  try {
    await discoverTransitivePeers();
    await retryPeerRegistrations();
    const peers = await ledger.getPeers();
    if (peers.length) void synchronizePeers().catch(error => console.warn(`Periodic peer sync failed: ${error?.message || error}`));
  } catch (error) {
    console.warn(`Periodic peer maintenance failed: ${error?.message || error}`);
  } finally {
    peerMaintenanceRunning = false;
  }
}, peerMaintenanceIntervalMs);
peerSyncInterval.unref();

function shutdown() {
  shuttingDown = true;
  stopBackgroundRetry();
  clearInterval(peerSyncInterval);
  server.close(() => {
    if (ledger) ledger.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
