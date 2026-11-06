import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { TOKEN_REFUSALS, verifyBridgeToken, type BridgePayload } from 'shared/bridge-token';
import { EditorLock, IDLE_RELEASE_MS } from './editor-lock.js';
import type { AuraUpstream } from './upstream.js';

export type Editor = 'unity' | 'unreal';

/** Une entrée du journal d'audit : chaque appel d'outil, et chaque accès refusé. */
export interface AuditEntry {
  at: string;
  editor: Editor;
  repo: string | null;
  runId: string | null;
  /** Outil appelé ; null pour un accès refusé avant tout appel. */
  tool: string | null;
  durationMs: number;
  outcome: 'ok' | 'error' | 'refused';
  detail: string | null;
}

export interface BridgeOptions {
  editor: Editor;
  /** Port local ; 0 = port libre choisi par le système (tests). */
  port: number;
  host?: string;
  /** Secret partagé AURA_BRIDGE_SECRET (lu au démarrage). */
  secret: string;
  /** Outils Aura autorisés pour ce profil (liste blanche du cockpit). */
  allowedTools: (profile: Editor) => readonly string[];
  /** Connexion au serveur MCP d'Aura (stdio en vrai, doublure en test). */
  connectUpstream: () => Promise<AuraUpstream>;
  onAudit?: (entry: AuditEntry) => void;
  now?: () => Date;
  idleMs?: number;
}

export interface BridgeStatus {
  editor: Editor;
  running: boolean;
  port: number | null;
  activeRun: { runId: string; repo: string } | null;
  lastCall: AuditEntry | null;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  payload: BridgePayload;
}

const MCP_PATH = '/mcp';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Erreur JSON-RPC lisible par un client MCP, avec un code HTTP explicite. */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Pont MCP : relaie le serveur MCP d'Aura (stdio, sur le poste) en Streamable HTTP sur
 * 127.0.0.1, derrière un jeton signé, une liste blanche d'outils et un verrou d'éditeur.
 */
export class AuraBridge {
  private http: HttpServer | null = null;
  private upstream: AuraUpstream | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly lock: EditorLock;
  private lastCall: AuditEntry | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.lock = new EditorLock(options.idleMs ?? IDLE_RELEASE_MS);
  }

  get editor(): Editor {
    return this.options.editor;
  }

  status(): BridgeStatus {
    const address = this.http?.address();
    return {
      editor: this.options.editor,
      running: this.http !== null,
      port: address && typeof address === 'object' ? address.port : null,
      activeRun: this.lock.current(this.now().getTime()),
      lastCall: this.lastCall,
    };
  }

  /** Outils exposés par Aura (pour composer la liste blanche dans le cockpit). */
  async upstreamTools(): Promise<{ name: string; description: string }[]> {
    if (!this.upstream) return [];
    return (await this.upstream.listTools()).map((t) => ({
      name: t.name,
      description: t.description ?? '',
    }));
  }

  async start(): Promise<BridgeStatus> {
    if (this.http) return this.status();
    if (this.options.secret === '')
      throw new Error('Secret du pont absent : créer d’abord un projet de jeu.');
    this.upstream = await this.options.connectUpstream();
    const http = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent)
          sendRpcError(
            res,
            500,
            `Erreur du pont : ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        resolve();
      });
    });
    this.http = http;
    return this.status();
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) await session.transport.close();
    this.sessions.clear();
    const http = this.http;
    this.http = null;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
    }
    await this.upstream?.close();
    this.upstream = null;
  }

  private audit(entry: Omit<AuditEntry, 'at' | 'editor'>): void {
    const full: AuditEntry = {
      at: this.now().toISOString(),
      editor: this.options.editor,
      ...entry,
    };
    if (entry.tool !== null) this.lastCall = full;
    this.options.onAudit?.(full);
  }

  private refuse(
    res: ServerResponse,
    status: number,
    message: string,
    payload?: BridgePayload,
  ): void {
    this.audit({
      repo: payload?.repo ?? null,
      runId: payload?.runId ?? null,
      tool: null,
      durationMs: 0,
      outcome: 'refused',
      detail: message,
    });
    sendRpcError(res, status, message);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', editor: this.options.editor });
      return;
    }
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'Introuvable.' });
      return;
    }

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const check = verifyBridgeToken(token, this.options.secret, this.now());
    if (!check.ok) {
      this.refuse(res, 401, token === '' ? 'Jeton du pont absent.' : TOKEN_REFUSALS[check.reason]);
      return;
    }
    const payload = check.payload;
    if (payload.profile !== this.options.editor) {
      this.refuse(
        res,
        403,
        `Ce pont sert l’éditeur ${this.options.editor}, pas ${payload.profile}.`,
        payload,
      );
      return;
    }
    const lock = this.lock.acquire(
      { runId: payload.runId, repo: payload.repo, expiresAt: payload.exp * 1000 },
      this.now().getTime(),
    );
    if (!lock.ok) {
      this.refuse(
        res,
        409,
        `Éditeur ${this.options.editor} occupé par le run ${lock.holder.runId} (${lock.holder.repo}) : réessayer plus tard.`,
        payload,
      );
      return;
    }

    const body = await readBody(req);
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      if (existing.payload.runId !== payload.runId) {
        this.refuse(res, 403, 'Cette session appartient à un autre run.', payload);
        return;
      }
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId !== undefined || !isInitializeRequest(body)) {
      sendRpcError(res, 400, 'Session MCP inconnue : initialiser une nouvelle session.');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, payload });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId);
      this.lock.release(payload.runId);
    };
    await this.sessionServer(payload).connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * Serveur MCP d'une session : liste et appels filtrés par la liste blanche du profil.
   * Serveur bas niveau voulu : un relais transmet des outils dont il ne connaît pas les schémas.
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  sessionServer(payload: BridgePayload): Server {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'agentlake-aura-bridge', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const allowed = () => new Set(this.options.allowedTools(payload.profile));
    const upstream = () => {
      if (!this.upstream) throw new McpError(ErrorCode.InternalError, 'Pont arrêté.');
      return this.upstream;
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const permitted = allowed();
      return { tools: (await upstream().listTools()).filter((t) => permitted.has(t.name)) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name;
      const started = Date.now();
      if (!allowed().has(tool)) {
        const message = `Outil « ${tool} » non autorisé pour le profil ${payload.profile}.`;
        this.audit({
          repo: payload.repo,
          runId: payload.runId,
          tool,
          durationMs: 0,
          outcome: 'refused',
          detail: message,
        });
        throw new McpError(ErrorCode.InvalidParams, message);
      }
      // Activité : le verrou reste à ce run tant qu'il appelle des outils.
      this.lock.acquire(
        { runId: payload.runId, repo: payload.repo, expiresAt: payload.exp * 1000 },
        this.now().getTime(),
      );
      try {
        const result = await upstream().callTool(tool, request.params.arguments ?? {});
        this.audit({
          repo: payload.repo,
          runId: payload.runId,
          tool,
          durationMs: Date.now() - started,
          outcome: result.isError === true ? 'error' : 'ok',
          detail: null,
        });
        return result;
      } catch (error) {
        this.audit({
          repo: payload.repo,
          runId: payload.runId,
          tool,
          durationMs: Date.now() - started,
          outcome: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    return server;
  }
}
