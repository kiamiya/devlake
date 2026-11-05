import type { GitHubPort } from 'github';
import type { IntegrationStatus } from '../shared/ipc-contract.js';
import { maskToken } from '../shared/mask.js';
import type { Settings, SettingsPatch } from '../shared/settings.js';
import { rebuildAll, type RebuildSummary } from './db/rebuild.js';
import type { Repositories } from './db/repositories.js';
import type { SecretVault } from './vault.js';

export class NoTokenError extends Error {
  constructor() {
    super('Aucun jeton GitHub enregistré.');
    this.name = 'NoTokenError';
  }
}

export interface CockpitDeps {
  repos: Repositories;
  vault: SecretVault;
  /** Fabrique le port GitHub à partir du jeton. */
  github: (token: string) => GitHubPort;
}

type GitHubCheck =
  { state: 'unchecked' } | { state: 'ok'; login: string } | { state: 'failed'; message: string };

/** Logique du cockpit derrière l'IPC ; aucune dépendance à Electron. */
export class CockpitService {
  private githubCheck: GitHubCheck = { state: 'unchecked' };

  constructor(private readonly deps: CockpitDeps) {}

  getSettings(): Settings {
    return this.deps.repos.settings.get();
  }

  updateSettings(patch: SettingsPatch): Settings {
    return this.deps.repos.settings.update(patch);
  }

  async getMaskedToken(): Promise<{ masked: string | null }> {
    const token = await this.deps.vault.getToken();
    return { masked: token === null ? null : maskToken(token) };
  }

  async setToken(token: string): Promise<{ masked: string | null }> {
    await this.deps.vault.setToken(token.trim());
    this.githubCheck = { state: 'unchecked' };
    await this.refreshGitHubStatus();
    return this.getMaskedToken();
  }

  async clearToken(): Promise<{ masked: string | null }> {
    await this.deps.vault.clearToken();
    this.githubCheck = { state: 'unchecked' };
    return { masked: null };
  }

  /** Vérifie le jeton auprès de GitHub ; lève l'erreur GitHub si le jeton est refusé. */
  async testToken(): Promise<{ login: string }> {
    const github = await this.githubPort();
    try {
      const user = await github.getAuthenticatedUser();
      this.githubCheck = { state: 'ok', login: user.login };
      return user;
    } catch (error) {
      this.githubCheck = {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  /** Vérifie le jeton sans lever d'erreur (démarrage, enregistrement). */
  async refreshGitHubStatus(): Promise<void> {
    try {
      await this.testToken();
    } catch (error) {
      // L'échec est déjà mémorisé par testToken pour la barre d'état.
      if (error instanceof NoTokenError) this.githubCheck = { state: 'unchecked' };
    }
  }

  async getStatus(): Promise<IntegrationStatus[]> {
    const token = await this.deps.vault.getToken();
    return [this.githubStatus(token !== null), auraStatus()];
  }

  private githubStatus(hasToken: boolean): IntegrationStatus {
    const base = { id: 'github', label: 'GitHub' } as const;
    if (!this.deps.vault.isAvailable()) {
      return {
        ...base,
        state: 'degraded',
        detail: 'Chiffrement du système indisponible : jeton non enregistrable.',
      };
    }
    if (!hasToken) return { ...base, state: 'absent', detail: 'Aucun jeton enregistré.' };
    switch (this.githubCheck.state) {
      case 'ok':
        return { ...base, state: 'ok', detail: `Connecté en tant que ${this.githubCheck.login}.` };
      case 'failed':
        return { ...base, state: 'degraded', detail: this.githubCheck.message };
      case 'unchecked':
        return { ...base, state: 'degraded', detail: 'Jeton pas encore vérifié.' };
    }
  }

  async rebuildCache(): Promise<RebuildSummary> {
    return rebuildAll(await this.githubPort(), this.deps.repos);
  }

  private async githubPort(): Promise<GitHubPort> {
    const token = await this.deps.vault.getToken();
    if (token === null) throw new NoTokenError();
    return this.deps.github(token);
  }
}

function auraStatus(): IntegrationStatus {
  return {
    id: 'aura',
    label: 'Pont Aura',
    state: 'absent',
    detail: 'Pas encore disponible (tâche T17).',
  };
}
