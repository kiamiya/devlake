import {
  BridgeGateway,
  CloudflareTunnel,
  TailscaleFunnel,
  type Editor,
  type TunnelProvider,
} from 'aura-bridge';
import type { GitHubPort } from 'github';
import { ProjectConfigSchema, stateLabel, TASK_LABEL } from 'shared';
import { parse } from 'yaml';
import type { IntegrationStatus } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import { PROJECT_CONFIG_PATH } from '../../db/rebuild.js';
import type { BridgeService } from './bridge-service.js';

/** Variable de dépôt lue par l'agent et le dispatcher : URL publique du pont de l'éditeur. */
export const BRIDGE_URL_VARIABLE = 'AURA_BRIDGE_URL';
/** Variable de dépôt du pont Blender (agents Artiste 3D des projets de jeu). */
export const BLENDER_URL_VARIABLE = 'BLENDER_BRIDGE_URL';

/** États d'une tâche de jeu qui justifient d'exposer le pont. */
const NEEDS_BRIDGE = ['ready', 'running', 'waiting-editor', 'fixing'].map((s) =>
  stateLabel(s as Parameters<typeof stateLabel>[0]),
);

export interface TunnelState {
  open: boolean;
  url: string | null;
  provider: 'tailscale' | 'cloudflare';
  /** Interrupteur actionné : l'exposition automatique ne rouvre pas le tunnel. */
  killed: boolean;
  autoExpose: boolean;
  /** Projets de jeu dont la variable AURA_BRIDGE_URL a été mise à jour. */
  projects: { id: string; editor: Editor; url: string }[];
  error: string | null;
}

export interface TunnelDeps {
  repos: Repositories;
  github: () => Promise<GitHubPort>;
  bridges: BridgeService;
  provider?: (name: 'tailscale' | 'cloudflare') => TunnelProvider;
  gateway?: BridgeGateway;
}

/**
 * Tunnel du cockpit : une passerelle locale (un chemin par éditeur) publiée par Tailscale
 * Funnel ou Cloudflare Tunnel ; l'URL va dans la variable AURA_BRIDGE_URL des projets de jeu.
 */
export class TunnelService {
  private provider: TunnelProvider | null = null;
  private readonly gateway: BridgeGateway;
  private url: string | null = null;
  private killed = false;
  private error: string | null = null;
  private projects: TunnelState['projects'] = [];

  constructor(private readonly deps: TunnelDeps) {
    this.gateway = deps.gateway ?? new BridgeGateway((editor) => deps.bridges.runningPort(editor));
  }

  state(): TunnelState {
    const settings = this.deps.repos.settings.get().tunnel;
    return {
      open: this.url !== null,
      url: this.url,
      provider: settings.provider,
      killed: this.killed,
      autoExpose: settings.autoExpose,
      projects: this.projects,
      error: this.error,
    };
  }

  /** État du tunnel pour la barre d'état : fermé, ouvert, ou DÉGRADÉ avec sa raison. */
  integrationStatus(): IntegrationStatus {
    const base = { id: 'tunnel', label: 'Tunnel' } as const;
    const settings = this.deps.repos.settings.get().tunnel;
    if (this.killed)
      return {
        ...base,
        state: 'degraded',
        detail: 'Interrupteur actionné : tunnel coupé et jetons révoqués, ouverture à la main.',
      };
    if (this.error !== null)
      return { ...base, state: 'degraded', detail: `Ouverture en échec : ${this.error}` };
    if (this.url !== null)
      return { ...base, state: 'ok', detail: `Ouvert (${settings.provider}) : ${this.url}` };
    return {
      ...base,
      state: 'absent',
      detail: settings.autoExpose
        ? 'Fermé : ouvert automatiquement quand une tâche de jeu en a besoin.'
        : 'Fermé.',
    };
  }

  /** Ouvre le tunnel et publie l'URL dans les projets de jeu. */
  async open(): Promise<TunnelState> {
    this.killed = false;
    if (this.url !== null) return this.state();
    const settings = this.deps.repos.settings.get().tunnel;
    try {
      const port = await this.gateway.start(settings.gatewayPort);
      const provider = (this.deps.provider ?? defaultProvider)(settings.provider);
      this.url = (await provider.start(port)).replace(/\/+$/, '');
      this.provider = provider;
      this.error = null;
    } catch (error) {
      await this.gateway.stop();
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    await this.publish(this.url);
    return this.state();
  }

  async close(): Promise<TunnelState> {
    await this.provider?.stop();
    this.provider = null;
    await this.gateway.stop();
    this.url = null;
    return this.state();
  }

  /** Interrupteur d'arrêt : coupe le tunnel et révoque les jetons en cours. */
  async kill(): Promise<TunnelState> {
    this.killed = true;
    await this.deps.bridges.revokeAll();
    return this.close();
  }

  /**
   * Exposition automatique (sondage du cockpit) : tunnel ouvert seulement si un pont tourne
   * et qu'un projet de jeu a une tâche prête, en cours, en correction ou en attente de l'éditeur.
   */
  async tick(): Promise<TunnelState> {
    const settings = this.deps.repos.settings.get().tunnel;
    if (!settings.autoExpose || this.killed) return this.state();
    const bridgeRunning = this.deps.bridges.list().some((b) => b.running);
    const needed = bridgeRunning && (await this.gameTaskWaiting());
    if (needed && this.url === null) {
      await this.open().catch(() => undefined);
    } else if (!needed && this.url !== null) {
      await this.close();
    }
    return this.state();
  }

  /** Projets de jeu connus du cockpit et leur éditeur (type dans project.yml). */
  private async gameProjects(github: GitHubPort) {
    const found: { id: string; ref: { owner: string; repo: string }; editor: Editor }[] = [];
    for (const project of this.deps.repos.projects.list()) {
      const ref = { owner: project.owner, repo: project.repo };
      const file = await github.getFile(ref, PROJECT_CONFIG_PATH).catch(() => null);
      const config = file ? ProjectConfigSchema.safeParse(parse(file.content)) : null;
      const type = config?.success ? config.data.type : null;
      if (type === 'unity' || type === 'unreal') found.push({ id: project.id, ref, editor: type });
    }
    return found;
  }

  private async gameTaskWaiting(): Promise<boolean> {
    const github = await this.deps.github();
    for (const project of await this.gameProjects(github)) {
      const issues = await github.listIssues(project.ref, { labels: [TASK_LABEL], state: 'open' });
      if (issues.some((i) => i.labels.some((l) => NEEDS_BRIDGE.includes(l)))) return true;
    }
    return false;
  }

  private async publish(url: string): Promise<void> {
    const github = await this.deps.github();
    this.projects = [];
    for (const project of await this.gameProjects(github)) {
      const projectUrl = `${url}/${project.editor}`;
      await github.setRepositoryVariable(project.ref, BRIDGE_URL_VARIABLE, projectUrl);
      this.projects.push({ id: project.id, editor: project.editor, url: projectUrl });
      // Agents Artiste 3D du projet : pont Blender, même tunnel.
      const blenderUrl = `${url}/blender`;
      await github.setRepositoryVariable(project.ref, BLENDER_URL_VARIABLE, blenderUrl);
      this.projects.push({ id: project.id, editor: 'blender', url: blenderUrl });
    }
  }
}

/* c8 ignore next 2 -- fournisseurs réels : outils système */
const defaultProvider = (name: 'tailscale' | 'cloudflare'): TunnelProvider =>
  name === 'tailscale' ? new TailscaleFunnel() : new CloudflareTunnel();
