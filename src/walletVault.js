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
