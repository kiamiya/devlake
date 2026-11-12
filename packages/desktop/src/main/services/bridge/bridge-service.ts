import {
  AuraBridge,
  AuraConfigError,
  AutomationRunner,
  connectMcpServer,
  connectMultiUpstream,
  EditorSync,
  mcpServerFrom,
  prepareEditorClone,
  probeEditor,
  qualifyToolName,
  type GitExec,
  type ProcessRunner,
  type AuditEntry,
  type AuraUpstream,
  type BridgeStatus,
  type Editor,
  type McpServerSpec,
  type MultiUpstream,
  type NamedMcpServer,
} from 'aura-bridge';
import type { GitHubPort } from 'github';
import { EDITORS as SHARED_EDITORS } from 'shared';
import { ProjectConfigSchema } from 'shared';
import { parse } from 'yaml';
import type { IntegrationStatus } from '../../../shared/ipc-contract.js';
import { PROJECT_CONFIG_PATH } from '../../db/rebuild.js';
import type { Repositories } from '../../db/repositories.js';
import type { SecretVault } from '../../vault.js';
import { McpImportError, resolveSecrets } from './mcp-secrets.js';

export const EDITORS: readonly Editor[] = SHARED_EDITORS;

/** Serveur principal du pont d'un éditeur : Aura pour les moteurs, blender-mcp pour Blender. */
export function primaryServer(editor: Editor): string {
  return editor === 'blender' ? 'blender' : 'aura';
}
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
  /** Connexion à un serveur MCP du poste (stdio ou HTTP) ; doublure en test. */
  connectUpstream?: (spec: McpServerSpec, name: string) => Promise<AuraUpstream>;
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
  /** Au moins un serveur MCP (Aura ou autre) configuré dans les réglages. */
  configured: boolean;
  /** Outils autorisés, préfixés par leur serveur (`aura__scene_list`). */
  allowedTools: string[];
  configuredPort: number;
  /** Serveurs MCP du pont : connecté, ou raison de l'échec (pont arrêté : non connecté). */
  servers: { name: string; connected: boolean; error: string | null }[];
}

/**
 * Serveurs MCP configurés pour un éditeur : le principal (`aura`, ou `blender` pour Blender),
 * puis les autres, dans l'ordre.
 */
export function configuredServers(
  settings: ReturnType<Repositories['settings']['get']>,
  editor: Editor,
): { name: string; config: string }[] {
  const main = settings.auraMcp[editor];
  return [
    ...(main === null ? [] : [{ name: primaryServer(editor), config: main }]),
    ...settings.extraMcp[editor],
  ];
}

/** Ponts Aura du cockpit : un par éditeur, démarrés et arrêtés à la demande de Kia. */
export class BridgeService {
  private readonly bridges = new Map<Editor, AuraBridge>();
  private readonly upstreams = new Map<Editor, MultiUpstream>();
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
    const upstream = status.running ? this.upstreams.get(editor) : undefined;
    return {
      ...status,
      configured: configuredServers(settings, editor).length > 0,
      allowedTools: this.allowed(editor),
      configuredPort: settings.auraBridge[editor].port,
      servers: configuredServers(settings, editor).map(({ name }) => {
        const error = upstream?.failures.get(name) ?? null;
        return {
          name,
          connected: upstream !== undefined && error === null && upstream.servers.includes(name),
          error,
        };
      }),
    };
  }

  /** Liste blanche, outils préfixés par leur serveur (anciennes entrées rattachées à Aura). */
  private allowed(editor: Editor): string[] {
    return [
      ...new Set(
        this.deps.repos.settings
          .get()
          .auraBridge[editor].allowedTools.map((t) => qualifyToolName(t, primaryServer(editor))),
      ),
    ];
  }

  list(): BridgeView[] {
    return EDITORS.map((e) => this.view(e));
  }

  async start(editor: Editor): Promise<BridgeView> {
    if (this.bridges.get(editor)?.status().running) return this.view(editor);
    const settings = this.deps.repos.settings.get();
    const configured = configuredServers(settings, editor);
    if (configured.length === 0)
      throw new BridgeConfigError(
        `Aucun serveur MCP pour ${editor} (Aura ou autre) : coller sa configuration dans les réglages.`,
      );
    const servers: NamedMcpServer[] = [];
    for (const { name, config } of configured) {
      try {
        // Secrets importés : rangés au coffre, résolus seulement ici.
        servers.push({
          name,
          spec: await resolveSecrets(mcpServerFrom(JSON.parse(config) as unknown), this.deps.vault),
        });
      } catch (error) {
        throw new BridgeConfigError(
          `Serveur MCP « ${name} » (${editor}) : ${error instanceof AuraConfigError || error instanceof McpImportError ? error.message : String(error)}`,
        );
      }
    }
    const connect = this.deps.connectUpstream ?? ((spec: McpServerSpec) => connectMcpServer(spec));
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
      allowedTools: (profile) => this.allowed(profile),
      // Aura et les autres serveurs du poste, outils préfixés par leur nom.
      connectUpstream: async () => {
        const multi = await connectMultiUpstream(
          servers.map((server) => ({
            name: server.name,
            connect: () => connect(server.spec, server.name),
          })),
        );
        this.upstreams.set(editor, multi);
        return multi;
      },
      // Clone dédié ouvert dans l'éditeur : dossier des clones des réglages (T19).
      // Blender : un clone par projet, celui du dépôt demandé.
      probe: (repo) =>
        probeEditor(
          this.deps.repos.settings.get().editorClonesDir,
          editor,
          undefined,
          editor === 'blender' ? repo : undefined,
        ),
      editorSync: new EditorSync({
        editor,
        currentClone: async (expectedRepo) => {
          const state = await probeEditor(
            this.deps.repos.settings.get().editorClonesDir,
            editor,
            undefined,
            editor === 'blender' ? expectedRepo : undefined,
          );
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
    this.upstreams.delete(editor);
    return this.view(editor);
  }

  /**
   * Prépare le clone dédié d'un projet de jeu dans le dossier des clones des réglages
   * (distinct de la copie de travail de Kia) : clone ou mise à jour, Git LFS.
   */
  /**
   * Prépare le clone dédié d'un projet de jeu : celui du moteur (Unity, Unreal), ou celui de
   * Blender (`for: 'blender'`), distinct pour travailler en parallèle.
   */
  async prepareClone(
    projectId: string,
    remoteUrl?: string,
    target: 'engine' | 'blender' = 'engine',
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
    const editor: Editor = target === 'blender' ? 'blender' : type;
    const result = await prepareEditorClone({
      clonesRoot: settings.editorClonesDir,
      owner: project.owner,
      repo: project.repo,
      editor,
      token: await this.deps.vault.get('github-token'),
      ...(this.deps.git ? { git: this.deps.git } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    });
    return { ...result, editor };
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
    const allowed = new Set(this.allowed(editor));
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
        [editor]: {
          ...current[editor],
          allowedTools: [
            ...new Set(tools.map((t) => qualifyToolName(t, primaryServer(editor)))),
          ].sort(),
        },
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
    // Un serveur MCP injoignable : ses outils manquent aux agents.
    const down = running.flatMap((b) =>
      b.servers
        .filter((s) => !s.connected)
        .map((s) => `${b.editor}/${s.name} : ${s.error ?? 'non connecté'}`),
    );
    return {
      ...base,
      state: down.length > 0 ? 'degraded' : 'ok',
      detail: [
        running
          .map(
            (b) =>
              `${b.editor} sur 127.0.0.1:${String(b.port)} (${b.servers.map((s) => s.name).join(', ')})${b.activeRun ? ` (run ${b.activeRun.runId})` : ''}`,
          )
          .join(' · '),
        ...(down.length > 0 ? [`Serveurs MCP injoignables : ${down.join(' ; ')}`] : []),
      ].join('. '),
    };
  }
}
