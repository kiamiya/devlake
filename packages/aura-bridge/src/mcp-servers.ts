import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AuraConfigError } from './aura-command.js';
import type { McpServerSpec } from './types.js';
import type { AuraUpstream } from './upstream.js';

/**
 * Serveurs MCP du poste relayés par le pont d'un éditeur : Aura, et au besoin d'autres
 * serveurs (Unity MCP, Unreal MCP…). Chacun est lancé en stdio (commande) ou joint en HTTP
 * (URL locale), d'après le bloc de configuration collé dans le cockpit.
 */
export type { McpServerSpec } from './types.js';

/** Un serveur nommé : son nom préfixe ses outils (`<nom>__<outil>`). */
export interface NamedMcpServer {
  name: string;
  spec: McpServerSpec;
}

/** Séparateur entre le nom du serveur et celui de l'outil. */
export const TOOL_SEPARATOR = '__';
/** Nom d'un serveur : court, sans séparateur, utilisable dans un nom d'outil MCP. */
export const SERVER_NAME = /^[a-z][a-z0-9-]{0,30}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {};

/**
 * Lit un bloc de configuration MCP : un serveur seul, ou le premier sous `mcpServers` /
 * `servers`. Une commande donne un serveur stdio, une URL un serveur HTTP (local seulement).
 */
export function mcpServerFrom(block: unknown): McpServerSpec {
  if (!isRecord(block))
    throw new AuraConfigError('Configuration MCP absente : la coller dans les réglages.');
  const candidates: unknown[] = [block];
  for (const key of ['mcpServers', 'servers']) {
    const group = block[key];
    if (isRecord(group)) candidates.push(...Object.values(group));
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.command === 'string' && candidate.command.trim() !== '') {
      const args = Array.isArray(candidate.args)
        ? candidate.args.filter((a): a is string => typeof a === 'string')
        : [];
      return { kind: 'stdio', command: candidate.command, args, env: strings(candidate.env) };
    }
    if (typeof candidate.url === 'string' && candidate.url.trim() !== '') {
      let url: URL;
      try {
        url = new URL(candidate.url);
      } catch {
        throw new AuraConfigError(`URL du serveur MCP invalide : ${candidate.url}.`);
      }
      // Le pont relaie des outils du poste : un serveur distant n'a rien à y faire.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new AuraConfigError(
          `Le serveur MCP doit tourner sur le poste (127.0.0.1 ou localhost), pas sur ${url.hostname}.`,
        );
      return { kind: 'http', url: url.href, headers: strings(candidate.headers) };
    }
  }
  throw new AuraConfigError(
    'Aucun serveur dans la configuration MCP (champ « command » ou « url »).',
  );
}

/** `aura__scene_list` → { server: 'aura', tool: 'scene_list' } ; null sans préfixe. */
export function splitToolName(name: string): { server: string; tool: string } | null {
  const at = name.indexOf(TOOL_SEPARATOR);
  if (at <= 0) return null;
  return { server: name.slice(0, at), tool: name.slice(at + TOOL_SEPARATOR.length) };
}

/** Anciennes listes blanches (outils d'Aura sans préfixe) : rattachées au serveur `aura`. */
export function qualifyToolName(name: string, defaultServer = 'aura'): string {
  return splitToolName(name) === null ? `${defaultServer}${TOOL_SEPARATOR}${name}` : name;
}

export interface MultiUpstream extends AuraUpstream {
  /** Serveurs injoignables au démarrage ou à la dernière lecture des outils. */
  readonly failures: ReadonlyMap<string, string>;
  readonly servers: readonly string[];
}

/**
 * Regroupe plusieurs serveurs MCP derrière un seul : outils préfixés par le nom du serveur,
 * appels routés vers le bon serveur. Un serveur injoignable n'empêche pas les autres.
 */
export async function connectMultiUpstream(
  servers: readonly { name: string; connect: () => Promise<AuraUpstream> }[],
): Promise<MultiUpstream> {
  const failures = new Map<string, string>();
  const upstreams = new Map<string, AuraUpstream>();
  for (const server of servers) {
    if (!SERVER_NAME.test(server.name) || upstreams.has(server.name)) {
      failures.set(server.name, 'nom de serveur invalide ou en double');
      continue;
    }
    try {
      upstreams.set(server.name, await server.connect());
    } catch (error) {
      failures.set(server.name, error instanceof Error ? error.message : String(error));
    }
  }
  if (upstreams.size === 0)
    throw new AuraConfigError(
      `Aucun serveur MCP joignable : ${[...failures].map(([n, e]) => `${n} (${e})`).join(' ; ') || 'aucun serveur configuré'}.`,
    );
  return {
    failures,
    servers: [...upstreams.keys()],
    listTools: async () => {
      const tools: Tool[] = [];
      for (const [name, upstream] of upstreams) {
        try {
          for (const tool of await upstream.listTools())
            tools.push({
              ...tool,
              name: `${name}${TOOL_SEPARATOR}${tool.name}`,
              description: `[${name}] ${tool.description ?? ''}`.trim(),
            });
          failures.delete(name);
        } catch (error) {
          failures.set(name, error instanceof Error ? error.message : String(error));
        }
      }
      return tools;
    },
    callTool: (qualified, args): Promise<CallToolResult> => {
      const parts = splitToolName(qualified);
      const upstream = parts ? upstreams.get(parts.server) : undefined;
      if (!parts || !upstream)
        return Promise.reject(new Error(`Outil « ${qualified} » : serveur MCP inconnu.`));
      return upstream.callTool(parts.tool, args);
    },
    close: async () => {
      for (const upstream of upstreams.values()) await upstream.close().catch(() => undefined);
    },
  };
}
