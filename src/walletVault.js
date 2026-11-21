import nacl from 'nacl';

export const VAULT_STORAGE_KEY = 'bnkr.wallet.v2';
export const LEGACY_STORAGE_KEY = 'bnkr.wallet.v1';
export const OLD_VAULT_STORAGE_KEY = 'blkc.wallet.v2';
export const OLD_LEGACY_STORAGE_KEY = 'blkc.wallet.v1';
export const VAULT_KDF_ITERATIONS = 600_000;

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string') throw new Error('Wallet backup is malformed.');
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length !== expectedLength || encodeBase64(bytes) !== value) {
    throw new Error('Wallet backup contains invalid key material.');
  }
  return bytes;
}

function publicKeyFromSecret(secretKey) {
  return encodeBase64(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey);
}

function checkVault(vault) {
  if (!vault || vault.version !== 2 || vault.cipher !== 'AES-GCM' ||
    vault.kdf?.name !== 'PBKDF2' || vault.kdf.hash !== 'SHA-256' ||
    vault.kdf.iterations !== VAULT_KDF_ITERATIONS || typeof vault.publicKey !== 'string') {
    throw new Error('Unsupported or malformed encrypted BNKR wallet file.');
  }
  decodeBase64(vault.salt, 16);
  decodeBase64(vault.iv, 12);
  const ciphertext = decodeBase64(vault.ciphertext, 80);
  if (ciphertext.length !== 80) throw new Error('Encrypted wallet key has an invalid length.');
}

async function deriveKey(password, salt, usages) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: VAULT_KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export async function encryptWallet(publicKey, secretKey, password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Choose a wallet password with at least 12 characters.');
  }
  const secret = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey);
  if (secret.length !== nacl.sign.secretKeyLength || publicKeyFromSecret(secret) !== publicKey) {
    throw new Error('Wallet public and private keys do not match.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    secret
  ));
  return {
    version: 2,
    cipher: 'AES-GCM',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS },
    publicKey,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(ciphertext),
    createdAt: new Date().toISOString()
  };
}

export async function decryptWallet(vault, password) {
  checkVault(vault);
  if (typeof password !== 'string' || !password) throw new Error('Enter the wallet password.');
  const key = await deriveKey(password, decodeBase64(vault.salt, 16), ['decrypt']);
  let secret;
  try {
    secret = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64(vault.iv, 12) },
      key,
      decodeBase64(vault.ciphertext, 80)
    ));
  } catch {
    throw new Error('Wallet password is incorrect or the encrypted backup is damaged.');
  }
  if (secret.length !== nacl.sign.secretKeyLength || publicKeyFromSecret(secret) !== vault.publicKey) {
    secret.fill(0);
    throw new Error('Decrypted key does not match the wallet address.');
  }
  return secret;
}

export function isEncryptedWallet(value) {
  try {
    checkVault(value);
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// Storage helpers.
//
// All wallet persistence goes through these functions. They never write a raw
// Ed25519 secret key: the only value ever stored is the encrypted v2 vault.
// A storage adapter can be injected so browser behaviour is unit-testable in
// plain Node without a DOM (fix F-01 of the forensic audit).
// ===========================================================================

function storageOrThrow(storage) {
  const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function' ||
    typeof target.removeItem !== 'function') {
    throw new Error('Wallet storage is unavailable in this environment.');
  }
  return target;
}

export function readLegacyWallet(storage) {
  const raw = storageOrThrow(storage).getItem(LEGACY_STORAGE_KEY);
  if (!raw) return null;
  const stored = JSON.parse(raw);
  if (typeof stored?.publicKey !== 'string' || typeof stored?.secretKey !== 'string') {
    throw new Error('Legacy wallet storage is malformed.');
  }
  const secret = decodeBase64(stored.secretKey, nacl.sign.secretKeyLength);
  if (publicKeyFromSecret(secret) !== stored.publicKey) {
    throw new Error('Legacy wallet keys do not match.');
  }
  return { publicKey: stored.publicKey, secretKey: stored.secretKey };
}

export function readEncryptedWallet(storage) {
  const raw = storageOrThrow(storage).getItem(VAULT_STORAGE_KEY);
  if (!raw) return null;
  const vault = JSON.parse(raw);
  if (!isEncryptedWallet(vault)) throw new Error('Encrypted wallet storage is malformed.');
  return vault;
}

export function writeEncryptedWallet(vault, storage) {
  if (!isEncryptedWallet(vault)) throw new Error('Refusing to store an unencrypted wallet.');
  storageOrThrow(storage).setItem(VAULT_STORAGE_KEY, JSON.stringify(vault));
}

export function wipeLegacyWallet(storage) {
  storageOrThrow(storage).removeItem(LEGACY_STORAGE_KEY);
}

/** Derives the public key from secret material and returns only an encrypted vault. */
export async function createEncryptedWallet(secretKey, password) {
  const secret = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey);
  if (secret.length !== nacl.sign.secretKeyLength) {
    throw new Error('Expected a 64-byte Ed25519 secret key.');
  }
  return encryptWallet(publicKeyFromSecret(secret), secret, password);
}

/**
 * Encrypts an existing plaintext v1 entry into the v2 vault, then removes the
 * plaintext entry. Returns null when there is nothing to migrate.
 */
export async function migrateLegacyWallet(password, storage) {
  const legacy = readLegacyWallet(storage);
  if (!legacy) return null;
  const secret = decodeBase64(legacy.secretKey, nacl.sign.secretKeyLength);
  const vault = await encryptWallet(legacy.publicKey, secret, password);
  writeEncryptedWallet(vault, storage);
  wipeLegacyWallet(storage);
  secret.fill(0);
  return { publicKey: legacy.publicKey, vault };
}

/**
 * Loads wallet state without ever returning secret key material. A detected
 * plaintext v1 entry is flagged for immediate migration by the caller.
 */
export function readWalletState(storage) {
  const vault = readEncryptedWallet(storage);
  if (vault) {
    return {
      wallet: { publicKey: vault.publicKey, protected: true, legacy: false },
      vault,
      needsMigration: false
    };
  }
  const legacy = readLegacyWallet(storage);
  if (legacy) {
    return {
      wallet: { publicKey: legacy.publicKey, protected: false, legacy: true },
      vault: null,
      needsMigration: true
    };
  }
  return { wallet: null, vault: null, needsMigration: false };
}

/** Decrypts, signs, and zeroes the in-memory secret on every path. */
export async function signWithVault(vault, password, message) {
  const secret = await decryptWallet(vault, password);
  try {
    return nacl.sign.detached(message, secret);
  } finally {
    secret.fill(0);
  }
}
