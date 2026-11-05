import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Secrets gardés par le cockpit. */
export type SecretName = 'github-token' | 'claude-oauth-token' | 'aura-bridge-secret';

/** Coffre des secrets. Un secret n'est jamais en base ni dans les journaux. */
export interface SecretVault {
  /** Faux si le système ne peut pas chiffrer (aucun secret ne sera alors enregistré). */
  isAvailable(): boolean;
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  clear(name: SecretName): Promise<void>;
}

export class VaultUnavailableError extends Error {
  constructor() {
    super('Chiffrement du système indisponible : le secret ne peut pas être enregistré.');
    this.name = 'VaultUnavailableError';
  }
}

/** Sous-ensemble de `safeStorage` d'Electron utilisé par le coffre. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

/**
 * Secrets chiffrés par `safeStorage` (DPAPI, Trousseau, libsecret),
 * un fichier `<nom>.bin` par secret dans le dossier du profil.
 */
export class SafeStorageVault implements SecretVault {
  constructor(
    private readonly dir: string,
    private readonly safeStorage: SafeStorageLike,
  ) {}

  private file(name: SecretName): string {
    return join(this.dir, `${name}.bin`);
  }

  isAvailable(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    // Sous Linux sans trousseau, Electron « chiffre » en clair : on refuse.
    return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  async get(name: SecretName): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      return this.safeStorage.decryptString(await readFile(this.file(name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!this.isAvailable()) throw new VaultUnavailableError();
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(name), this.safeStorage.encryptString(value), { mode: 0o600 });
  }

  async clear(name: SecretName): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}

/** Coffre en mémoire pour les tests. */
export class MemoryVault implements SecretVault {
  private readonly values = new Map<SecretName, string>();

  constructor(private readonly available = true) {}

  isAvailable(): boolean {
    return this.available;
  }

  get(name: SecretName): Promise<string | null> {
    return Promise.resolve(this.values.get(name) ?? null);
  }

  set(name: SecretName, value: string): Promise<void> {
    if (!this.available) return Promise.reject(new VaultUnavailableError());
    this.values.set(name, value);
    return Promise.resolve();
  }

  clear(name: SecretName): Promise<void> {
    this.values.delete(name);
    return Promise.resolve();
  }
}
