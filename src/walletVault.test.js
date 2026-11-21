// F-01 regression coverage: plaintext keys must never be persisted, and every
// creation/import/migration/signing path must go through the encrypted vault.

import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'nacl';
import {
  LEGACY_STORAGE_KEY,
  VAULT_STORAGE_KEY,
  createEncryptedWallet,
  decryptWallet,
  encryptWallet,
  isEncryptedWallet,
  migrateLegacyWallet,
  readEncryptedWallet,
  readLegacyWallet,
  readWalletState,
  signWithVault,
  wipeLegacyWallet,
  writeEncryptedWallet
} from './walletVault.js';

const PASSWORD = 'correct horse battery staple';

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}

function legacyEntry(pair) {
  return {
    [LEGACY_STORAGE_KEY]: JSON.stringify({
      publicKey: base64(pair.publicKey),
      secretKey: base64(pair.secretKey)
    })
  };
}

test('vault round-trip encrypts and decrypts the exact Ed25519 secret', async () => {
  const pair = nacl.sign.keyPair();
  const vault = await encryptWallet(base64(pair.publicKey), pair.secretKey, PASSWORD);
  assert.equal(isEncryptedWallet(vault), true);
  assert.equal(vault.version, 2);
  assert.equal(vault.secretKey, undefined);
  assert.equal(Buffer.from(vault.ciphertext, 'base64').length, 80); // 64-byte key + 16-byte GCM tag
  const decrypted = await decryptWallet(vault, PASSWORD);
  assert.deepEqual(decrypted, pair.secretKey);
  await assert.rejects(decryptWallet(vault, 'wrong password staple'), /password is incorrect/);
});

test('createEncryptedWallet returns a vault and never writes plaintext', async () => {
  const pair = nacl.sign.keyPair();
  const storage = memoryStorage();
  const vault = await createEncryptedWallet(pair.secretKey, PASSWORD);
  writeEncryptedWallet(vault, storage);
  assert.equal(vault.publicKey, base64(pair.publicKey));
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);
  assert.equal(storage.dump()[VAULT_STORAGE_KEY], JSON.stringify(vault));
  assert.equal(JSON.stringify(storage.dump()).includes(base64(pair.secretKey)), false);
  await assert.rejects(createEncryptedWallet(new Uint8Array(3), PASSWORD), /64-byte/);
});

test('readWalletState flags a legacy plaintext entry and hides the secret', async () => {
  const pair = nacl.sign.keyPair();
  const storage = memoryStorage(legacyEntry(pair));
  const state = readWalletState(storage);
  assert.equal(state.needsMigration, true);
  assert.equal(state.vault, null);
  assert.equal(state.wallet.publicKey, base64(pair.publicKey));
  assert.equal(state.wallet.secretKey, undefined);
});

test('migrateLegacyWallet encrypts the legacy key, then deletes the plaintext entry', async () => {
  const pair = nacl.sign.keyPair();
  const storage = memoryStorage(legacyEntry(pair));
  const migrated = await migrateLegacyWallet(PASSWORD, storage);
  assert.equal(migrated.publicKey, base64(pair.publicKey));
  assert.equal(isEncryptedWallet(migrated.vault), true);
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);
  assert.equal(readLegacyWallet(storage), null);
  assert.deepEqual(await decryptWallet(readEncryptedWallet(storage), PASSWORD), pair.secretKey);
  assert.equal(JSON.stringify(storage.dump()).includes(base64(pair.secretKey)), false);
});

test('a protected wallet signs with a password and wipes the decrypted key', async () => {
  const pair = nacl.sign.keyPair();
  const storage = memoryStorage();
  writeEncryptedWallet(await createEncryptedWallet(pair.secretKey, PASSWORD), storage);
  const vault = readEncryptedWallet(storage);
  const message = new TextEncoder().encode('BNKR-MAINNET-V1 transfer');
  const signature = await signWithVault(vault, PASSWORD, message);
  assert.equal(nacl.sign.detached.verify(message, signature, pair.publicKey), true);
  await assert.rejects(signWithVault(vault, 'wrong password staple', message), /password is incorrect/);
});

test('vault backup JSON can be imported back into storage', async () => {
  const pair = nacl.sign.keyPair();
  const source = memoryStorage();
  const vault = await createEncryptedWallet(pair.secretKey, PASSWORD);
  writeEncryptedWallet(vault, source);
  const backup = JSON.parse(source.getItem(VAULT_STORAGE_KEY));

  const target = memoryStorage();
  writeEncryptedWallet(backup, target);
  wipeLegacyWallet(target);
  assert.deepEqual(await decryptWallet(readEncryptedWallet(target), PASSWORD), pair.secretKey);
  assert.equal(target.getItem(LEGACY_STORAGE_KEY), null);
});
