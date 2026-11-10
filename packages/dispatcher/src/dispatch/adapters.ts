import type { GitHubPort, RepoRef } from 'github';
import {
  DEFAULT_GLOBAL_CAP,
  type EditorId,
  GLOBAL_CONFIG_PATH,
  GLOBAL_CONFIG_REPOSITORY,
  parseGlobalConfig,
} from 'shared';
import { AGENT_WORKFLOW, type GlobalCap } from './dispatcher.js';
import {
  BRIDGE_SIGNATURE_HEADER,
  HEALTH_TOKEN_TTL_SECONDS,
  signBridgeToken,
  verifyBridgeResponse,
} from 'shared/bridge-token';

/**
 * Agents en cours dans les autres projets de la configuration globale : runs du workflow
 * d'agent pas encore terminés. Un projet illisible (droit Actions manquant sur le jeton) est
 * compté pour zéro, avec la raison au journal.
 */
async function otherProjectsAgents(
  configGithub: GitHubPort,
  current: RepoRef,
  projects: readonly string[],
): Promise<{ count: number; notes: string[] }> {
  let count = 0;
  const notes: string[] = [];
  for (const project of projects) {
    const [owner = '', repo = ''] = project.split('/');
    if (owner.toLowerCase() === current.owner.toLowerCase() && repo === current.repo) continue;
    try {
      const runs = await configGithub.listWorkflowRuns(
        { owner, repo },
        { workflow: AGENT_WORKFLOW },
      );
      count += runs.filter((r) => r.status !== 'completed').length;
    } catch (error) {
      notes.push(
        `agents de ${project} non comptés (${error instanceof Error ? error.message : String(error)}) : AGENTLAKE_CONFIG_TOKEN doit pouvoir lire les Actions de ce dépôt.`,
      );
    }
  }
  return { count, notes };
}

/**
 * Plafond global, lu dans `<propriétaire>/devlake-config` avec un jeton en lecture
 * (secret `AGENTLAKE_CONFIG_TOKEN`), et agents en cours des autres projets qui y sont
 * listés : C_global s'applique au total. Illisible : valeur par défaut du cockpit, expliquée.
 */
export async function readGlobalCap(
  configGithub: GitHubPort | null,
  current: RepoRef,
  /** Compte de Kia, propriétaire de devlake-config (dépôt d'organisation : pas le propriétaire). */
  account: string = current.owner,
): Promise<GlobalCap> {
  const owner = account;
  const fallback = (why: string): GlobalCap => ({
    cap: DEFAULT_GLOBAL_CAP,
    note: `Plafond global par défaut (${String(DEFAULT_GLOBAL_CAP)}) : ${why}`,
  });
  if (configGithub === null) return fallback('secret AGENTLAKE_CONFIG_TOKEN absent.');
  const ref = { owner, repo: GLOBAL_CONFIG_REPOSITORY };
  try {
    const file = await configGithub.getFile(ref, GLOBAL_CONFIG_PATH);
    if (!file)
      return fallback(`${GLOBAL_CONFIG_PATH} absent de ${owner}/${GLOBAL_CONFIG_REPOSITORY}.`);
    const parsed = parseGlobalConfig(file.content);
    if (!parsed.ok) return fallback(parsed.error);
    const others = await otherProjectsAgents(configGithub, current, parsed.value.projects);
    return {
      cap: parsed.value.maxConcurrentAgents,
      paused: parsed.value.paused,
      otherAgents: others.count,
      ...(others.notes.length > 0 ? { note: `Plafond global : ${others.notes.join(' ; ')}` } : {}),
    };
  } catch (error) {
    return fallback(
      `lecture de ${owner}/${GLOBAL_CONFIG_REPOSITORY} impossible (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Minutes Actions restantes. Dépôt public : illimitées. Dépôt privé : lues par l'API de
 * facturation avec le secret facultatif `AGENTLAKE_BILLING_TOKEN` ; sans lui, pas de bridage.
 */
export async function readMinutesRemaining(
  github: GitHubPort,
  ref: RepoRef,
  billingToken: string | null,
  fetchFn: Fetch,
  account: string = ref.owner,
): Promise<{ minutes: number | null; note?: string }> {
  const repository = await github.getRepository(ref);
  if (!repository.private) return { minutes: null };
  if (billingToken === null)
    return {
      minutes: null,
      note: 'Dépôt privé sans AGENTLAKE_BILLING_TOKEN : minutes Actions non vérifiées.',
    };
  try {
    const response = await fetchFn(
      // Dépôt d'organisation : minutes facturées à l'organisation.
      account.toLowerCase() === ref.owner.toLowerCase()
        ? `https://api.github.com/users/${encodeURIComponent(ref.owner)}/settings/billing/actions`
        : `https://api.github.com/orgs/${encodeURIComponent(ref.owner)}/settings/billing/actions`,
      {
        headers: {
          authorization: `Bearer ${billingToken}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const data = (await response.json()) as {
      total_minutes_used?: unknown;
      included_minutes?: unknown;
    };
    const used = Number(data.total_minutes_used);
    const included = Number(data.included_minutes);
    if (!Number.isFinite(used) || !Number.isFinite(included)) throw new Error('réponse inattendue');
    return { minutes: Math.max(0, Math.floor(included - used)) };
  } catch (error) {
    return {
      minutes: null,
      note: `Minutes Actions illisibles (${error instanceof Error ? error.message : String(error)}) : pas de bridage.`,
    };
  }
}

export interface HealthCheckInput {
  /** URL publique du pont de l'éditeur (variable AURA_BRIDGE_URL du projet). */
  url: string | null;
  secret: string | null;
  repo: string;
  runId: string;
  editor: EditorId;
}

/** Âge maximal d'une réponse de santé acceptée (anti-rejeu). */
const HEALTH_MAX_AGE_MS = 5 * 60_000;

/**
 * Santé du pont Aura : `GET <AURA_BRIDGE_URL>/health` avec un jeton de santé signé, puis
 * vérification de la réponse signée. Sain seulement si Aura répond et si l'éditeur est
 * ouvert sur le clone de ce projet ; sinon la raison est écrite dans le journal.
 */
export async function checkBridgeHealth(
  input: HealthCheckInput,
  fetchFn: Fetch,
  now: () => Date,
  log: (line: string) => void,
): Promise<boolean> {
  const unhealthy = (why: string) => {
    log(`Pont Aura (${input.editor}) indisponible : ${why}`);
    return false;
  };
  if (input.url === null) return unhealthy('variable AURA_BRIDGE_URL absente (tunnel fermé ?).');
  if (input.secret === null) return unhealthy('secret AURA_BRIDGE_SECRET absent.');
  const issued = Math.floor(now().getTime() / 1000);
  const token = signBridgeToken(
    {
      repo: input.repo,
      runId: input.runId,
      profile: input.editor,
      scope: 'health',
      iat: issued,
      exp: issued + HEALTH_TOKEN_TTL_SECONDS,
    },
    input.secret,
  );
  let response: Response;
  try {
    response = await fetchFn(`${input.url.replace(/\/+$/, '')}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return unhealthy(`injoignable (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!response.ok) return unhealthy(`réponse HTTP ${String(response.status)}.`);
  const body = await response.text();
  const signature = response.headers.get(BRIDGE_SIGNATURE_HEADER) ?? '';
  if (!verifyBridgeResponse(body, signature, input.secret))
    return unhealthy('réponse non signée par le pont : ignorée.');
  let report: {
    aura?: unknown;
    editorOpen?: unknown;
    project?: unknown;
    branch?: unknown;
    at?: unknown;
    requestedBy?: { runId?: unknown };
  };
  try {
    report = JSON.parse(body) as typeof report;
  } catch {
    return unhealthy('réponse illisible.');
  }
  const age = now().getTime() - Date.parse(typeof report.at === 'string' ? report.at : '');
  if (report.requestedBy?.runId !== input.runId || !(age < HEALTH_MAX_AGE_MS))
    return unhealthy('réponse périmée ou destinée à un autre run.');
  if (report.aura !== true) return unhealthy('le serveur MCP d’Aura ne répond pas.');
  if (report.editorOpen !== true) return unhealthy('éditeur fermé sur le poste.');
  if (report.project !== input.repo)
    return unhealthy(
      `éditeur ouvert sur ${typeof report.project === 'string' ? report.project : 'un autre projet'}, pas sur ${input.repo}.`,
    );
  log(
    `Pont Aura (${input.editor}) sain : éditeur ouvert sur ${input.repo}${typeof report.branch === 'string' ? ` (${report.branch})` : ''}.`,
  );
  return true;
}

/** Compte du bot qui agit avec le GITHUB_TOKEN : le dispatcher lui-même. */
export const DISPATCHER_BOT = 'github-actions[bot]';

interface RepoName {
  full_name?: unknown;
}

/**
 * Dépôt de tête d'un événement lié à du code (PR, suite de checks, run de workflow), s'il
 * diffère du dépôt de l'événement : l'événement vient d'un fork.
 */
export function forkOrigin(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    repository?: RepoName;
    pull_request?: { head?: { repo?: RepoName | null } };
    check_suite?: { head_repository?: RepoName | null };
    workflow_run?: { head_repository?: RepoName | null };
  };
  const base = p.repository?.full_name;
  const head =
    p.pull_request !== undefined
      ? p.pull_request.head?.repo
      : p.check_suite !== undefined
        ? p.check_suite.head_repository
        : p.workflow_run?.head_repository;
  if (head === undefined || typeof base !== 'string') return null;
  // Dépôt de tête supprimé : traité comme un fork.
  if (head === null) return 'dépôt supprimé';
  return typeof head.full_name === 'string' && head.full_name !== base ? head.full_name : null;
}

/**
 * Filtre d'auteur : seuls le propriétaire du dépôt et le dispatcher déclenchent une passe, et
 * jamais un événement venant d'un fork (PR, CI ou run d'un compte tiers), même relayé par le
 * bot d'Actions. La passe planifiée (`schedule`) n'a pas d'auteur.
 */
export function eventAllowed(
  eventName: string,
  payload: unknown,
  owner: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (eventName === 'schedule') return { allowed: true };
  const fork = forkOrigin(payload);
  if (fork !== null)
    return {
      allowed: false,
      reason: `événement « ${eventName} » venant d’un fork (${fork}) : ignoré.`,
    };
  const sender =
    typeof payload === 'object' && payload !== null && 'sender' in payload
      ? (payload as { sender?: { login?: unknown } }).sender?.login
      : undefined;
  if (typeof sender !== 'string')
    return { allowed: false, reason: `événement « ${eventName} » sans auteur, ignoré.` };
  if (sender.toLowerCase() === owner.toLowerCase() || sender === DISPATCHER_BOT)
    return { allowed: true };
  return {
    allowed: false,
    reason: `événement « ${eventName} » de ${sender}, qui n’est ni ${owner} ni le dispatcher : ignoré.`,
  };
}
