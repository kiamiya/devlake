import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { systemProcesses } from 'aura-bridge';
import { EDITORS, type EditorId } from 'shared';
import type { DiscoveredMcp, McpImportResult } from '../../../shared/ipc-contract.js';
import type { Repositories } from '../../db/repositories.js';
import type { SecretVault } from '../../vault.js';
import { McpImportError, SECRET_KEY, SECRET_REF } from './mcp-secrets.js';

export { McpImportError, resolveSecrets } from './mcp-secrets.js';
import type { BridgeService } from './bridge-service.js';
import { configuredServers } from './bridge-service.js';
import {
  blockFrom,
  blockId,
  discoverMcpServers,
  probeMcpHttp,
  serverName,
  type DiscoveryIo,
  type FoundServer,
  type McpBlock,
} from './mcp-discovery.js';

const defaultIo: DiscoveryIo = {
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  listDir: async (path) => {
    try {
      return (await readdir(path, { withFileTypes: true })).map((e) => ({
        name: e.name,
        directory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  listProcesses: () => systemProcesses().catch(() => []),
  probeHttp: (url) => probeMcpHttp(url),
};

/**
 * Détection des serveurs MCP du poste, puis ajout confirmé par Kia : secrets au coffre, pont
 * (re)démarré pour tester la connexion, tous les outils des serveurs ajoutés autorisés.
 */
export class McpImportService {
  private found = new Map<string, FoundServer>();

  constructor(
    private readonly deps: {
      repos: Repositories;
      vault: SecretVault;
      bridges: BridgeService;
      io?: DiscoveryIo;
      home?: string;
      appData?: string | null;
      platform?: NodeJS.Platform;
    },
  ) {}

  private configuredIds(): Map<string, EditorId> {
    const settings = this.deps.repos.settings.get();
    const ids = new Map<string, EditorId>();
    for (const editor of EDITORS)
      for (const { config } of configuredServers(settings, editor)) {
        try {
          const block = blockFrom(JSON.parse(config) as unknown);
          if (block) ids.set(blockId(block), editor);
        } catch {
          // Configuration illisible : ignorée ici, signalée au démarrage du pont.
        }
      }
    return ids;
  }

  async detect(): Promise<DiscoveredMcp[]> {
    const settings = this.deps.repos.settings.get();
    const servers = await discoverMcpServers(
      {
        home: this.deps.home ?? homedir(),
        appData:
          this.deps.appData !== undefined ? this.deps.appData : (process.env.APPDATA ?? null),
        platform: this.deps.platform ?? process.platform,
        clonesDir: settings.editorClonesDir,
        ownPorts: [settings.tunnel.gatewayPort, ...EDITORS.map((e) => settings.auraBridge[e].port)],
      },
      this.deps.io ?? defaultIo,
    );
    this.found = new Map(servers.map((s) => [s.id, s]));
    const configured = this.configuredIds();
    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      editor: s.editor,
      sources: s.sources,
      kind: s.block === null ? 'hint' : 'command' in s.block ? 'stdio' : 'http',
      summary: s.summary,
      secrets: s.secrets,
      importable: s.block !== null && s.reason === null,
      reason: s.reason,
      alreadyConfigured: configured.get(s.id) ?? null,
    }));
  }

  /** Secrets du bloc rangés au coffre ; le bloc enregistré n'y fait que référence. */
  private async storeSecrets(block: McpBlock): Promise<McpBlock> {
    const protect = async (values: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (!SECRET_KEY.test(key) || SECRET_REF.test(value)) {
          out[key] = value;
          continue;
        }
        const name = `mcp-secret-${randomBytes(8).toString('hex')}` as const;
        await this.deps.vault.set(name, value);
        out[key] = `{{coffre:${name}}}`;
      }
      return out;
    };
    return 'command' in block
      ? { ...block, env: await protect(block.env) }
      : { ...block, headers: await protect(block.headers) };
  }

  async apply(
    selections: readonly { id: string; editor: EditorId; name: string }[],
  ): Promise<McpImportResult[]> {
    if (selections.length === 0) throw new McpImportError('Aucun serveur choisi.');
    const settings = this.deps.repos.settings.get();
    const auraMcp = { ...settings.auraMcp };
    const extraMcp = Object.fromEntries(
      EDITORS.map((e) => [e, [...settings.extraMcp[e]]]),
    ) as typeof settings.extraMcp;
    const added: {
      selection: (typeof selections)[number];
      server: string;
      slot: 'primary' | 'extra';
    }[] = [];

    for (const selection of selections) {
      const found = this.found.get(selection.id);
      if (found?.block == null || found.reason !== null)
        throw new McpImportError(
          `Serveur non importable : ${selection.name}. Relancer la détection.`,
        );
      const config = JSON.stringify(await this.storeSecrets(found.block), null, 2);
      const { editor } = selection;
      const primaryHint = editor === 'blender' ? /blender/i : /aura/i;
      if (auraMcp[editor] === null && primaryHint.test(`${selection.name} ${found.summary}`)) {
        auraMcp[editor] = config;
        added.push({
          selection,
          server: editor === 'blender' ? 'blender' : 'aura',
          slot: 'primary',
        });
        continue;
      }
      const taken = new Set(extraMcp[editor].map((s) => s.name));
      let name = serverName(selection.name);
      for (let n = 2; taken.has(name); n += 1)
        name = `${serverName(selection.name).slice(0, 28)}-${String(n)}`;
      if (extraMcp[editor].length >= 8)
        throw new McpImportError(`Au plus 8 serveurs MCP par éditeur (${editor}).`);
      extraMcp[editor].push({ name, config });
      added.push({ selection, server: name, slot: 'extra' });
    }
    this.deps.repos.settings.update({ auraMcp, extraMcp });

    // Pont redémarré par éditeur touché : connexion testée, outils des serveurs ajoutés autorisés.
    const results: McpImportResult[] = [];
    for (const editor of [...new Set(added.map((a) => a.selection.editor))]) {
      const mine = added.filter((a) => a.selection.editor === editor);
      let startError: string | null = null;
      try {
        if (this.deps.bridges.list().find((b) => b.editor === editor)?.running)
          await this.deps.bridges.stop(editor);
        await this.deps.bridges.start(editor);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      const view = this.deps.bridges.list().find((b) => b.editor === editor);
      const tools =
        startError === null ? (await this.deps.bridges.tools(editor)).map((t) => t.name) : [];
      const opened = tools.filter((t) => mine.some((a) => t.startsWith(`${a.server}__`)));
      if (opened.length > 0)
        this.deps.bridges.setAllowedTools(editor, [
          ...new Set([...(view?.allowedTools ?? []), ...opened]),
        ]);
      for (const a of mine) {
        const status = view?.servers.find((s) => s.name === a.server);
        results.push({
          editor,
          name: a.server,
          slot: a.slot,
          connected: startError === null && status?.connected === true,
          error: startError ?? status?.error ?? null,
          tools: opened.filter((t) => t.startsWith(`${a.server}__`)).length,
        });
      }
    }
    return results;
  }
}
