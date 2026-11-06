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
import {
  BRIDGE_SIGNATURE_HEADER,
  issuedAt,
  signBridgeResponse,
  TOKEN_REFUSALS,
  verifyBridgeToken,
  type BridgePayload,
} from 'shared/bridge-token';
import { validateRequest, type AutomationRunner } from './automation/automation.js';
import { EDITOR_CLOSED, type EditorState } from './editor-probe.js';
import { EditorSyncError } from './editor-sync/git.js';
import type { EditorSync } from './editor-sync/sync.js';
import { EditorLock, IDLE_RELEASE_MS } from './editor-lock.js';
import type { AuraUpstream } from './upstream.js';

import type { Editor } from './types.js';

export type { Editor } from './types.js';

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
  /** État de l'éditeur sur le poste (clone dédié ouvert, projet, branche). */
  probe?: () => Promise<EditorState>;
  /** Synchronisation du clone dédié : outils editor_checkout, editor_commit_push, editor_status. */
  editorSync?: EditorSync;
  /** Tests d'automatisation lancés par la CI (`/automation`, Unreal). */
  automation?: AutomationRunner;
}

/** Réponse de `/health`, signée avec le secret du pont. */
export interface HealthReport {
  status: 'ok';
  editor: Editor;
  /** Le serveur MCP d'Aura répond. */
  aura: boolean;
  editorOpen: boolean;
  /** Projet et branche du clone ouvert dans l'éditeur. */
  project: string | null;
  branch: string | null;
  /** Demandeur, tel qu'il figure dans son jeton (anti-rejeu). */
  requestedBy: { repo: string; runId: string };
  at: string;
}

/** Outils ajoutés par le pont (synchronisation de l'éditeur), toujours proposés aux agents. */
export const BRIDGE_TOOLS = [
  {
    name: 'editor_checkout',
    description:
      'Bascule le clone ouvert dans l’éditeur sur la branche de la tâche (déjà poussée), puis attend la fin de l’import ou de la compilation. Refusé si l’éditeur a des modifications non poussées.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string', description: 'Branche de la tâche, ex. task/T04-saut.' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'editor_commit_push',
    description:
      'Commite les scènes, prefabs, .meta et assets modifiés dans l’éditeur et les pousse sur la branche de la tâche. Refusé sur main, pour un asset sérialisé en binaire ou un binaire hors Git LFS.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message de commit (Conventional Commits).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'editor_status',
    description:
      'État du clone de l’éditeur : branche, fichiers modifiés, commits non poussés, erreurs de compilation, avertissements de sérialisation.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];
const BRIDGE_TOOL_NAMES = new Set(BRIDGE_TOOLS.map((t) => t.name));

/** Délai maximal de réponse d'Aura pour la santé. */
const AURA_PROBE_MS = 3_000;

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
const AUTOMATION_PATH = /^\/automation(?:\/([0-9a-f-]{36}))?$/;

type Route =
  | { kind: 'mcp' }
  | { kind: 'health' }
  | { kind: 'automation-start' }
  | { kind: 'automation-get'; id: string };

/** Route d'une requête, ou null (404). */
function routeOf(method: string | undefined, pathname: string): Route | null {
  if (pathname === MCP_PATH) return { kind: 'mcp' };
  if (pathname === '/health' && method === 'GET') return { kind: 'health' };
  const automation = AUTOMATION_PATH.exec(pathname);
  if (automation) {
    const id = automation[1];
    if (id === undefined && method === 'POST') return { kind: 'automation-start' };
    if (id !== undefined && method === 'GET') return { kind: 'automation-get', id };
  }
  return null;
}

const SCOPE_OF: Record<Route['kind'], BridgePayload['scope']> = {
  mcp: 'mcp',
  health: 'health',
  'automation-start': 'ci',
  'automation-get': 'ci',
};
const SCOPE_REFUSALS: Record<Route['kind'], string> = {
  mcp: 'Ce jeton n’ouvre pas de session MCP.',
  health: 'Ce jeton ouvre une session MCP, pas un contrôle de santé.',
  'automation-start': 'Seul un jeton de CI lance des tests d’automatisation.',
  'automation-get': 'Seul un jeton de CI lit des tests d’automatisation.',
};

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

  /** Outils du pont : la synchronisation du clone, résultat en JSON, erreurs lisibles par l'agent. */
  private async callBridgeTool(
    sync: EditorSync,
    tool: string,
    args: Record<string, unknown>,
    payload: BridgePayload,
    started: number,
  ) {
    const audit = (outcome: AuditEntry['outcome'], detail: string | null) => {
      this.audit({
        repo: payload.repo,
        runId: payload.runId,
        tool,
        durationMs: Date.now() - started,
        outcome,
        detail,
      });
    };
    try {
      const result =
        tool === 'editor_checkout'
          ? await sync.checkout(payload.repo, typeof args.branch === 'string' ? args.branch : '')
          : tool === 'editor_commit_push'
            ? await sync.commitPush(
                payload.repo,
                typeof args.message === 'string' ? args.message : '',
              )
            : await sync.status(payload.repo);
      audit('ok', null);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (!(error instanceof EditorSyncError)) {
        audit('error', error instanceof Error ? error.message : String(error));
        throw error;
      }
      audit('refused', error.message);
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
  }

  /** Jetons émis avant cette date (secondes) refusés : posée par l'interrupteur du cockpit. */
  private revokedBefore = 0;

  /**
   * Interrupteur : révoque tous les jetons émis jusqu'ici et ferme les sessions en cours.
   * Les agents devront obtenir un nouveau jeton (nouveau run) pour revenir.
   */
  async revokeTokens(): Promise<void> {
    this.revokedBefore = Math.floor(this.now().getTime() / 1000) + 1;
    for (const session of [...this.sessions.values()]) await session.transport.close();
    this.sessions.clear();
  }

  /** Réponse JSON signée avec le secret du pont (santé, tests d'automatisation). */
  private sendSigned(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      [BRIDGE_SIGNATURE_HEADER]: signBridgeResponse(body, this.options.secret),
    });
    res.end(body);
  }

  /** POST /automation : la CI lance les tests d'automatisation au commit de sa PR. */
  private async startAutomation(
    req: IncomingMessage,
    res: ServerResponse,
    payload: BridgePayload,
    runner: AutomationRunner,
  ): Promise<void> {
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    const field = (name: string) => {
      const value = body?.[name];
      return typeof value === 'string' ? value : '';
    };
    const request = {
      repo: payload.repo,
      runId: payload.runId,
      branch: field('branch'),
      sha: field('sha'),
      filter: field('filter'),
    };
    const invalid = validateRequest(request);
    if (invalid) {
      this.refuse(res, 400, invalid, payload);
      return;
    }
    const owner = { runId: payload.runId, repo: payload.repo, expiresAt: payload.exp * 1000 };
    const lock = this.lock.acquire(owner, this.now().getTime());
    if (!lock.ok || runner.busy) {
      if (lock.ok) this.lock.release(payload.runId);
      const holder = lock.ok ? 'une autre passe de tests' : `le run ${lock.holder.runId}`;
      this.refuse(
        res,
        409,
        `Éditeur ${this.options.editor} occupé par ${holder} : réessayer plus tard.`,
        payload,
      );
      return;
    }
    const started = Date.now();
    const job = runner.start(request, () => {
      this.lock.release(payload.runId);
      const done = runner.get(job.id);
      this.audit({
        repo: payload.repo,
        runId: payload.runId,
        tool: 'automation',
        durationMs: Date.now() - started,
        outcome: done?.state === 'error' ? 'error' : 'ok',
        detail: done ? `${done.state} (${request.filter})` : null,
      });
    });
    this.sendSigned(res, 202, job);
  }

  /** GET /automation/<id> : état de la passe ; chaque lecture garde le verrou à ce run. */
  private getAutomation(
    res: ServerResponse,
    payload: BridgePayload,
    runner: AutomationRunner,
    id: string,
  ): void {
    const job = runner.get(id);
    if (job?.repo !== payload.repo || job.runId !== payload.runId) {
      sendJson(res, 404, { error: 'Passe de tests inconnue pour ce run.' });
      return;
    }
    if (job.state === 'running')
      this.lock.acquire(
        { runId: payload.runId, repo: payload.repo, expiresAt: payload.exp * 1000 },
        this.now().getTime(),
      );
    this.sendSigned(res, 200, job);
  }

  /** Santé signée : pont actif, Aura joignable, éditeur ouvert, projet et branche. */
  private async sendHealth(res: ServerResponse, payload: BridgePayload): Promise<void> {
    const [aura, editor] = await Promise.all([this.auraAlive(), this.probeEditor()]);
    const report: HealthReport = {
      status: 'ok',
      editor: this.options.editor,
      aura,
      editorOpen: editor.open,
      project: editor.repo,
      branch: editor.branch,
      requestedBy: { repo: payload.repo, runId: payload.runId },
      at: this.now().toISOString(),
    };
    this.sendSigned(res, 200, report);
  }

  private async auraAlive(): Promise<boolean> {
    const upstream = this.upstream;
    if (!upstream) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((done) => {
      timer = setTimeout(() => {
        done(false);
      }, AURA_PROBE_MS);
    });
    try {
      return await Promise.race([upstream.listTools().then(() => true), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeEditor(): Promise<EditorState> {
    try {
      return (await this.options.probe?.()) ?? EDITOR_CLOSED;
    } catch {
      return EDITOR_CLOSED;
    }
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
    const route = routeOf(req.method, url.pathname);
    if (route === null) {
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
    if (issuedAt(payload) < this.revokedBefore) {
      this.refuse(res, 401, 'Jeton révoqué par l’interrupteur du cockpit.', payload);
      return;
    }
    if (payload.scope !== SCOPE_OF[route.kind]) {
      this.refuse(
        res,
        403,
        route.kind === 'mcp' && payload.scope === 'health'
          ? 'Un jeton de santé n’ouvre pas de session MCP.'
          : SCOPE_REFUSALS[route.kind],
        payload,
      );
      return;
    }
    if (payload.profile !== this.options.editor) {
      this.refuse(
        res,
        403,
        `Ce pont sert l’éditeur ${this.options.editor}, pas ${payload.profile}.`,
        payload,
      );
      return;
    }
    if (route.kind === 'health') {
      await this.sendHealth(res, payload);
      return;
    }
    if (route.kind !== 'mcp') {
      const runner = this.options.automation;
      if (!runner) {
        sendJson(res, 404, {
          error: `Tests d’automatisation non disponibles sur le pont ${this.options.editor}.`,
        });
        return;
      }
      if (route.kind === 'automation-start') await this.startAutomation(req, res, payload, runner);
      else this.getAutomation(res, payload, runner, route.id);
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
    const sync = this.options.editorSync;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const permitted = allowed();
      const aura = (await upstream().listTools()).filter((t) => permitted.has(t.name));
      return { tools: sync ? [...BRIDGE_TOOLS, ...aura] : aura };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name;
      const started = Date.now();
      if (sync && BRIDGE_TOOL_NAMES.has(tool)) {
        return this.callBridgeTool(sync, tool, request.params.arguments ?? {}, payload, started);
      }
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
