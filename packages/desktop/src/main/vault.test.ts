import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskToken } from '../shared/mask.js';
import { SafeStorageVault, VaultUnavailableError, type SafeStorageLike } from './vault.js';

/** Doublure de safeStorage : « chiffrement » réversible, jamais le texte en clair. */
function fakeSafeStorage(available = true, backend = 'dpapi'): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) =>
      Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join('')),
    decryptString: (buffer) =>
      Buffer.from(buffer.toString().split('').reverse().join(''), 'base64').toString(),
  };
}

describe('coffre safeStorage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentlake-vault-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('garde chaque secret dans son propre fichier', async () => {
    const vault = new SafeStorageVault(dir, fakeSafeStorage());
    await vault.set('github-token', 'a');
    await vault.set('claude-oauth-token', 'b');
    expect([await vault.get('github-token'), await vault.get('claude-oauth-token')]).toEqual([
      'a',
      'b',
    ]);
    expect(await vault.get('aura-bridge-secret')).toBeNull();
  });

  it('chiffre le jeton dans un fichier, le relit et l’efface', async () => {
    const vault = new SafeStorageVault(join(dir, 'sous-dossier'), fakeSafeStorage());
    const file = join(dir, 'sous-dossier', 'github-token.bin');
    expect(await vault.get('github-token')).toBeNull();
    await vault.set('github-token', 'ghp_secretsecret1234');
    expect(readFileSync(file).toString()).not.toContain('ghp_secret');
    expect(await vault.get('github-token')).toBe('ghp_secretsecret1234');
    await vault.clear('github-token');
    expect(await vault.get('github-token')).toBeNull();
  });

  it('refuse d’enregistrer sans chiffrement réel (indisponible ou texte clair sous Linux)', async () => {
    for (const storage of [fakeSafeStorage(false), fakeSafeStorage(true, 'basic_text')]) {
      const vault = new SafeStorageVault(dir, storage);
      expect(vault.isAvailable()).toBe(false);
      await expect(vault.set('github-token', 'ghp_x')).rejects.toBeInstanceOf(
        VaultUnavailableError,
      );
      expect(await vault.get('github-token')).toBeNull();
    }
  });

  it('remonte une erreur de lecture autre qu’un fichier absent', async () => {
    mkdirSync(join(dir, 'github-token.bin'));
    const vault = new SafeStorageVault(dir, fakeSafeStorage());
    await expect(vault.get('github-token')).rejects.toThrow();
  });
});

describe('masquage du jeton', () => {
  it.each([
    ['ghp_abcdefghijklmnop1234', 'ghp_••••••••1234'],
    ['github_pat_11ABCDEFG0123456789_wxyz', 'github_pat_••••••••wxyz'],
    ['tokenSansPrefixe9876', '••••••••9876'],
    ['court', '••••••••'],
    ['ghp_12345678', '••••••••'],
  ])('%s → %s', (token, masked) => {
    expect(maskToken(token)).toBe(masked);
  });
});
