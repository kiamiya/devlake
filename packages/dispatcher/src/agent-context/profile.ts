import {
  loadAgentProfile,
  PROFILE_ENV_VARIABLES,
  profilePath,
  type AgentProfile,
  type ProfileEnvVariable,
} from 'shared';

export { PROFILES_DIR, profilePath } from 'shared';

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** Lit un profil `.agentlake/profiles/<id>.yml`, validé par le schéma partagé. */
export function parseProfile(text: string | null, expectedId: string): AgentProfile {
  if (text === null) throw new ProfileError(`Profil introuvable : ${profilePath(expectedId)}.`);
  const loaded = loadAgentProfile(text, expectedId);
  if (!loaded.ok) throw new ProfileError(loaded.error);
  return loaded.value;
}

/** Valeurs des variables citées par les profils, lues dans l'environnement du job. */
export type ProfileEnv = Partial<Record<ProfileEnvVariable, string>>;

export function profileEnvFrom(env: NodeJS.ProcessEnv): ProfileEnv {
  return Object.fromEntries(
    PROFILE_ENV_VARIABLES.flatMap((name) => {
      const value = env[name];
      return value !== undefined && value !== '' ? [[name, value]] : [];
    }),
  );
}

export interface McpConfig {
  /** Contenu du fichier passé à `--mcp-config`. */
  json: string;
  /** Valeurs injectées hors URL (jetons), à masquer dans les journaux. */
  secrets: string[];
}

/**
 * Configuration MCP de l'agent : les `${NOM}` du profil sont remplacés par l'environnement
 * du job (URL du tunnel, jeton signé). `null` si le profil ne déclare aucun serveur.
 */
export function buildMcpConfig(profile: AgentProfile, env: ProfileEnv): McpConfig | null {
  const entries = Object.entries(profile.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  const used = new Set<ProfileEnvVariable>();
  const resolve = (text: string) =>
    text.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
      const key = name as ProfileEnvVariable;
      const value = env[key];
      if (value === undefined)
        throw new ProfileError(
          `Le profil « ${profile.id} » a besoin de ${name}, absent de l’environnement du job (pont Aura non configuré ?).`,
        );
      used.add(key);
      return value;
    });
  const mcpServers = Object.fromEntries(
    entries.map(([name, server]) => [
      name,
      {
        type: server.type,
        url: resolve(server.url),
        headers: Object.fromEntries(
          Object.entries(server.headers).map(([header, value]) => [header, resolve(value)]),
        ),
      },
    ]),
  );
  return {
    json: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    secrets: [...used].filter((name) => name !== 'AURA_BRIDGE_URL').map((name) => env[name] ?? ''),
  };
}

/** Sortie structurée demandée à Claude en fin de session. */
export const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['completed', 'blocked'] },
    pr_title: {
      type: 'string',
      description: 'Titre court de la PR, en français, sans identifiant de tâche.',
    },
    pr_summary: {
      type: 'string',
      description: 'Ce qui a été fait, les choix, comment tester (Markdown).',
    },
    blocked_reason: {
      type: 'string',
      description: 'Si outcome = blocked : ce qui manque pour avancer.',
    },
  },
  required: ['outcome', 'pr_title', 'pr_summary'],
  additionalProperties: false,
} as const;

/** Argument pour le CLI de Claude, protégé par des apostrophes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Arguments `claude_args` de claude-code-action : modèle, outils et nombre de tours
 * viennent du profil, jamais d'une valeur codée en dur. `mcpConfigPath` désigne le fichier
 * écrit hors du dépôt quand le profil déclare des serveurs MCP.
 */
export function claudeArgs(profile: AgentProfile, mcpConfigPath: string | null = null): string {
  const args = [
    '--model',
    quote(profile.model),
    '--max-turns',
    String(profile.maxTurns),
    '--append-system-prompt',
    quote(profile.systemPrompt),
    '--json-schema',
    quote(JSON.stringify(OUTCOME_SCHEMA)),
  ];
  if (profile.allowedTools.length > 0)
    args.push('--allowedTools', quote(profile.allowedTools.join(',')));
  if (mcpConfigPath !== null) args.push('--mcp-config', quote(mcpConfigPath));
  return args.join(' ');
}
