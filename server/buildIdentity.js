// Finding F-03: report a real, verifiable build identity instead of the
// placeholder "dev-unversioned" / null commit. Only public commit identifiers
// are read; no credentials or secret environment values are touched.

import { execFileSync } from 'node:child_process';

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

function cleanCommit(value) {
  const text = String(value ?? '').trim();
  return COMMIT_PATTERN.test(text) ? text : null;
}

export function gitHeadCommit({ cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    const output = exec('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return cleanCommit(output);
  } catch {
    return null;
  }
}

/**
 * Precedence: platform-provided commit variables, then operator overrides,
 * then the checked-out git HEAD. An explicit BANNEKER_BUILD_ID always wins.
 */
export function resolveBuildIdentity({
  env = process.env,
  cwd = process.cwd(),
  exec = execFileSync
} = {}) {
  const sourceCommit =
    cleanCommit(env.RENDER_GIT_COMMIT) ||
    cleanCommit(env.SOURCE_COMMIT) ||
    cleanCommit(env.BANNEKER_SOURCE_COMMIT) ||
    cleanCommit(env.GIT_COMMIT) ||
    gitHeadCommit({ cwd, exec });

  const explicitBuildId = String(env.BANNEKER_BUILD_ID || '').trim();
  const buildId = explicitBuildId ||
    (sourceCommit ? `${sourceCommit.slice(0, 12)}-unversioned` : 'dev-unversioned');

  return Object.freeze({ buildId, sourceCommit });
}
