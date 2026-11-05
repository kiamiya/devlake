import { AgentProfileSchema, formatZodError, type AgentProfile } from 'shared';
import { parse } from 'yaml';

export const PROFILES_DIR = '.agentlake/profiles';

export function profilePath(id: string): string {
  return `${PROFILES_DIR}/${id}.yml`;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** Lit un profil `.agentlake/profiles/<id>.yml`, validé par le schéma partagé. */
export function parseProfile(text: string | null, expectedId: string): AgentProfile {
  if (text === null) throw new ProfileError(`Profil introuvable : ${profilePath(expectedId)}.`);
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new ProfileError(
      `${profilePath(expectedId)} n’est pas un YAML valide : ${(error as Error).message}`,
    );
  }
  const parsed = AgentProfileSchema.safeParse(data);
  if (!parsed.success)
    throw new ProfileError(
      `${profilePath(expectedId)} est invalide :\n${formatZodError(parsed.error)}`,
    );
  if (parsed.data.id !== expectedId) {
    throw new ProfileError(`${profilePath(expectedId)} décrit le profil « ${parsed.data.id} ».`);
  }
  return parsed.data;
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
 * viennent du profil, jamais d'une valeur codée en dur.
 */
export function claudeArgs(profile: AgentProfile): string {
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
  return args.join(' ');
}
