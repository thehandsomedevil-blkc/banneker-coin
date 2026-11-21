// Production HTTP security headers (finding F-07 of the forensic audit).
// Kept in a standalone module so the exact values can be unit-tested without
// binding a port, and applied to every response including static assets.

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

export function applySecurityHeaders(res) {
  if (!res || typeof res.set !== 'function') {
    throw new Error('A response object with set() is required.');
  }
  res.set({ ...SECURITY_HEADERS });
  return res;
}

export function securityHeadersMiddleware(_req, res, next) {
  applySecurityHeaders(res);
  next();
}
