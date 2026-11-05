import type { GitHubPort, RepoRef } from 'github';
import {
  DEFAULT_GLOBAL_CAP,
  GLOBAL_CONFIG_PATH,
  GLOBAL_CONFIG_REPOSITORY,
  parseGlobalConfig,
} from 'shared';
import type { GlobalCap } from './dispatcher.js';

/**
 * Plafond global, lu dans `<propriétaire>/devlake-config` avec un jeton en lecture
 * (secret `AGENTLAKE_CONFIG_TOKEN`). Illisible : valeur par défaut du cockpit, expliquée.
 */
export async function readGlobalCap(
  configGithub: GitHubPort | null,
  owner: string,
): Promise<GlobalCap> {
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
    return parsed.ok ? { cap: parsed.value.maxConcurrentAgents } : fallback(parsed.error);
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
      `https://api.github.com/users/${encodeURIComponent(ref.owner)}/settings/billing/actions`,
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

/** Santé du pont Aura : `GET <AURA_BRIDGE_URL>/health` répond 2xx. */
export async function checkBridgeHealth(url: string | null, fetchFn: Fetch): Promise<boolean> {
  if (url === null) return false;
  try {
    const response = await fetchFn(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Compte du bot qui agit avec le GITHUB_TOKEN : le dispatcher lui-même. */
export const DISPATCHER_BOT = 'github-actions[bot]';

/**
 * Filtre d'auteur : seuls le propriétaire du dépôt et le dispatcher déclenchent une passe.
 * La passe planifiée (`schedule`) n'a pas d'auteur.
 */
export function eventAllowed(
  eventName: string,
  payload: unknown,
  owner: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (eventName === 'schedule') return { allowed: true };
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
