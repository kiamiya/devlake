/** Commande du serveur MCP d'Aura (stdio), lue dans le bloc collé depuis Aura. */
export interface AuraCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class AuraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuraConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Le bloc « MCP Configuration » d'Aura décrit un serveur stdio, seul ou sous
 * `mcpServers` / `servers`. On retient le premier serveur qui a une commande.
 */
export function auraCommandFrom(block: unknown): AuraCommand {
  if (!isRecord(block))
    throw new AuraConfigError('Configuration MCP d’Aura absente : la coller dans les réglages.');
  const candidates: unknown[] = [block];
  for (const key of ['mcpServers', 'servers']) {
    const group = block[key];
    if (isRecord(group)) candidates.push(...Object.values(group));
  }
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.command !== 'string' ||
      candidate.command.trim() === ''
    )
      continue;
    const args = Array.isArray(candidate.args)
      ? candidate.args.filter((a) => typeof a === 'string')
      : [];
    const env = isRecord(candidate.env)
      ? Object.fromEntries(
          Object.entries(candidate.env).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : {};
    return { command: candidate.command, args, env };
  }
  throw new AuraConfigError(
    'Aucune commande dans la configuration MCP d’Aura (champ « command »).',
  );
}
