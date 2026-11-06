import {
  auraCommandFrom,
  AuraBridge,
  AutomationRunner,
  connectStdioUpstream,
  EditorSync,
  prepareEditorClone,
  probeEditor,
  type GitExec,
  type ProcessRunner,
  type AuditEntry,
  type AuraCommand,
  type AuraUpstream,
  type BridgeStatus,
  type Editor,
} from 'aura-bridge';
import type { GitHubPort } from 'github';
import { ProjectConfigSchema } from 'shared';
import { parse } from 'yaml';
import type { IntegrationStatus } from '../../../shared/ipc-contract.js';
import { PROJECT_CONFIG_PATH } from '../../db/rebuild.js';
import type { Repositories } from '../../db/repositories.js';
import type { SecretVault } from '../../vault.js';

export const EDITORS: readonly Editor[] = ['unity', 'unreal'];
/** Entrées gardées en mémoire par pont pour le journal d'audit du cockpit. */
export const AUDIT_LIMIT = 500;

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeConfigError';
  }
}

export interface BridgeServiceDeps {
  repos: Repositories;
  vault: SecretVault;
  /** Lancement du serveur MCP d'Aura ; stdio en vrai, doublure en test. */
  connectUpstream?: (command: AuraCommand) => Promise<AuraUpstream>;
  /** Port imposé (tests : 0 = port libre). */
  portOverride?: number;
  /** GitHub (type des projets, pour préparer le clone de l'éditeur). */
  github?: () => Promise<GitHubPort>;
  /** Exécution de git (tests). */
  git?: GitExec;
  /** Lancement d'UnrealEditor-Cmd (tests). */
  runProcess?: ProcessRunner;
}

export interface BridgeView extends BridgeStatus {
  /** Configuration MCP d'Aura collée dans les réglages. */
  configured: boolean;
  allowedTools: string[];
  configuredPort: number;
}

/** Ponts Aura du cockpit : un par éditeur, démarrés et arrêtés à la demande de Kia. */
export class BridgeService {
  private readonly bridges = new Map<Editor, AuraBridge>();
  private readonly audits = new Map<Editor, AuditEntry[]>(EDITORS.map((e) => [e, []]));

  constructor(private readonly deps: BridgeServiceDeps) {}

  private view(editor: Editor): BridgeView {
    const settings = this.deps.repos.settings.get();
    const bridge = this.bridges.get(editor);
    const status: BridgeStatus = bridge?.status() ?? {
      editor,
      running: false,
      port: null,
      activeRun: null,
      lastCall: null,
    };
    return {
      ...status,
      configured: settings.auraMcp[editor] !== null,
      allowedTools: settings.auraBridge[editor].allowedTools,
      configuredPort: settings.auraBridge[editor].port,
    };
  }

  list(): BridgeView[] {
    return EDITORS.map((e) => this.view(e));
  }

  async start(editor: Editor): Promise<BridgeView> {
    if (this.bridges.get(editor)?.status().running) return this.view(editor);
    const settings = this.deps.repos.settings.get();
    const block = settings.auraMcp[editor];
    if (block === null)
      throw new BridgeConfigError(
        `Configuration MCP d’Aura (${editor}) absente : la coller dans les réglages.`,
      );
    const command = auraCommandFrom(JSON.parse(block) as unknown);
    const secret = await this.deps.vault.get('aura-bridge-secret');
    if (secret === null)
      throw new BridgeConfigError(
        'Secret du pont absent : il est créé avec le premier projet de jeu (bootstrap).',
      );
    const bridge = new AuraBridge({
      editor,
      port: this.deps.portOverride ?? settings.auraBridge[editor].port,
      secret,
      // Relu à chaque appel : une liste blanche modifiée s'applique sans redémarrer.
      allowedTools: (profile) => this.deps.repos.settings.get().auraBridge[profile].allowedTools,
      connectUpstream: () => (this.deps.connectUpstream ?? connectStdioUpstream)(command),
      // Clone dédié ouvert dans l'éditeur : dossier des clones des réglages (T19).
      probe: () => probeEditor(this.deps.repos.settings.get().editorClonesDir, editor),
      editorSync: new EditorSync({
        editor,
        currentClone: async () => {
          const state = await probeEditor(this.deps.repos.settings.get().editorClonesDir, editor);
          return state.open && state.clone !== null
            ? { clone: state.clone, repo: state.repo }
            : null;
        },
        token: () => this.deps.vault.get('github-token'),
        ...(this.deps.git ? { git: this.deps.git } : {}),
      }),
      // Unreal : tests d'automatisation de la CI sur le clone dédié (UnrealEditor-Cmd).
      ...(editor === 'unreal'
        ? {
            automation: new AutomationRunner({
              clonesRoot: () => this.deps.repos.settings.get().editorClonesDir,
              editorCmd: () => this.deps.repos.settings.get().unrealEditorCmd,
              token: () => this.deps.vault.get('github-token'),
              ...(this.deps.git ? { git: this.deps.git } : {}),
              ...(this.deps.runProcess ? { run: this.deps.runProcess } : {}),
            }),
          }
        : {}),
      onAudit: (entry) => {
        const list = this.audits.get(editor) ?? [];
        list.push(entry);
        if (list.length > AUDIT_LIMIT) list.splice(0, list.length - AUDIT_LIMIT);
        this.audits.set(editor, list);
      },
    });
    await bridge.start();
    this.bridges.set(editor, bridge);
    return this.view(editor);
  }

  async stop(editor: Editor): Promise<BridgeView> {
    await this.bridges.get(editor)?.stop();
    this.bridges.delete(editor);
    return this.view(editor);
  }

  /**
   * Prépare le clone dédié d'un projet de jeu dans le dossier des clones des réglages
   * (distinct de la copie de travail de Kia) : clone ou mise à jour, Git LFS.
   */
  async prepareClone(
    projectId: string,
    remoteUrl?: string,
  ): Promise<{ dir: string; created: boolean; editor: Editor; warnings: string[] }> {
    const settings = this.deps.repos.settings.get();
    if (settings.editorClonesDir === null)
      throw new BridgeConfigError(
        'Dossier des clones de l’éditeur absent : le choisir dans les réglages.',
      );
    const project = this.deps.repos.projects.list().find((p) => p.id === projectId);
    if (!project) throw new BridgeConfigError(`Projet inconnu du cockpit : ${projectId}.`);
    if (!this.deps.github) throw new BridgeConfigError('GitHub indisponible.');
    const github = await this.deps.github();
    const file = await github.getFile(
      { owner: project.owner, repo: project.repo },
      PROJECT_CONFIG_PATH,
    );
    const config = file ? ProjectConfigSchema.safeParse(parse(file.content)) : null;
    const type = config?.success ? config.data.type : null;
    if (type !== 'unity' && type !== 'unreal')
      throw new BridgeConfigError(`${projectId} n’est pas un projet de jeu (Unity ou Unreal).`);
    const result = await prepareEditorClone({
      clonesRoot: settings.editorClonesDir,
      owner: project.owner,
      repo: project.repo,
      editor: type,
      token: await this.deps.vault.get('github-token'),
      ...(this.deps.git ? { git: this.deps.git } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    });
    return { ...result, editor: type };
  }

  /** Port local d'un pont démarré (cible de la passerelle). */
  runningPort(editor: Editor): number | null {
    const status = this.bridges.get(editor)?.status();
    return status?.running ? status.port : null;
  }

  /** Interrupteur : révoque les jetons émis et ferme les sessions de tous les ponts. */
  async revokeAll(): Promise<void> {
    for (const bridge of this.bridges.values()) await bridge.revokeTokens();
  }

  async stopAll(): Promise<void> {
    for (const editor of EDITORS) await this.stop(editor);
  }

  /** Outils d'Aura (pont démarré) avec leur état dans la liste blanche. */
  async tools(editor: Editor): Promise<{ name: string; description: string; allowed: boolean }[]> {
    const allowed = new Set(this.deps.repos.settings.get().auraBridge[editor].allowedTools);
    const bridge = this.bridges.get(editor);
    const upstream = bridge ? await bridge.upstreamTools() : [];
    const known = new Set(upstream.map((t) => t.name));
    return [
      ...upstream.map((t) => ({ ...t, allowed: allowed.has(t.name) })),
      // Outils autorisés mais absents d'Aura (ou pont arrêté) : gardés visibles.
      ...[...allowed]
        .filter((name) => !known.has(name))
        .map((name) => ({ name, description: '', allowed: true })),
    ];
  }

  setAllowedTools(editor: Editor, tools: readonly string[]): BridgeView {
    const current = this.deps.repos.settings.get().auraBridge;
    this.deps.repos.settings.update({
      auraBridge: {
        ...current,
        [editor]: { ...current[editor], allowedTools: [...new Set(tools)].sort() },
      },
    });
    return this.view(editor);
  }

  /** Journal d'audit, le plus récent en premier. */
  audit(editor: Editor): AuditEntry[] {
    return [...(this.audits.get(editor) ?? [])].reverse();
  }

  /** État de l'intégration « Pont Aura » pour la barre d'état. */
  integrationStatus(): IntegrationStatus {
    const running = this.list().filter((b) => b.running);
    const base = { id: 'aura', label: 'Pont Aura' } as const;
    if (running.length === 0) return { ...base, state: 'absent', detail: 'Aucun pont démarré.' };
    return {
      ...base,
      state: 'ok',
      detail: running
        .map(
          (b) =>
            `${b.editor} sur 127.0.0.1:${String(b.port)}${b.activeRun ? ` (run ${b.activeRun.runId})` : ''}`,
        )
        .join(' · '),
    };
  }
}
