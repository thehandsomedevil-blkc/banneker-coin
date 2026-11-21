// Finding F-05: PROTECTION_STATUS advertises peerBanning, so invalid peer
// submissions must actually accumulate faults. These helpers contain the wiring
// policy; ledger.recordPeerFault() already owns the scoring and ban state.

import { normalizeClientIp } from './security.js';

/**
 * Identifiers to fault for a submission. A registered peer is faulted by its
 * attested origin; peer-route traffic is additionally faulted by client IP so
 * an unregistered source cannot spam invalid consensus data without penalty.
 */
export function submissionFaultIdentifiers(req, peerSource = null) {
  const identifiers = [];
  if (typeof peerSource === 'string' && peerSource) identifiers.push(peerSource);
  // originalUrl keeps the full path inside a mounted app.use('/api/peer', ...)
  // handler, where req.path is relative to the mount point.
  const path = typeof req?.originalUrl === 'string' ? req.originalUrl
    : (typeof req?.path === 'string' ? req.path : '');
  if (path.startsWith('/api/peer/')) {
    const address = req.ip || req.socket?.remoteAddress;
    if (address) identifiers.push(`ip:${normalizeClientIp(address)}`);
  }
  return [...new Set(identifiers)];
}

/** A URL that fails SSRF/integrity screening is a fault of the submitting client. */
export function registrationFaultIdentifiers(req, peerUrl = null) {
  const identifiers = [];
  if (typeof peerUrl === 'string' && peerUrl) identifiers.push(`peer:${peerUrl}`);
  const address = req?.ip || req?.socket?.remoteAddress;
  if (address) identifiers.push(`ip:${normalizeClientIp(address)}`);
  return [...new Set(identifiers)];
}

export function createFaultRecorder(getLedger) {
  async function record(identifier, reason, points = 1) {
    const ledger = typeof getLedger === 'function' ? getLedger() : getLedger;
    if (!ledger || typeof ledger.recordPeerFault !== 'function' || !identifier) return null;
    try {
      return await ledger.recordPeerFault(identifier, reason, points);
    } catch (error) {
      console.warn(`Unable to record peer fault for ${identifier}: ${error?.message || error}`);
      return null;
    }
  }

  return {
    record,
    async recordMany(identifiers, reason, points = 1) {
      const results = [];
      for (const identifier of identifiers || []) {
        results.push(await record(identifier, reason, points));
      }
      return results;
    }
  };
}
