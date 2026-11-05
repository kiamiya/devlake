import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Coffre du jeton GitHub. Le jeton n'est jamais en base ni dans les journaux. */
export interface SecretVault {
  /** Faux si le système ne peut pas chiffrer (le jeton ne sera alors pas enregistré). */
  isAvailable(): boolean;
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}

export class VaultUnavailableError extends Error {
  constructor() {
    super('Chiffrement du système indisponible : le jeton ne peut pas être enregistré.');
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

/** Jeton chiffré par `safeStorage` (DPAPI, Trousseau, libsecret) dans un fichier du profil. */
export class SafeStorageVault implements SecretVault {
  constructor(
    private readonly file: string,
    private readonly safeStorage: SafeStorageLike,
  ) {}

  isAvailable(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    // Sous Linux sans trousseau, Electron « chiffre » en clair : on refuse.
    return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  async getToken(): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      return this.safeStorage.decryptString(await readFile(this.file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async setToken(token: string): Promise<void> {
    if (!this.isAvailable()) throw new VaultUnavailableError();
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, this.safeStorage.encryptString(token), { mode: 0o600 });
  }

  async clearToken(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** Coffre en mémoire pour les tests. */
export class MemoryVault implements SecretVault {
  private token: string | null = null;

  constructor(private readonly available = true) {}

  isAvailable(): boolean {
    return this.available;
  }

  getToken(): Promise<string | null> {
    return Promise.resolve(this.token);
  }

  setToken(token: string): Promise<void> {
    if (!this.available) return Promise.reject(new VaultUnavailableError());
    this.token = token;
    return Promise.resolve();
  }

  clearToken(): Promise<void> {
    this.token = null;
    return Promise.resolve();
  }
}
