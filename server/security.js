import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import {
  JsonStructureError,
  assertNoDuplicateJsonKeys as scanJsonStructure
} from '../shared/canonical.js';

// Phase-1 limits. They are deliberately independent of any consensus rule:
// raising a transport bound must never change what a block means.
export const PEER_LIMITS = Object.freeze({
  // V1 serves the whole chain in one response. This bound is temporary and is
  // replaced by paged sync before the 1 MiB per-page limit of the V2 spec applies.
  maxPeerResponseBytes: 16 * 1024 * 1024,
  maxPeerNodeInfoBytes: 64 * 1024,
  // Block-admission bound from correction spec §3.7 / §6 (V2). Exposed here so the
  // HTTP parser and the validator agree even before V2 is activated.
  maxBlockBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64
});

export const PROTECTION_STATUS = Object.freeze({
  rateLimiting: true,
  apiLimitPerMinute: 300,
  transactionLimitPerMinute: 15,
  readLimitPerMinute: 120,
  maxMempoolTransactions: 500,
  minimumTransactionAmount: '0.01 BNKR',
  minimumMinerFee: '0.001 BNKR',
  maxJsonBodyBytes: 64 * 1024,
  maxBlockBytes: PEER_LIMITS.maxBlockBytes,
  maxPeerResponseBytes: PEER_LIMITS.maxPeerResponseBytes,
  maxJsonDepth: PEER_LIMITS.maxJsonDepth,
  peerAddressScreen: true,
  peerRedirectPolicy: 'error',
  duplicateJsonKeys: 'rejected',
  securityHeaders: true,
  peerBanning: true,
  peerBanScore: 100,
  peerBanDurationHours: 24,
  corsPolicy: 'same-origin and explicitly allowed origins'
});

const MAX_TRACKED_CLIENTS = 50_000;

export function normalizeClientIp(value) {
  const address = String(value || 'unknown').split('%')[0].toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return address;

  const separator = address.indexOf('::');
  const left = (separator < 0 ? address : address.slice(0, separator)).split(':').filter(Boolean);
  const right = separator < 0 ? [] : address.slice(separator + 2).split(':').filter(Boolean);
  const tail = right.length ? right : left;
  if (tail.length && tail[tail.length - 1].includes('.')) {
    const octets = tail.pop().split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return address;
    }
    tail.push(((octets[0] << 8) | octets[1]).toString(16));
    tail.push(((octets[2] << 8) | octets[3]).toString(16));
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) return address;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return address;
  return `v6:${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export function createRateLimiter({ limit, windowMs = 60_000 }) {
  const buckets = new Map();
  let nextSweep = 0;

  return (req, res, next) => {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [ip, timestamps] of buckets) {
        const active = timestamps.filter(timestamp => timestamp > now - windowMs);
        if (active.length) buckets.set(ip, active);
        else buckets.delete(ip);
      }
      nextSweep = now + Math.min(windowMs, 60_000);
    }

    const ip = normalizeClientIp(req.ip || req.socket.remoteAddress || 'unknown');
    if (!buckets.has(ip) && buckets.size >= MAX_TRACKED_CLIENTS) {
      for (const [trackedIp, timestamps] of buckets) {
        if (!timestamps.some(timestamp => timestamp > now - windowMs)) buckets.delete(trackedIp);
      }
      if (buckets.size >= MAX_TRACKED_CLIENTS) {
        return res.status(503).json({ error: 'Rate-limit tracking capacity is temporarily exhausted.' });
      }
    }
    const active = (buckets.get(ip) || []).filter(timestamp => timestamp > now - windowMs);
    const resetSeconds = active.length
      ? Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000))
      : Math.ceil(windowMs / 1000);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - active.length - 1)));
    res.set('RateLimit-Reset', String(resetSeconds));
    if (active.length >= limit) {
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({ error: 'Request rate limit exceeded.' });
    }
    active.push(now);
    buckets.set(ip, active);
    next();
  };
}

// ===========================================================================
// Typed transport errors
// ===========================================================================

export function peerError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// ===========================================================================
// Peer address screening (SSRF defence)
//
// Every outbound peer connection resolves the host first and refuses the
// request if any resolved address is loopback, private, link-local/cloud
// metadata, multicast, unspecified, reserved, or a documentation range.
// BANNEKER_ALLOW_PRIVATE_PEERS=1 relaxes only loopback/private/link-local so
// operators can run a local test network; multicast and unspecified ranges
// stay blocked even then.
// ===========================================================================

const V4_RANGES = Object.freeze([
  Object.freeze({ base: '0.0.0.0', prefix: 8, reason: 'unspecified or "this network" address', relaxable: false }),
  Object.freeze({ base: '10.0.0.0', prefix: 8, reason: 'private network (RFC 1918)', relaxable: true }),
  Object.freeze({ base: '100.64.0.0', prefix: 10, reason: 'carrier-grade NAT range (RFC 6598)', relaxable: true }),
  Object.freeze({ base: '127.0.0.0', prefix: 8, reason: 'loopback address', relaxable: true }),
  Object.freeze({ base: '169.254.0.0', prefix: 16, reason: 'link-local or cloud metadata address', relaxable: true }),
  Object.freeze({ base: '172.16.0.0', prefix: 12, reason: 'private network (RFC 1918)', relaxable: true }),
  Object.freeze({ base: '192.0.0.0', prefix: 24, reason: 'IETF protocol assignment', relaxable: false }),
  Object.freeze({ base: '192.0.2.0', prefix: 24, reason: 'documentation range (TEST-NET-1)', relaxable: false }),
  Object.freeze({ base: '192.168.0.0', prefix: 16, reason: 'private network (RFC 1918)', relaxable: true }),
  Object.freeze({ base: '198.18.0.0', prefix: 15, reason: 'benchmark range', relaxable: false }),
  Object.freeze({ base: '198.51.100.0', prefix: 24, reason: 'documentation range (TEST-NET-2)', relaxable: false }),
  Object.freeze({ base: '203.0.113.0', prefix: 24, reason: 'documentation range (TEST-NET-3)', relaxable: false }),
  Object.freeze({ base: '224.0.0.0', prefix: 4, reason: 'multicast address', relaxable: false }),
  Object.freeze({ base: '240.0.0.0', prefix: 4, reason: 'reserved or broadcast address', relaxable: false })
]);

const V6_RANGES = Object.freeze([
  Object.freeze({ base: 'fc00::', prefix: 7, reason: 'unique local address (fc00::/7)', relaxable: true }),
  Object.freeze({ base: 'fe80::', prefix: 10, reason: 'link-local address (fe80::/10)', relaxable: true }),
  Object.freeze({ base: 'ff00::', prefix: 8, reason: 'multicast address (ff00::/8)', relaxable: false }),
  Object.freeze({ base: '2001:db8::', prefix: 32, reason: 'documentation range (2001:db8::/32)', relaxable: false })
]);

function parseIPv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function inV4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((parseIPv4(base) & mask) >>> 0);
}

function parseIPv6(address) {
  let text = String(address).toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (isIP(text) !== 6) return null;

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const expand = (part) => {
    if (!part) return [];
    const groups = part.split(':');
    const values = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes('.')) {
        if (index !== groups.length - 1) return null;
        const embedded = parseIPv4(group);
        if (embedded === null) return null;
        values.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      values.push(parseInt(group, 16));
    }
    return values;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (!head || !tail) return null;

  let groups;
  if (halves.length === 2) {
    const total = head.length + tail.length;
    // "::" must stand for at least one zero group.
    if (total > 7) return null;
    groups = [...head, ...new Array(8 - total).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = (groups[index] >>> 8) & 0xff;
    bytes[index * 2 + 1] = groups[index] & 0xff;
  }
  return bytes;
}

function inV6Range(bytes, base, prefix) {
  const baseBytes = parseIPv6(base);
  if (!baseBytes) return false;
  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== baseBytes[index]) return false;
  }
  const remainder = prefix % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes] & mask) === (baseBytes[fullBytes] & mask);
}

function readEmbeddedV4(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function allZero(bytes, end) {
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function classifyV4(value) {
  if (value === null) return null;
  for (const range of V4_RANGES) {
    if (inV4Range(value, range.base, range.prefix)) return range;
  }
  return null;
}

function classifyV6(bytes) {
  if (allZero(bytes, 16)) {
    return { reason: 'unspecified address (::)', relaxable: false };
  }
  if (allZero(bytes, 15) && bytes[15] === 1) {
    return { reason: 'loopback address (::1)', relaxable: true };
  }

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (deprecated) both
  // embed an IPv4 address in the last four bytes. Classify the embedded
  // address so ::ffff:169.254.169.254 cannot bypass the IPv4 rules.
  const mapped = allZero(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = allZero(bytes, 12);
  if (mapped || compatible) {
    const range = classifyV4(readEmbeddedV4(bytes, 12));
    if (!range) return null;
    return { reason: `IPv4-embedded ${range.reason}`, relaxable: range.relaxable };
  }

  // NAT64 64:ff9b::/96 embeds an IPv4 address too.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0 &&
    bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 0) {
    const range = classifyV4(readEmbeddedV4(bytes, 12));
    if (!range) return null;
    return { reason: `NAT64-embedded ${range.reason}`, relaxable: range.relaxable };
  }

  for (const range of V6_RANGES) {
    if (inV6Range(bytes, range.base, range.prefix)) return range;
  }
  return null;
}

/**
 * Returns a human-readable reason when `address` must not be contacted, or
 * `null` when it is an ordinary globally routable unicast address.
 */
export function blockedAddressReason(address, { allowPrivate = false } = {}) {
  const raw = String(address ?? '').trim();
  const literal = raw.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (!literal) return 'empty address';

  const family = isIP(literal);
  if (family === 4) {
    const range = classifyV4(parseIPv4(literal));
    if (!range) return null;
    return allowPrivate && range.relaxable ? null : range.reason;
  }
  if (family !== 6) return `"${raw}" is not an IP address`;

  const bytes = parseIPv6(literal);
  if (!bytes) return `"${raw}" is not a valid IPv6 address`;
  const range = classifyV6(bytes);
  if (!range) return null;
  return allowPrivate && range.relaxable ? null : range.reason;
}

/**
 * Resolves `hostname` (or accepts an IP literal) and throws if any resolved
 * address is not a globally routable unicast address. Returns the resolved
 * records so callers can log or pin them.
 */
export async function assertPeerHostAllowed(hostname, { allowPrivate = false, lookup = dnsLookup } = {}) {
  const host = String(hostname ?? '').trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw peerError('Peer host is empty.', 'PEER_ADDRESS_BLOCKED', 400);

  if (isIP(host)) {
    const reason = blockedAddressReason(host, { allowPrivate });
    if (reason) {
      throw peerError(`Refusing peer address ${host}: ${reason}.`, 'PEER_ADDRESS_BLOCKED', 400);
    }
    return [{ address: host, family: isIP(host) }];
  }

  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw peerError(`Peer host ${host} could not be resolved: ${error?.code || error?.message || error}.`, 'PEER_RESOLUTION_FAILED', 400);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw peerError(`Peer host ${host} did not resolve to any address.`, 'PEER_RESOLUTION_FAILED', 400);
  }
  for (const record of records) {
    const reason = blockedAddressReason(record.address, { allowPrivate });
    if (reason) {
      throw peerError(`Refusing peer host ${host}: it resolves to ${record.address} (${reason}).`, 'PEER_ADDRESS_BLOCKED', 400);
    }
  }
  return records;
}

/**
 * Parses a peer *identity* URL. Peers are registered as bare origins, so a
 * path, query, fragment, or embedded credential is rejected.
 */
export function parsePeerUrl(value) {
  if (typeof value !== 'string') {
    throw peerError('Peer URL must be a string.', 'PEER_URL_INVALID', 400);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw peerError('Peer URL is not valid.', 'PEER_URL_INVALID', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw peerError('Peer URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment.', 'PEER_URL_INVALID', 400);
  }
  return parsed;
}

/**
 * Config sanity check for the URL a node advertises to peers. This is not a
 * replacement for DNS-level SSRF screening; it only prevents an operator from
 * accidentally advertising an internal default such as http://0.0.0.0:10000.
 */
export function isPublicAdvertisedOrigin(value) {
  let parsed;
  try {
    parsed = parsePeerUrl(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const host = String(parsed.hostname || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!host) return false;
  if (isIP(host)) return blockedAddressReason(host) === null;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  return true;
}

function assertOutboundPeerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw peerError('Peer URL must be a non-empty string.', 'PEER_URL_INVALID', 400);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw peerError('Peer URL is not valid.', 'PEER_URL_INVALID', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw peerError('Peer requests must use http(s) without embedded credentials.', 'PEER_URL_INVALID', 400);
  }
  if (parsed.hash) {
    throw peerError('Peer request URLs must not contain a fragment.', 'PEER_URL_INVALID', 400);
  }
  return parsed;
}

function normalizePeerFetchError(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return peerError(`Peer request timed out after ${timeoutMs}ms.`, 'PEER_TIMEOUT', 504);
  }
  if (error?.code && error?.statusCode) return error;
  const detail = `${error?.message || ''} ${error?.cause?.message || ''}`;
  if (/redirect/i.test(detail)) {
    return peerError('Peer responses must not redirect.', 'PEER_REDIRECT_REFUSED', 502);
  }
  return peerError(`Peer request failed: ${error?.cause?.message || error?.message || error}.`, 'PEER_REQUEST_FAILED', 502);
}

/**
 * A `lookup` callback that always returns the already-screened address. Node
 * calls this instead of resolving the hostname again, so a hostile resolver
 * cannot rebind the name between the SSRF check and the TCP connect.
 */
function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (settings.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };
}

function createPinnedAgent(protocol, address, family) {
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ keepAlive: false, lookup: pinnedLookup(address, family) });
}

function toHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function asFetchResponse(response) {
  const status = Number(response.statusCode) || 502;
  const headers = toHeaders(response.headers);
  // Null-body statuses cannot carry a stream into a Response constructor.
  if (status < 200 || status === 204 || status === 205 || status === 304) {
    response.resume();
    return new Response(null, {
      status: status >= 200 && status <= 599 ? status : 502,
      statusText: response.statusMessage || '',
      headers
    });
  }
  return new Response(Readable.toWeb(response), {
    status,
    statusText: response.statusMessage || '',
    headers
  });
}

/**
 * Screened, redirect-refusing peer request over a pinned socket. The URL is
 * parsed, the host is resolved once, every answer is screened, and that exact
 * address is bound into the agent's `lookup`. TLS SNI and the Host header keep
 * the original hostname, so virtual hosting still works.
 *
 * Residual risk from Phase 1 is closed here: there is no second DNS resolution
 * between the check and the connection.
 */
async function peerRequest(target, {
  method = 'GET',
  body,
  headers,
  signal,
  allowPrivate,
  timeoutMs,
  lookup = undefined
}) {
  const parsed = assertOutboundPeerUrl(target);
  const records = await assertPeerHostAllowed(parsed.hostname, { allowPrivate, lookup });
  // Prefer an IPv4 answer when both families are present; the screen approved
  // every record, so either is safe, and IPv4 avoids broken IPv6 routes.
  const record = records.find(entry => entry.family === 4) || records[0];
  const address = String(record.address).replace(/^\[/, '').replace(/\]$/, '');
  const family = record.family ?? isIP(address);
  const agent = createPinnedAgent(parsed.protocol, address, family);

  const requestHeaders = { ...(headers || {}) };
  let payload = null;
  if (body !== undefined && body !== null) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(payload.length);
    }
  }

  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: `${parsed.pathname}${parsed.search}`,
    method: String(method || 'GET').toUpperCase(),
    headers: requestHeaders,
    agent,
    signal,
    servername: isIP(parsed.hostname) ? undefined : parsed.hostname
  };
  const transport = parsed.protocol === 'https:' ? https : http;

  try {
    return await new Promise((resolve, reject) => {
      const request = transport.request(requestOptions, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(peerError('Peer responses must not redirect.', 'PEER_REDIRECT_REFUSED', 502));
          return;
        }
        response.once('close', () => agent.destroy());
        try {
          resolve(asFetchResponse(response));
        } catch (error) {
          reject(normalizePeerFetchError(error, timeoutMs));
        }
      });
      request.once('error', error => {
        agent.destroy();
        reject(normalizePeerFetchError(error, timeoutMs));
      });
      if (payload) request.write(payload);
      request.end();
    });
  } catch (error) {
    agent.destroy();
    throw (error?.code && error?.statusCode) ? error : normalizePeerFetchError(error, timeoutMs);
  }
}

// ===========================================================================
// Strict JSON: duplicate keys are fatal, never last-wins
// ===========================================================================

const DEFAULT_MAX_JSON_DEPTH = PEER_LIMITS.maxJsonDepth;

/**
 * Single-pass structural scan that rejects duplicate object keys, depth
 * overflow, malformed JSON, and trailing data. The implementation lives in
 * shared/canonical.js so the HTTP parser and the V2 vector runner cannot drift.
 */
export function assertNoDuplicateJsonKeys(text, { maxDepth = DEFAULT_MAX_JSON_DEPTH } = {}) {
  return scanJsonStructure(text, { maxDepth });
}

/**
 * Scans for duplicate keys and then returns the parsed value.
 */
export function parseStrictJson(text, { maxDepth = DEFAULT_MAX_JSON_DEPTH } = {}) {
  try {
    assertNoDuplicateJsonKeys(text, { maxDepth });
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof JsonStructureError) throw peerError(error.message, error.code, 400);
    throw peerError('JSON payload is not valid JSON.', 'JSON_INVALID', 400);
  }
}

// ===========================================================================
// Bounded peer response reading
// ===========================================================================

function isJsonContentType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/**
 * Reads a fetch Response body with a hard byte cap and rejects non-JSON
 * content types. The stream is cancelled the moment the cap is crossed, so a
 * hostile peer cannot make the process buffer an unbounded body.
 */
export async function readBoundedJson(response, {
  maxBytes = PEER_LIMITS.maxPeerResponseBytes,
  maxDepth = DEFAULT_MAX_JSON_DEPTH
} = {}) {
  if (!response || typeof response.headers?.get !== 'function') {
    throw peerError('Peer response is missing headers.', 'PEER_RESPONSE_INVALID', 502);
  }

  const contentType = response.headers.get('content-type');
  if (!isJsonContentType(contentType)) {
    throw peerError(
      `Peer response Content-Type must be JSON, received "${contentType || 'none'}".`,
      'PEER_CONTENT_TYPE_INVALID',
      502
    );
  }

  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isInteger(declared) || declared < 0) {
      throw peerError('Peer response has an invalid Content-Length.', 'PEER_RESPONSE_INVALID', 502);
    }
    if (declared > maxBytes) {
      throw peerError(
        `Peer response Content-Length ${declared} exceeds the ${maxBytes}-byte limit.`,
        'PEER_RESPONSE_TOO_LARGE',
        502
      );
    }
  }

  if (!response.body) {
    throw peerError('Peer response has no body.', 'PEER_RESPONSE_INVALID', 502);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw peerError(`Peer response exceeded the ${maxBytes}-byte limit.`, 'PEER_RESPONSE_TOO_LARGE', 502);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    if (error?.code && error?.statusCode) throw error;
    // Let the caller map an aborted stream to its own timeout error.
    if (error?.name === 'AbortError') throw error;
    throw peerError(`Peer response could not be read: ${error?.message || error}.`, 'PEER_RESPONSE_INVALID', 502);
  }

  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    .toString('utf8');
  try {
    return parseStrictJson(text, { maxDepth });
  } catch (error) {
    throw peerError(`Peer response is not acceptable JSON: ${error.message}`, 'PEER_JSON_INVALID', 502);
  }
}

/**
 * Screened, redirect-refusing peer request whose status code is the result.
 * Used for broadcasts, where the response body is never trusted or read.
 */
export async function fetchPeer(target, {
  method = 'GET',
  body,
  headers,
  allowPrivate = false,
  timeoutMs = 8000,
  lookup = undefined
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await peerRequest(target, {
      method,
      body,
      headers,
      signal: controller.signal,
      allowPrivate,
      timeoutMs,
      lookup
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Screened, redirect-refusing peer GET/POST that reads a bounded JSON body.
 * `allowPrivate` must come from the operator's explicit local-testing flag.
 */
export async function fetchPeerJson(target, {
  method = 'GET',
  body,
  headers,
  maxBytes = PEER_LIMITS.maxPeerResponseBytes,
  timeoutMs = 8000,
  allowPrivate = false,
  lookup = undefined
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await peerRequest(target, {
      method,
      body,
      headers,
      signal: controller.signal,
      allowPrivate,
      timeoutMs,
      lookup
    });

    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw peerError(`Peer returned HTTP ${response.status}.`, 'PEER_HTTP_ERROR', 502);
    }

    return await readBoundedJson(response, { maxBytes });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw peerError(`Peer request timed out after ${timeoutMs}ms.`, 'PEER_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

