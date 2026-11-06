import {
  BRIDGE_SIGNATURE_HEADER,
  signBridgeResponse,
  verifyBridgeToken,
} from 'shared/bridge-token';
import { describe, expect, it } from 'vitest';
import { editorCiMain, renderAutomationSummary, type EditorCiDeps } from './editor-ci.js';

const SECRET = 'secret-ci-unreal'; // gitleaks:allow
const SHA = 'c'.repeat(40);
const ENV = {
  AURA_BRIDGE_URL: 'https://poste.ts.net/unreal/',
  AURA_BRIDGE_SECRET: SECRET,
  GITHUB_REPOSITORY: 'kiamiya/jeu-unreal',
  GITHUB_RUN_ID: '555',
  GITHUB_JOB: 'unit-tests',
  BRANCH: 'task/T07-saut',
  SHA,
  AUTOMATION_FILTER: 'Project.Unit',
  GITHUB_STEP_SUMMARY: '/tmp/resume.md',
};

const job = (state: string, overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  repo: 'kiamiya/jeu-unreal',
  sha: SHA,
  state,
  summary: { passed: 2, failed: 0, skipped: 0 },
  tests: [],
  error: null,
  logTail: [],
  ...overrides,
});

const signed = (status: number, data: unknown, secret = SECRET) => {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: { [BRIDGE_SIGNATURE_HEADER]: signBridgeResponse(body, secret) },
  });
};
const plain = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });

/** Faux pont : réponses jouées dans l'ordre ; requêtes et jetons gardés. */
function harness(responses: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const logs: string[] = [];
  const summaries: string[] = [];
  let clock = Date.parse('2026-11-06T10:00:00Z');
  let slept = 0;
  const deps: EditorCiDeps = {
    fetch: (url, init) => {
      requests.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('requête inattendue');
      return Promise.resolve(next());
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      slept += ms;
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
    appendText: (_path, text) => {
      summaries.push(text);
      return Promise.resolve();
    },
  };
  return { deps, requests, logs, summaries, slept: () => slept };
}

const tokenOf = (init: RequestInit | undefined) => {
  const header = (init?.headers as Record<string, string>).authorization ?? '';
  const check = verifyBridgeToken(
    header.replace('Bearer ', ''),
    SECRET,
    new Date('2026-11-06T10:00:00Z'),
  );
  if (!check.ok) throw new Error(check.reason);
  return check.payload;
};

describe('check Unreal via le pont', () => {
  it('éditeur occupé puis libre : lance, attend, réussit ; jeton de CI signé', async () => {
    const h = harness([
      () => plain(409, { error: { message: 'Éditeur unreal occupé par le run 9.' } }),
      () => signed(202, job('running')),
      () => signed(200, job('running')),
      () => signed(200, job('passed')),
    ]);
    expect(await editorCiMain(ENV, h.deps)).toBe(0);
    expect(h.requests.map((r) => r.url)).toEqual([
      'https://poste.ts.net/unreal/automation',
      'https://poste.ts.net/unreal/automation',
      'https://poste.ts.net/unreal/automation/11111111-1111-1111-1111-111111111111',
      'https://poste.ts.net/unreal/automation/11111111-1111-1111-1111-111111111111',
    ]);
    expect(JSON.parse(h.requests[0]?.init?.body as string)).toEqual({
      branch: 'task/T07-saut',
      sha: SHA,
      filter: 'Project.Unit',
    });
    expect(tokenOf(h.requests[0]?.init)).toMatchObject({
      repo: 'kiamiya/jeu-unreal',
      runId: '555/unit-tests',
      profile: 'unreal',
      scope: 'ci',
    });
    expect(h.logs[0]).toContain('occupé par le run 9. Nouvel essai dans 30 s.');
    expect(h.summaries[0]).toContain('✅ Tests d’automatisation Unreal (Project.Unit)');
  });

  it('tests en échec : check rouge, tests et erreurs dans le résumé', async () => {
    const h = harness([
      () =>
        signed(
          202,
          job('failed', {
            summary: { passed: 1, failed: 1, skipped: 0 },
            tests: [{ name: 'Project.Unit.Chute', state: 'failed', errors: ['a | b'] }],
          }),
        ),
    ]);
    expect(await editorCiMain(ENV, h.deps)).toBe(1);
    expect(h.summaries[0]).toContain('| `Project.Unit.Chute` | a \\| b |');
  });

  it('réponse non signée ou signée avec un autre secret : refusée', async () => {
    for (const response of [plain(202, job('passed')), signed(202, job('passed'), 'autre')]) {
      const h = harness([() => response]);
      expect(await editorCiMain(ENV, h.deps)).toBe(1);
      expect(h.logs.at(-1)).toBe('Réponse non signée par le pont : ignorée.');
    }
  });

  it('réponse pour un autre commit : refusée', async () => {
    const h = harness([() => signed(202, job('passed', { sha: 'd'.repeat(40) }))]);
    expect(await editorCiMain(ENV, h.deps)).toBe(1);
    expect(h.logs.at(-1)).toContain('autre dépôt ou commit');
  });

  it('refus du pont, pont injoignable : échec avec la raison', async () => {
    const refused = harness([
      () => plain(400, { error: { message: 'Filtre de tests invalide.' } }),
    ]);
    expect(await editorCiMain(ENV, refused.deps)).toBe(1);
    expect(refused.logs.at(-1)).toBe('Pont Aura : Filtre de tests invalide.');
    expect(refused.summaries[0]).toContain('**Pont Aura : Filtre de tests invalide.**');

    const down = harness([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);
    expect(await editorCiMain(ENV, down.deps)).toBe(1);
    expect(down.logs.at(-1)).toContain('Pont Aura injoignable (ECONNREFUSED)');
  });

  it('éditeur occupé jusqu’à l’échéance : échec', async () => {
    const h = harness(
      Array.from({ length: 10 }, () => () => plain(409, { error: { message: 'Occupé.' } })),
    );
    expect(await editorCiMain({ ...ENV, WAIT_MINUTES: '2' }, h.deps)).toBe(1);
    expect(h.logs.at(-1)).toContain('Éditeur toujours occupé à l’échéance');
  });

  it('coupures réseau passagères tolérées, puis abandon après cinq d’affilée', async () => {
    const fail = () => {
      throw new Error('reset');
    };
    const ok = harness([
      () => signed(202, job('running')),
      fail,
      fail,
      () => signed(200, job('passed')),
    ]);
    expect(await editorCiMain(ENV, ok.deps)).toBe(0);

    const ko = harness([() => signed(202, job('running')), fail, fail, fail, fail, fail]);
    expect(await editorCiMain(ENV, ko.deps)).toBe(1);
    expect(ko.logs.at(-1)).toContain('Pont Aura injoignable pendant les tests (reset)');
  });

  it('lecture refusée ou toujours en cours à l’échéance : échec', async () => {
    const lost = harness([
      () => signed(202, job('running')),
      () => plain(404, { error: 'Passe de tests inconnue pour ce run.' }),
    ]);
    expect(await editorCiMain(ENV, lost.deps)).toBe(1);
    expect(lost.logs.at(-1)).toBe('Pont Aura : Passe de tests inconnue pour ce run.');

    const slow = harness([
      () => signed(202, job('running')),
      ...Array.from({ length: 20 }, () => () => signed(200, job('running'))),
    ]);
    expect(await editorCiMain({ ...ENV, WAIT_MINUTES: '1' }, slow.deps)).toBe(1);
    expect(slow.logs.at(-1)).toContain('toujours en cours à l’échéance');
  });

  it('variables manquantes : échec lisible, sans appel au pont', async () => {
    const h = harness([]);
    expect(
      await editorCiMain({ ...ENV, AURA_BRIDGE_URL: undefined, AURA_BRIDGE_SECRET: '' }, h.deps),
    ).toBe(1);
    expect(h.logs[0]).toContain('AURA_BRIDGE_URL absente ou invalide');
    expect(h.logs[0]).toContain('AURA_BRIDGE_SECRET absent');
    expect(h.requests).toEqual([]);
  });

  it('résumé d’une erreur : raison et fin du journal', () => {
    const text = renderAutomationSummary(
      job('error', {
        summary: { passed: 0, failed: 0, skipped: 0 },
        error: 'Sans rapport.',
        logTail: ['LogInit: Fatal'],
      }) as Parameters<typeof renderAutomationSummary>[0],
      'Project.Unit',
    );
    expect(text).toContain('❌');
    expect(text).toContain('**Sans rapport.**');
    expect(text).toContain('LogInit: Fatal');
  });
});
