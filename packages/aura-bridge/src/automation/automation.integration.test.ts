import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  signBridgeToken,
  verifyBridgeResponse,
  type BridgePayloadInput,
} from 'shared/bridge-token';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuraBridge, type AuditEntry } from '../bridge.js';
import { connectStdioUpstream } from '../upstream.js';
import { AutomationRunner, type AutomationJob, type ProcessRunner } from './automation.js';

const SECRET = 'secret-integration-automatisation'; // gitleaks:allow
const FAKE_AURA = fileURLToPath(new URL('../testing/fake-aura.mjs', import.meta.url));
const SHA = 'b'.repeat(40);
const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

const token = (overrides: Partial<BridgePayloadInput> = {}) =>
  signBridgeToken(
    {
      repo: 'kiamiya/jeu-unreal',
      runId: 'ci-7',
      profile: 'unreal',
      scope: 'ci',
      iat: inHours(0),
      exp: inHours(2),
      ...overrides,
    },
    SECRET,
  );

describe('tests d’automatisation Unreal via le pont', { timeout: 30_000 }, () => {
  let root: string;
  let bridge: AuraBridge;
  let base: string;
  let audit: AuditEntry[];
  let release: () => void;
  const clients: Client[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agentlake-automation-pont-'));
    const clone = join(root, 'clones', 'kiamiya__jeu-unreal');
    mkdirSync(join(clone, '.git'), { recursive: true });
    writeFileSync(join(clone, 'Jeu.uproject'), '{}');
    let gate = Promise.resolve();
    release = () => undefined;
    // Faux UnrealEditor-Cmd : attend le feu vert du test, puis écrit le rapport.
    const run: ProcessRunner = async (_command, args) => {
      await gate;
      const dir = args.find((a) => a.startsWith('-ReportExportPath='))?.split('=')[1] ?? '';
      writeFileSync(
        join(dir, 'index.json'),
        JSON.stringify({
          tests: [
            { fullTestPath: 'Project.Unit.Saut', state: 'Success' },
            {
              fullTestPath: 'Project.Unit.Chute',
              state: 'Fail',
              entries: [{ event: { type: 'Error', message: 'Attendu 2' } }],
            },
          ],
        }),
      );
      return { code: 1, output: 'LogAutomation: 1 échec\n', timedOut: false };
    };
    const runner = new AutomationRunner({
      clonesRoot: () => join(root, 'clones'),
      editorCmd: () => 'UnrealEditor-Cmd',
      token: () => Promise.resolve(null),
      git: () => Promise.resolve(''),
      run,
      reportsRoot: join(root, 'rapports'),
    });
    audit = [];
    bridge = new AuraBridge({
      editor: 'unreal',
      port: 0,
      secret: SECRET,
      allowedTools: () => ['echo'],
      connectUpstream: () =>
        connectStdioUpstream({ command: process.execPath, args: [FAKE_AURA], env: {} }),
      onAudit: (e) => audit.push(e),
      automation: runner,
    });
    const status = await bridge.start();
    base = `http://127.0.0.1:${String(status.port)}`;
    gate = new Promise((resolve) => {
      release = resolve;
    });
  });

  afterEach(async () => {
    release();
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await bridge.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function start(
    auth: string,
    body: unknown = { branch: 'task/T07-saut', sha: SHA, filter: 'Project.Unit' },
  ) {
    const response = await fetch(`${base}/automation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, text: await response.text() };
  }

  async function get(auth: string, id: string) {
    const response = await fetch(`${base}/automation/${id}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    return { response, text: await response.text() };
  }

  const signed = (r: { response: Response; text: string }) =>
    verifyBridgeResponse(r.text, r.response.headers.get('x-agentlake-signature') ?? '', SECRET);

  it('lance, garde l’éditeur, puis rend un résultat signé ; le verrou est libéré à la fin', async () => {
    const started = await start(token());
    expect(started.response.status).toBe(202);
    expect(signed(started)).toBe(true);
    const job = JSON.parse(started.text) as AutomationJob;
    expect(job).toMatchObject({ state: 'running', sha: SHA, repo: 'kiamiya/jeu-unreal' });
    expect(bridge.status().activeRun).toEqual({ runId: 'ci-7', repo: 'kiamiya/jeu-unreal' });

    // Pendant la passe, un agent n'obtient pas l'éditeur, une autre CI non plus.
    const client = new Client({ name: 'agent', version: '1' });
    clients.push(client);
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: {
            headers: {
              authorization: `Bearer ${token({ scope: 'mcp', runId: 'agent-1' })}`,
            },
          },
        }),
      ),
    ).rejects.toThrow('occupé par le run ci-7');
    expect((await start(token({ runId: 'ci-8' }))).response.status).toBe(409);

    const polled = await get(token(), job.id);
    expect(signed(polled)).toBe(true);
    expect(JSON.parse(polled.text)).toMatchObject({ state: 'running' });

    release();
    let done: AutomationJob | null = null;
    for (let i = 0; i < 100 && done === null; i++) {
      const current = JSON.parse((await get(token(), job.id)).text) as AutomationJob;
      if (current.state !== 'running') done = current;
      else await new Promise((r) => setTimeout(r, 20));
    }
    expect(done).toMatchObject({
      state: 'failed',
      summary: { passed: 1, failed: 1, skipped: 0 },
      tests: [
        { name: 'Project.Unit.Saut', state: 'passed' },
        { name: 'Project.Unit.Chute', state: 'failed', errors: ['Attendu 2'] },
      ],
    });
    expect(bridge.status().activeRun).toBeNull();
    expect(audit.at(-1)).toMatchObject({
      tool: 'automation',
      outcome: 'ok',
      detail: 'failed (Project.Unit)',
    });
  });

  it('refus : sans jeton, jeton MCP ou de santé, autre éditeur, autre run, demande invalide', async () => {
    expect((await start('')).response.status).toBe(401);
    expect((await start(token({ scope: 'mcp' }))).text).toContain('Seul un jeton de CI');
    expect((await start(token({ scope: 'health' }))).response.status).toBe(403);
    expect((await start(token({ profile: 'unity' }))).text).toContain('pas unity');
    const invalid = await start(token(), { branch: 'main', sha: 'x', filter: 'Unit' });
    expect(invalid.response.status).toBe(400);
    expect(invalid.text).toContain('Commit invalide');
    // Un jeton de CI n'ouvre ni session MCP ni santé.
    expect(
      (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token()}` } })).status,
    ).toBe(403);

    const job = JSON.parse((await start(token())).text) as AutomationJob;
    expect((await get(token({ runId: 'autre' }), job.id)).response.status).toBe(404);
    expect((await get(token(), '00000000-0000-0000-0000-000000000000')).response.status).toBe(404);
    expect((await get(token({ scope: 'health' }), job.id)).text).toContain(
      'Seul un jeton de CI lit',
    );
  });

  it('pont sans tests d’automatisation (Unity) : 404 explicite', async () => {
    const unity = new AuraBridge({
      editor: 'unity',
      port: 0,
      secret: SECRET,
      allowedTools: () => [],
      connectUpstream: () =>
        connectStdioUpstream({ command: process.execPath, args: [FAKE_AURA], env: {} }),
    });
    const status = await unity.start();
    try {
      const response = await fetch(`http://127.0.0.1:${String(status.port)}/automation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token({ profile: 'unity' })}` },
        body: '{}',
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain('non disponibles sur le pont unity');
    } finally {
      await unity.stop();
    }
  });
});
