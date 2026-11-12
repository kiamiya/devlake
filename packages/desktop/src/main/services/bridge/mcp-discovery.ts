import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { EditorId } from 'shared';

/** Bloc de configuration MCP normalisé, tel que le pont l'accepte. */
export type McpBlock =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: string; headers: Record<string, string> };

/** Serveur trouvé sur le poste, gardé côté cockpit (les secrets ne quittent pas le processus). */
export interface FoundServer {
  id: string;
  name: string;
  editor: EditorId | null;
  sources: string[];
  /** null : seulement une piste (paquet installé, processus), sans configuration utilisable. */
  block: McpBlock | null;
  /** Texte affiché : commande, URL ou piste. */
  summary: string;
  /** Clés sensibles du bloc (env ou en-têtes), rangées au coffre à l'import. */
  secrets: string[];
  /** Raison pour laquelle il ne peut pas être importé tel quel. */
  reason: string | null;
}

export interface DiscoveryIo {
  readText: (path: string) => Promise<string | null>;
  listDir: (path: string) => Promise<{ name: string; directory: boolean }[]>;
  listProcesses: () => Promise<string[]>;
  /** Initialisation MCP sur une URL locale : nom du serveur, ou null s'il ne répond pas. */
  probeHttp: (url: string) => Promise<string | null>;
}

export interface DiscoveryPlaces {
  home: string;
  appData: string | null;
  platform: NodeJS.Platform;
  clonesDir: string | null;
  /** Ports des ponts du cockpit : jamais sondés. */
  ownPorts: readonly number[];
}

const SECRET_KEY = /key|token|secret|password|passwd|auth|bearer|credential|cookie/i;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
/** Ports courants des serveurs MCP HTTP locaux, sondés en plus de ceux vus dans les processus. */
export const DEFAULT_MCP_PORTS = [3000, 3001, 5000, 6500, 8000, 8080, 8081, 8888, 9000];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): Record<string, string> =>
  isRecord(v)
    ? Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {};

/** Éditeur deviné d'après le nom, la commande ou l'URL. */
export function guessEditor(text: string): EditorId | null {
  if (/blender/i.test(text)) return 'blender';
  if (/unreal|\bue[45]?\b|ue5/i.test(text)) return 'unreal';
  if (/unity/i.test(text)) return 'unity';
  return null;
}

/** Nom de serveur valide pour le pont : minuscules, chiffres, tirets ; « aura » réservé. */
export function serverName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 31);
  return name === '' || name === 'aura' ? `mcp-${name || 'serveur'}` : name;
}

/** Bloc normalisé d'une entrée de config d'un client MCP ; null si l'entrée n'en est pas une. */
export function blockFrom(entry: unknown): McpBlock | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.command === 'string' && entry.command.trim() !== '')
    return {
      command: entry.command,
      args: Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === 'string')
        : [],
      env: strings(entry.env),
    };
  const url = [entry.url, entry.serverUrl, entry.httpUrl].find(
    (u): u is string => typeof u === 'string' && u.trim() !== '',
  );
  if (url !== undefined) return { url, headers: strings(entry.headers) };
  return null;
}

function isLocal(url: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function summaryOf(block: McpBlock): string {
  return 'command' in block ? [block.command, ...block.args].join(' ') : block.url;
}

function secretsOf(block: McpBlock): string[] {
  const values = 'command' in block ? block.env : block.headers;
  return Object.keys(values).filter((k) => SECRET_KEY.test(k));
}

/** Identité d'un serveur : même commande et arguments, ou même URL. */
export function blockId(block: McpBlock): string {
  const key = 'command' in block ? JSON.stringify([block.command, block.args]) : block.url;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Serveurs déclarés dans une config de client MCP (`mcpServers`, `servers`, `mcp.servers`). */
export function serversInConfig(data: unknown): [string, unknown][] {
  if (!isRecord(data)) return [];
  const groups = [data.mcpServers, data.servers, isRecord(data.mcp) ? data.mcp.servers : undefined];
  // VS Code (settings.json) : clé plate « mcp.servers ».
  groups.push(data['mcp.servers']);
  return groups.filter(isRecord).flatMap((g) => Object.entries(g));
}

/** Configs des clients MCP connus, par plateforme. */
export function clientConfigs(places: DiscoveryPlaces): { label: string; path: string }[] {
  const { home, appData, platform } = places;
  const appSupport =
    platform === 'win32'
      ? (appData ?? join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : join(home, '.config');
  return [
    { label: 'Claude Code', path: join(home, '.claude.json') },
    { label: 'Claude Code', path: join(home, '.claude', 'settings.json') },
    { label: 'Claude Desktop', path: join(appSupport, 'Claude', 'claude_desktop_config.json') },
    { label: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
    { label: 'VS Code', path: join(appSupport, 'Code', 'User', 'mcp.json') },
    { label: 'VS Code', path: join(appSupport, 'Code', 'User', 'settings.json') },
    { label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // settings.json de VS Code tolère les commentaires : retirés avant une seconde lecture.
    try {
      return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * Serveurs MCP du poste : configs des clients MCP, projets des clones d'éditeur (paquets et
 * `.mcp.json`), serveurs HTTP locaux qui répondent. Les doublons sont fusionnés.
 */
export async function discoverMcpServers(
  places: DiscoveryPlaces,
  io: DiscoveryIo,
): Promise<FoundServer[]> {
  const found = new Map<string, FoundServer>();
  const hints: FoundServer[] = [];

  const add = (rawName: string, block: McpBlock, source: string) => {
    const id = blockId(block);
    const existing = found.get(id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const summary = summaryOf(block);
    found.set(id, {
      id,
      name: serverName(rawName),
      editor: guessEditor(`${rawName} ${summary}`),
      sources: [source],
      block,
      summary,
      secrets: secretsOf(block),
      reason:
        'url' in block && !isLocal(block.url)
          ? 'Serveur distant : le pont ne relaie que des serveurs du poste.'
          : null,
    });
  };

  const fromConfig = (data: unknown, source: string) => {
    for (const [name, entry] of serversInConfig(data)) {
      const block = blockFrom(entry);
      if (block) add(name, block, source);
    }
  };

  // 1. Clients MCP.
  for (const { label, path } of clientConfigs(places)) {
    const data = parseJson(await io.readText(path));
    if (data === null) continue;
    fromConfig(data, `${label} (${path})`);
    // Claude Code : serveurs déclarés par projet dans ~/.claude.json.
    if (isRecord(data) && isRecord(data.projects))
      for (const [project, settings] of Object.entries(data.projects))
        fromConfig(settings, `${label}, projet ${project}`);
  }

  // 2. Projets des clones d'éditeur : .mcp.json, paquets Unity, plugins Unreal.
  if (places.clonesDir !== null) {
    for (const clone of (await io.listDir(places.clonesDir)).filter((e) => e.directory)) {
      const dir = join(places.clonesDir, clone.name);
      fromConfig(
        parseJson(await io.readText(join(dir, '.mcp.json'))),
        `Projet ${clone.name} (.mcp.json)`,
      );
      const manifest = parseJson(await io.readText(join(dir, 'Packages', 'manifest.json')));
      const deps =
        isRecord(manifest) && isRecord(manifest.dependencies)
          ? Object.keys(manifest.dependencies)
          : [];
      for (const pkg of deps.filter((d) => /mcp/i.test(d)))
        hints.push({
          id: `hint-unity-${pkg}`,
          name: serverName(pkg.split('.').pop() ?? pkg),
          editor: 'unity',
          sources: [`Projet ${clone.name} (Packages/manifest.json)`],
          block: null,
          summary: `Paquet Unity « ${pkg} » installé`,
          secrets: [],
          reason:
            'Paquet MCP installé, mais aucune configuration trouvée : colle celle de sa documentation.',
        });
      for (const plugin of (await io.listDir(join(dir, 'Plugins'))).filter(
        (p) => p.directory && /mcp/i.test(p.name),
      ))
        hints.push({
          id: `hint-unreal-${plugin.name}`,
          name: serverName(plugin.name),
          editor: 'unreal',
          sources: [`Projet ${clone.name} (Plugins/${plugin.name})`],
          block: null,
          summary: `Plugin Unreal « ${plugin.name} » installé`,
          secrets: [],
          reason:
            'Plugin MCP installé, mais aucune configuration trouvée : colle celle de sa documentation.',
        });
    }
  }

  // 3. Serveurs qui tournent : ports vus dans les processus MCP, plus les ports courants.
  const processes = (await io.listProcesses()).filter((line) => /mcp/i.test(line));
  const ports = new Set(DEFAULT_MCP_PORTS);
  for (const line of processes)
    for (const match of line.matchAll(/(?:--port[ =]|:)(\d{4,5})\b/g)) ports.add(Number(match[1]));
  for (const port of [...ports].filter((p) => !places.ownPorts.includes(p)).sort((a, b) => a - b)) {
    for (const path of ['/mcp', '/']) {
      const url = `http://127.0.0.1:${String(port)}${path}`;
      const name = await io.probeHttp(url);
      if (name !== null) {
        add(name, { url, headers: {} }, `Serveur HTTP en cours sur le port ${String(port)}`);
        break;
      }
    }
  }
  // Processus : seulement ceux d'un éditeur (Unity, Unreal, Blender), un par serveur, sans ceux
  // déjà trouvés (même port HTTP, même commande). La ligne de commande n'est jamais affichée.
  const foundPorts = new Set(
    [...found.values()].flatMap((s) => {
      if (s.block === null || !('url' in s.block)) return [];
      try {
        return [new URL(s.block.url).port];
      } catch {
        return [];
      }
    }),
  );
  const foundTokens = [...found.values()].flatMap((s) =>
    s.block !== null && 'command' in s.block
      ? s.block.args.filter((a) => a.length > 3 && !a.startsWith('-')).map((a) => a.toLowerCase())
      : [],
  );
  const processHints = new Map<string, FoundServer>();
  for (const line of processes) {
    const lower = line.toLowerCase();
    const editor = guessEditor(line);
    if (editor === null) continue;
    if (
      [...lower.matchAll(/(?::|_|--port[ =])(\d{4,5})\b/g)].some((m) => foundPorts.has(m[1] ?? ''))
    )
      continue;
    if (foundTokens.some((t) => lower.includes(t))) continue;
    const keyword =
      [...line.matchAll(/[\w.-]*mcp[\w.-]*/gi)]
        .map((m) => (m[0].split(/[\\/]/).pop() ?? m[0]).replace(/\.exe$/i, ''))
        .find((w) => guessEditor(w) !== null || /mcp/i.test(w)) ?? 'mcp';
    const key = keyword.toLowerCase();
    if (processHints.has(key)) continue;
    processHints.set(key, {
      id: `hint-process-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
      name: serverName(keyword),
      editor,
      sources: ['Processus en cours'],
      block: null,
      summary: `Processus « ${keyword} »`,
      secrets: [],
      reason:
        'Serveur MCP lancé par une autre application (l’éditeur, un client MCP…) : sa configuration n’a pas été trouvée, colle celle de sa documentation.',
    });
  }

  // Paquet ou plugin installé : gardé seulement si aucun serveur importable ne couvre son éditeur.
  const importable = [...found.values()].filter((s) => s.reason === null);
  const covered = new Set(importable.map((s) => s.editor));
  return [
    ...found.values(),
    ...hints.filter((h) => h.editor === null || !covered.has(h.editor)),
    ...processHints.values(),
  ];
}

/** Initialisation MCP (JSON-RPC sur HTTP) : nom du serveur s'il répond, sinon null. */
export async function probeMcpHttp(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'agentlake-cockpit', version: '1' },
        },
      }),
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const json = text.trimStart().startsWith('{')
      ? text
      : (/^data:\s*(\{.*\})\s*$/m.exec(text)?.[1] ?? '');
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed) || !isRecord(parsed.result)) return null;
    const info = parsed.result.serverInfo;
    return isRecord(info) && typeof info.name === 'string' ? info.name : 'serveur-http';
  } catch {
    return null;
  }
}
