export const COIN = 100_000_000;
export const MAX_SUPPLY = 21_000_000 * COIN;
export const MIN_FEE_UNITS = 100_000n;
export const MIN_AMOUNT_UNITS = 1_000_000n;

export function parseUnits(value, options = {}) {
  const {
    minUnits = 0n,
    maxUnits = BigInt(MAX_SUPPLY),
    minError = 'Enter a valid amount.',
    maxError = 'The amount exceeds the maximum supported supply.',
    formatError = 'Enter a positive amount with up to 8 decimal places.'
  } = options;
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) {
    throw new Error(formatError);
  }
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * BigInt(COIN) + BigInt(fraction.padEnd(8, '0'));
  if (units < minUnits) {
    throw new Error(minError);
  }
  if (units > maxUnits) {
    throw new Error(maxError);
  }
  return units;
}

export function parseAmountUnits(value) {
  return parseUnits(value, {
    minUnits: MIN_AMOUNT_UNITS,
    minError: 'The transfer amount must be at least 0.01 BNKR.',
    maxError: 'The transfer amount exceeds the maximum supported supply.'
  });
}

export function parseFeeUnits(value) {
  return parseUnits(value, {
    minUnits: MIN_FEE_UNITS,
    minError: 'The transaction fee must be at least 0.001 BNKR.'
  });
}

export function formatAtomic(value) {
  const units = typeof value === 'bigint' ? value : BigInt(value);
  const whole = units / BigInt(COIN);
  const fraction = String(units % BigInt(COIN)).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
