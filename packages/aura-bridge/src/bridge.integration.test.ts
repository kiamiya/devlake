import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import {
  signBridgeToken,
  verifyBridgeResponse,
  type BridgePayloadInput,
} from 'shared/bridge-token';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuraBridge, type AuditEntry } from './bridge.js';
import type { EditorState } from './editor-probe.js';
import { BridgeGateway } from './tunnel/gateway.js';
import { connectStdioUpstream } from './upstream.js';

const SECRET = 'secret-integration-pont'; // gitleaks:allow
const FAKE_AURA = fileURLToPath(new URL('./testing/fake-aura.mjs', import.meta.url));

const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;
const payload = (overrides: Partial<BridgePayloadInput> = {}): BridgePayloadInput => ({
  repo: 'kiamiya/jeu',
  runId: '1001',
  profile: 'unity',
  exp: inHours(2),
  ...overrides,
});

describe('pont Aura contre un faux serveur MCP Aura (stdio)', () => {
  let bridge: AuraBridge;
  let audit: AuditEntry[];
  let url: URL;
  const clients: Client[] = [];

  let editorState: EditorState;

  beforeEach(async () => {
    editorState = {
      open: true,
      repo: 'kiamiya/jeu',
      branch: 'main',
      clone: '/clones/kiamiya__jeu',
    };
    audit = [];
    bridge = new AuraBridge({
      editor: 'unity',
      port: 0,
      secret: SECRET,
      allowedTools: (profile) => (profile === 'unity' ? ['scene_list', 'echo'] : []),
      connectUpstream: () =>
        connectStdioUpstream({ command: process.execPath, args: [FAKE_AURA], env: {} }),
      onAudit: (e) => audit.push(e),
      probe: () => Promise.resolve(editorState),
    });
    const status = await bridge.start();
    url = new URL(`http://127.0.0.1:${String(status.port)}/mcp`);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await bridge.stop();
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'agent', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  it('jeton valide : liste et appelle les outils autorisés ; les autres sont refusés', async () => {
    const client = await connect(signBridgeToken(payload(), SECRET));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'echo',
      'scene_list',
    ]);
    expect(await client.callTool({ name: 'echo', arguments: { text: 'bonjour' } })).toMatchObject({
      content: [{ type: 'text', text: 'écho : bonjour' }],
    });
    await expect(client.callTool({ name: 'run_script', arguments: {} })).rejects.toThrow(
      'non autorisé',
    );
    expect(audit.map((e) => [e.tool, e.outcome])).toEqual([
      ['echo', 'ok'],
      ['run_script', 'refused'],
    ]);
    expect(bridge.status().lastCall).toMatchObject({ tool: 'run_script', runId: '1001' });
  });

  it.each([
    [
      'expiré',
      () => signBridgeToken(payload({ exp: inHours(-1) }), SECRET),
      'Jeton du pont expiré.',
    ],
    ['falsifié', () => signBridgeToken(payload(), 'autre-secret'), 'falsifié'],
    ['absent', () => '', 'Jeton du pont absent.'],
    ['autre éditeur', () => signBridgeToken(payload({ profile: 'unreal' }), SECRET), 'pas unreal'],
  ])('jeton %s : refusé et audité', async (_name, token, message) => {
    await expect(connect(token())).rejects.toThrow(message);
    expect(audit.at(-1)).toMatchObject({ outcome: 'refused', tool: null });
  });

  it('un seul run à la fois : un autre run est refusé, puis passe à la fin de la session', async () => {
    const first = await connect(signBridgeToken(payload({ runId: 'A' }), SECRET));
    await first.callTool({ name: 'scene_list', arguments: {} });
    await expect(connect(signBridgeToken(payload({ runId: 'B' }), SECRET))).rejects.toThrow(
      'occupé par le run A',
    );
    expect(bridge.status().activeRun).toEqual({ runId: 'A', repo: 'kiamiya/jeu' });
    // Le même run peut ouvrir une seconde session.
    await connect(signBridgeToken(payload({ runId: 'A' }), SECRET));
    // Fin des sessions du run A : l'éditeur est libéré.
    for (const c of clients.splice(0)) {
      const transport = c.transport as StreamableHTTPClientTransport | undefined;
      await transport?.terminateSession();
      await c.close();
    }
    const second = await connect(signBridgeToken(payload({ runId: 'B' }), SECRET));
    expect((await second.listTools()).tools.length).toBe(2);
  });

  const healthToken = (overrides: Partial<BridgePayloadInput> = {}) =>
    signBridgeToken(
      payload({
        scope: 'health',
        iat: inHours(0),
        exp: inHours(0.05),
        runId: 'disp-1',
        ...overrides,
      }),
      SECRET,
    );

  async function health(token: string, base = url) {
    const response = await fetch(new URL('health', base.href.replace(/mcp$/, '')), {
      headers: { authorization: `Bearer ${token}` },
    });
    return { response, body: await response.text() };
  }

  it('santé signée : pont, Aura, éditeur, projet et branche ; réponse vérifiable', async () => {
    const { response, body } = await health(healthToken());
    expect(response.status).toBe(200);
    expect(
      verifyBridgeResponse(body, response.headers.get('x-agentlake-signature') ?? '', SECRET),
    ).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      status: 'ok',
      editor: 'unity',
      aura: true,
      editorOpen: true,
      project: 'kiamiya/jeu',
      branch: 'main',
      requestedBy: { repo: 'kiamiya/jeu', runId: 'disp-1' },
    });
    editorState = { open: false, repo: null, branch: null, clone: null };
    expect(JSON.parse((await health(healthToken())).body)).toMatchObject({
      editorOpen: false,
      project: null,
    });
  });

  it('santé refusée sans jeton, avec un jeton MCP ; jeton de santé refusé pour MCP', async () => {
    expect((await health('')).response.status).toBe(401);
    expect((await health(signBridgeToken(payload(), SECRET))).response.status).toBe(403);
    await expect(connect(healthToken())).rejects.toThrow(
      'Un jeton de santé n’ouvre pas de session MCP',
    );
    expect((await fetch(new URL('/autre', url))).status).toBe(404);
  });

  it('interrupteur : sessions fermées, jetons émis avant refusés, nouveaux jetons acceptés', async () => {
    const before = await connect(
      signBridgeToken(payload({ runId: 'A', iat: inHours(0) - 5 }), SECRET),
    );
    await before.callTool({ name: 'scene_list', arguments: {} });
    await bridge.revokeTokens();
    await expect(
      connect(signBridgeToken(payload({ runId: 'A', iat: inHours(0) - 5 }), SECRET)),
    ).rejects.toThrow('Jeton révoqué');
    // Jeton sans date d'émission (ancien format) : émis il y a deux heures selon son expiration.
    await expect(connect(signBridgeToken(payload({ runId: 'B' }), SECRET))).rejects.toThrow(
      'Jeton révoqué',
    );
    await new Promise((done) => setTimeout(done, 1100));
    const after = await connect(signBridgeToken(payload({ runId: 'C', iat: inHours(0) }), SECRET));
    expect((await after.listTools()).tools.length).toBe(2);
  });

  it('requête MCP sans session : refusée proprement', async () => {
    const orphan = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signBridgeToken(payload(), SECRET)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(orphan.status).toBe(400);
  });

  it('passerelle : une URL, un chemin par éditeur, jusqu’au pont et retour', async () => {
    const gateway = new BridgeGateway((editor) =>
      editor === 'unity' ? bridge.status().port : null,
    );
    const port = await gateway.start(0);
    try {
      const base = new URL(`http://127.0.0.1:${String(port)}/unity/mcp`);
      const client = new Client({ name: 'agent', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(base, {
          requestInit: {
            headers: { authorization: `Bearer ${signBridgeToken(payload(), SECRET)}` },
          },
        }),
      );
      expect(
        await client.callTool({ name: 'echo', arguments: { text: 'via tunnel' } }),
      ).toMatchObject({
        content: [{ type: 'text', text: 'écho : via tunnel' }],
      });
      const viaGateway = await health(healthToken(), base);
      expect(viaGateway.response.status).toBe(200);
      expect(
        verifyBridgeResponse(
          viaGateway.body,
          viaGateway.response.headers.get('x-agentlake-signature') ?? '',
          SECRET,
        ),
      ).toBe(true);
      expect((await fetch(`http://127.0.0.1:${String(port)}/unreal/health`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${String(port)}/autre`)).status).toBe(404);
      expect(gateway.port).toBe(port);
    } finally {
      await gateway.stop();
    }
    expect(gateway.port).toBeNull();
  });
});
