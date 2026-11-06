import type { GitHubPort } from 'github';
import {
  GLOBAL_CONFIG_PATH,
  GLOBAL_CONFIG_REPOSITORY,
  mainProtectionProblems,
  parseGlobalConfig,
  ProjectConfigSchema,
} from 'shared';
import { parse } from 'yaml';
import type { IntegrationStatus } from '../shared/ipc-contract.js';
import { maskToken } from '../shared/mask.js';
import type { Settings, SettingsPatch } from '../shared/settings.js';
import { PROJECT_CONFIG_PATH, rebuildAll, type RebuildSummary } from './db/rebuild.js';
import type { Repositories } from './db/repositories.js';
import { GlobalConfigSyncError, publishGlobalConfig } from './services/global-config.js';
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
  /** État des ponts Aura (absent tant que le cockpit n'en démarre aucun). */
  bridgeStatus?: () => IntegrationStatus;
  /** État du tunnel vers la passerelle des ponts. */
  tunnelStatus?: () => IntegrationStatus;
}

type GitHubCheck =
  { state: 'unchecked' } | { state: 'ok'; login: string } | { state: 'failed'; message: string };
type ConfigCheck = { state: 'unchecked' } | { state: 'ok' } | { state: 'failed'; message: string };

/** Logique du cockpit derrière l'IPC ; aucune dépendance à Electron. */
export class CockpitService {
  private githubCheck: GitHubCheck = { state: 'unchecked' };
  private configCheck: ConfigCheck = { state: 'unchecked' };
  /** Projets dont `main` n'est plus protégée comme au bootstrap. */
  private protectionIssues: string[] = [];

  constructor(private readonly deps: CockpitDeps) {}

  getSettings(): Settings {
    return this.deps.repos.settings.get();
  }

  /**
   * Enregistre les réglages. Un plafond global modifié est publié dans `devlake-config`,
   * où les dispatchers le lisent (sans jeton GitHub, il le sera au prochain changement).
   */
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const previous = this.deps.repos.settings.get();
    const settings = this.deps.repos.settings.update(patch);
    if (
      settings.maxConcurrentAgents === previous.maxConcurrentAgents &&
      settings.globalPaused === previous.globalPaused
    )
      return settings;
    if ((await this.deps.vault.get('github-token')) === null) return settings;
    await this.syncGlobalConfig();
    return settings;
  }

  /** Configuration globale attendue : réglages et projets connus du cockpit. */
  private desiredGlobalConfig() {
    const settings = this.deps.repos.settings.get();
    return {
      maxConcurrentAgents: settings.maxConcurrentAgents,
      paused: settings.globalPaused,
      projects: this.deps.repos.projects
        .list()
        .map((p) => p.id)
        .sort(),
    };
  }

  /**
   * Publie la configuration globale (plafond, pause, projets) dans devlake-config ; les
   * dispatchers y comptent les agents de tous les projets. Sans jeton : rien.
   */
  async syncGlobalConfig(): Promise<void> {
    if ((await this.deps.vault.get('github-token')) === null) return;
    try {
      await publishGlobalConfig(await this.githubPort(), this.desiredGlobalConfig());
      this.configCheck = { state: 'ok' };
    } catch (error) {
      this.configCheck = {
        state: 'failed',
        message: `Publication dans ${GLOBAL_CONFIG_REPOSITORY} en échec : ${error instanceof Error ? error.message : String(error)}`,
      };
      throw new GlobalConfigSyncError(error);
    }
  }

  /**
   * Configuration globale lue dans devlake-config et comparée aux réglages : les dispatchers
   * appliquent ce qu'ils y lisent, pas ce que montre le cockpit.
   */
  async refreshConfigStatus(): Promise<void> {
    if ((await this.deps.vault.get('github-token')) === null) {
      this.configCheck = { state: 'unchecked' };
      return;
    }
    const failed = (message: string) => {
      this.configCheck = { state: 'failed', message };
    };
    try {
      const github = await this.githubPort();
      const owner = (await github.getAuthenticatedUser()).login;
      const file = await github.getFile(
        { owner, repo: GLOBAL_CONFIG_REPOSITORY },
        GLOBAL_CONFIG_PATH,
      );
      if (file === null) {
        failed(
          `${GLOBAL_CONFIG_REPOSITORY} pas encore publié : les dispatchers appliquent le plafond par défaut.`,
        );
        return;
      }
      const parsed = parseGlobalConfig(file.content);
      if (!parsed.ok) {
        failed(`${GLOBAL_CONFIG_PATH} illisible : ${parsed.error}`);
        return;
      }
      const settings = this.deps.repos.settings.get();
      if (
        parsed.value.maxConcurrentAgents !== settings.maxConcurrentAgents ||
        parsed.value.paused !== settings.globalPaused
      ) {
        failed(
          `${GLOBAL_CONFIG_REPOSITORY} diffère des réglages (plafond ${String(parsed.value.maxConcurrentAgents)}, pause ${parsed.value.paused ? 'active' : 'inactive'}) : enregistrer à nouveau les réglages.`,
        );
        return;
      }
      // Liste des projets périmée (projet ajouté ailleurs) : republiée sans rien demander.
      const projects = this.desiredGlobalConfig().projects;
      if ([...parsed.value.projects].sort().join() !== projects.join()) {
        await this.syncGlobalConfig();
        return;
      }
      this.configCheck = { state: 'ok' };
    } catch (error) {
      failed(
        `Lecture de ${GLOBAL_CONFIG_REPOSITORY} impossible : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Protection de `main` de chaque projet, comparée à celle du bootstrap. Les dispatchers
   * ne lancent plus d'agent sur un projet dont `main` n'est plus protégée.
   */
  async refreshProtection(): Promise<void> {
    if ((await this.deps.vault.get('github-token')) === null) {
      this.protectionIssues = [];
      return;
    }
    const github = await this.githubPort();
    const issues: string[] = [];
    for (const project of this.deps.repos.projects.list()) {
      const ref = { owner: project.owner, repo: project.repo };
      try {
        const file = await github.getFile(ref, PROJECT_CONFIG_PATH, 'main');
        const config = file ? ProjectConfigSchema.safeParse(parse(file.content)) : null;
        if (!config?.success) continue;
        const protection = await github.getBranchProtection(ref, 'main');
        const problems = mainProtectionProblems(
          protection === null
            ? { protected: false, requiredChecks: [] }
            : { protected: true, requiredChecks: protection.requiredChecks },
          config.data.qualityProfile,
        );
        if (problems.length > 0) issues.push(`${project.id} (${problems.join(' ; ')})`);
      } catch (error) {
        issues.push(
          `${project.id} (vérification impossible : ${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    this.protectionIssues = issues;
  }

  /** Vérifications périodiques de la barre d'état (démarrage, puis toutes les 10 minutes). */
  async refreshHealth(): Promise<void> {
    await this.refreshGitHubStatus();
    await this.refreshConfigStatus().catch(() => undefined);
    await this.refreshProtection().catch(() => undefined);
  }

  async getMaskedToken(): Promise<{ masked: string | null }> {
    const token = await this.deps.vault.get('github-token');
    return { masked: token === null ? null : maskToken(token) };
  }

  async setToken(token: string): Promise<{ masked: string | null }> {
    await this.deps.vault.set('github-token', token.trim());
    this.githubCheck = { state: 'unchecked' };
    await this.refreshGitHubStatus();
    return this.getMaskedToken();
  }

  async clearToken(): Promise<{ masked: string | null }> {
    await this.deps.vault.clear('github-token');
    this.githubCheck = { state: 'unchecked' };
    return { masked: null };
  }

  /** Jeton d'abonnement Claude Code (claude setup-token), poussé dans chaque nouveau dépôt. */
  async getMaskedClaudeToken(): Promise<{ masked: string | null }> {
    const token = await this.deps.vault.get('claude-oauth-token');
    return { masked: token === null ? null : maskToken(token) };
  }

  async setClaudeToken(token: string): Promise<{ masked: string | null }> {
    await this.deps.vault.set('claude-oauth-token', token.trim());
    return this.getMaskedClaudeToken();
  }

  async clearClaudeToken(): Promise<{ masked: string | null }> {
    await this.deps.vault.clear('claude-oauth-token');
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
    const token = await this.deps.vault.get('github-token');
    return [
      this.githubStatus(token !== null),
      this.deps.bridgeStatus?.() ?? auraStatus(),
      this.deps.tunnelStatus?.() ?? closedTunnelStatus(),
      this.configStatus(token !== null),
    ];
  }

  private configStatus(hasToken: boolean): IntegrationStatus {
    const base = { id: 'config', label: 'Configuration globale' } as const;
    if (!hasToken) return { ...base, state: 'absent', detail: 'Aucun jeton GitHub enregistré.' };
    const settings = this.deps.repos.settings.get();
    switch (this.configCheck.state) {
      case 'failed':
        return { ...base, state: 'degraded', detail: this.configCheck.message };
      case 'unchecked':
        return {
          ...base,
          state: 'degraded',
          detail: `${GLOBAL_CONFIG_REPOSITORY} pas encore vérifié.`,
        };
      case 'ok':
        return settings.globalPaused
          ? {
              ...base,
              state: 'degraded',
              detail: 'Pause globale active : aucun agent n’est lancé, tous projets confondus.',
            }
          : {
              ...base,
              state: 'ok',
              detail: `Plafond de ${String(settings.maxConcurrentAgents)} agents publié dans ${GLOBAL_CONFIG_REPOSITORY}.`,
            };
    }
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
        return this.protectionIssues.length > 0
          ? {
              ...base,
              state: 'degraded',
              detail: `Connecté en tant que ${this.githubCheck.login}, mais main n’est plus protégée sur : ${this.protectionIssues.join(', ')}. Aucun agent n’y est lancé : relancer le bootstrap du projet.`,
            }
          : { ...base, state: 'ok', detail: `Connecté en tant que ${this.githubCheck.login}.` };
      case 'failed':
        return { ...base, state: 'degraded', detail: this.githubCheck.message };
      case 'unchecked':
        return { ...base, state: 'degraded', detail: 'Jeton pas encore vérifié.' };
    }
  }

  async rebuildCache(): Promise<RebuildSummary> {
    return rebuildAll(await this.githubPort(), this.deps.repos);
  }

  /** Port GitHub du jeton enregistré ; lève NoTokenError sans jeton. */
  async githubPort(): Promise<GitHubPort> {
    const token = await this.deps.vault.get('github-token');
    if (token === null) throw new NoTokenError();
    return this.deps.github(token);
  }
}

function closedTunnelStatus(): IntegrationStatus {
  return { id: 'tunnel', label: 'Tunnel', state: 'absent', detail: 'Tunnel fermé.' };
}

function auraStatus(): IntegrationStatus {
  return {
    id: 'aura',
    label: 'Pont Aura',
    state: 'absent',
    detail: 'Aucun pont démarré.',
  };
}
