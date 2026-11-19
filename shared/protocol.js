// Owner-selected protocol parameters (Q-1, Q-2, Q-15, and coinbase maturity).
//
// Every value here is a compiled consensus constant. None of it is read from a
// database row or a peer, and none of it may be changed by a running process:
// a parameter change requires a new binary and a new activation height.
//
// The Era 1 constants (15-second target, height-only era selection) stay frozen
// forever so historical blocks replay exactly as mined. V2 introduces the
// values below starting at V2_ACTIVATION_HEIGHT.

/**
 * Q-1. The first V2 block is height 5000. The original founding-year choice of
 * 2026 was postponed because the live mainnet continued in Era 1 past it; this
 * compiled default now matches the production schedule. Genesis (height 0) and
 * every block below 5000 remain Era 1. Testnet nodes may move this value with
 * BANNEKER_V2_ACTIVATION_HEIGHT, which is a consensus switch and must be
 * identical on every node that is expected to agree.
 */
export const V2_ACTIVATION_HEIGHT = 5000;

/**
 * V2 target cadence: one block per minute, honouring Benjamin Banneker's 1753
 * wooden striking clock. Era 1 keeps its original 15-second target so that
 * pre-activation difficulty adjustments recompute exactly.
 */
export const TARGET_BLOCK_TIME_SECONDS = 60;
export const ERA1_TARGET_BLOCK_SECONDS = 15;

/**
 * Coinbase maturity: 53 blocks, honouring 1753, the year Banneker carved
 * America's first wooden striking clock. Era 1 history is never re-judged by
 * this rule; maturity begins at the activation height (or at
 * BANNEKER_COINBASE_MATURITY_HEIGHT when an operator sets one).
 */
export const COINBASE_MATURITY = 53;

/**
 * Q-15. Emission stays height-only: the subsidy halves every 210,000 blocks
 * exactly as Era 1 did. No wall-clock or cadence-based halving was selected.
 * The schedule is strictly capped at 21,000,000 BNKR; the terminal subsidy is
 * zero and `rewardForHeight` clamps against remaining supply.
 */
export const HALVING_INTERVAL = 210_000;
export const INITIAL_SUBSIDY_UNITS = 50 * 100_000_000;
export const MAX_SUPPLY_UNITS = 21_000_000 * 100_000_000;
export const HALVING_EPOCHS = 53;

export const V2_EMISSION = Object.freeze({
  schedule: 'height-only',
  halvingInterval: HALVING_INTERVAL,
  initialSubsidyUnits: INITIAL_SUBSIDY_UNITS,
  maxSupplyUnits: MAX_SUPPLY_UNITS,
  halvingEpochs: HALVING_EPOCHS,
  terminalSubsidyUnits: 0,
  changesAtV2: false
});

/**
 * Q-2. Compiled Mainnet Checkpoints.
 *
 * Checkpoint 1 at height 731 honours Banneker's birth year, 1731. Checkpoint 2
 * at height 2500 was derived from the live mainnet history under the 5000
 * activation schedule. Both tuples were derived from canonical Era 1 preimages
 * (TE-63); a stored `hash` column is not a trust input. `deriveMainnetCheckpointAnchor`
 * reproduces each tuple from the chain itself.
 *
 * An anchor is only applicable while it sits in Era 1 (height < activation).
 * A node whose activation height is at or below an anchor's height does not
 * inherit that anchor, because the anchor's protocolVersion would then be wrong.
 */
export const MAINNET_CHECKPOINT_ANCHORS = Object.freeze([
  Object.freeze({
    height: 731,
    protocolVersion: 1,
    blockHash: '000053a9cf7c99c05150709c0850e044cb0e634b3e462ca18377b548080ed2f8',
    chainWork: '212511536'
  }),
  Object.freeze({
    height: 2500,
    protocolVersion: 1,
    blockHash: '000004f48c5efffd42058140ba6532eeff322a33871a030ce4aefb54bdc38dd7',
    chainWork: '2482285360'
  })
]);

/**
 * Era selector. Returns true when `height` belongs to the V2 era under the
 * supplied activation height. An unset activation height means V2 is
 * unscheduled and every height is Era 1.
 */
export function isV2Height(height, activationHeight = V2_ACTIVATION_HEIGHT) {
  return Number.isSafeInteger(activationHeight) && height >= activationHeight;
}

/**
 * Difficulty-retarget cadence for a given block height. The height identifies
 * the era, not the caller's intent, so a retarget at or above activation uses
 * the V2 target and everything below it uses the frozen Era 1 target.
 */
export function targetBlockSecondsForHeight(height, activationHeight = V2_ACTIVATION_HEIGHT) {
  return isV2Height(height, activationHeight)
    ? TARGET_BLOCK_TIME_SECONDS
    : ERA1_TARGET_BLOCK_SECONDS;
}

/**
 * True when a mainnet anchor is an Era 1 fact under this activation schedule
 * and may therefore be enforced by this binary.
 */
export function appliesToActivation(anchor, activationHeight = V2_ACTIVATION_HEIGHT) {
  if (!Number.isSafeInteger(anchor?.height)) return false;
  return !isV2Height(anchor.height, activationHeight);
}
