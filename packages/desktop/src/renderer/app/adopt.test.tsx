// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdoptionReport, InventoryState } from '../../shared/ipc-contract.js';
import { InventoryCard } from '../features/plan/InventoryCard.js';
import { AdoptProjectWizard } from './AdoptProjectWizard.js';

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type Invoke = (channel: string, input: unknown) => Promise<Result>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;
let routes: Record<string, (input: unknown) => unknown>;

beforeEach(() => {
  routes = {};
  invoke = vi.fn<Invoke>((channel, input) => {
    const route = routes[channel];
    return Promise.resolve(
      route
        ? { ok: true, data: route(input) }
        : { ok: false, error: { code: 'X', message: `canal ${channel}` } },
    );
  });
  (window as unknown as { agentlake: { invoke: Invoke } }).agentlake = { invoke };
});

afterEach(() => {
  cleanup();
});

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const report = (overrides: Partial<AdoptionReport> = {}): AdoptionReport => ({
  repository: { owner: 'studio', repo: 'jeu', private: true, defaultBranch: 'master' },
  alreadyAgentLake: false,
  detectedType: 'unity',
  type: 'unity',
  qualityProfile: 'unity',
  blockers: [],
  changes: ['Branche par défaut « master » renommée en « main ».'],
  warnings: ['2 fichier(s) binaire(s) déjà commités hors Git LFS'],
  heavyOutsideLfs: [{ path: 'Art/caisse.blend', size: 5_000_000 }],
  heavyOutsideLfsCount: 2,
  blendFiles: 1,
  workflows: ['.github/workflows/build.yml'],
  requiredChecks: ['build'],
  openIssues: 3,
  openPullRequests: 1,
  engineConfigured: true,
  blenderConfigured: false,
  ...overrides,
});

describe('reprise d’un projet existant', () => {
  it('analyse, montre les changements, exige l’accord, puis reprend le projet', async () => {
    routes['projects:adoptable'] = () => [
      { owner: 'studio', repo: 'jeu', private: true, defaultBranch: 'master' },
    ];
    routes['projects:detect'] = () => report();
    routes['projects:adopt'] = () => ({
      project: {
        id: 'studio/jeu',
        owner: 'studio',
        repo: 'jeu',
        lastSyncedAt: null,
        pendingQuestions: 0,
        activeAgents: 0,
      },
      report: {
        repository: { owner: 'studio', repo: 'jeu' },
        steps: [{ step: 'files', status: 'updated' }],
      },
      renamedBranch: 'master',
    });
    wrap(<AdoptProjectWizard onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyser jeu' }));

    expect(await screen.findByText(/« master » renommée en « main »/)).toBeTruthy();
    expect(screen.getByText(/Workflows gardés : build.yml/)).toBeTruthy();
    expect(screen.getByText(/MCP Blender : à configurer/)).toBeTruthy();
    const adopt = screen.getByRole('button', { name: 'Reprendre le projet' });
    expect((adopt as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('J’accepte ces changements de réglages'));
    expect((adopt as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(adopt);
    const done = await screen.findByText(/Projet studio\/jeu repris/);
    expect(done.textContent).toContain('Branche « master » renommée en « main ».');
    expect(done.textContent).toContain('Lancer l’état des lieux');
    expect(invoke).toHaveBeenCalledWith('projects:adopt', {
      owner: 'studio',
      repo: 'jeu',
      type: 'unity',
      qualityProfile: 'unity',
      acceptChanges: true,
    });
  });

  it('blocage : reprise impossible, raison affichée', async () => {
    routes['projects:adoptable'] = () => [
      { owner: 'studio', repo: 'jeu', private: false, defaultBranch: 'main' },
    ];
    routes['projects:detect'] = () =>
      report({ blockers: ['Projet Unity dans le sous-dossier « Game »'], changes: [] });
    wrap(<AdoptProjectWizard onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyser jeu' }));
    expect((await screen.findByRole('alert')).textContent).toContain('sous-dossier « Game »');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Reprendre le projet' }).disabled,
    ).toBe(true);
  });
});

describe('état des lieux', () => {
  const state = (overrides: Partial<InventoryState> = {}): InventoryState => ({
    adopted: true,
    versions: [{ version: 1, branch: 'etat-des-lieux/v1' }],
    latest: { version: 1, content: '# État des lieux\n\nStack : Unity 6.' },
    validated: false,
    ...overrides,
  });

  it('lance, montre la dernière version et la valide', async () => {
    routes['inventory:get'] = () => state();
    routes['planner:start'] = () => ({ dispatched: true });
    routes['inventory:validate'] = () => ({ commitSha: 'abc' });
    wrap(<InventoryCard projectId="studio/jeu" />);
    expect(await screen.findByText('Stack : Unity 6.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refaire l’état des lieux' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('planner:start', {
        projectId: 'studio/jeu',
        mode: 'inventory',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Valider l’état des lieux v1' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('inventory:validate', {
        projectId: 'studio/jeu',
        version: 1,
      });
    });
  });

  it('projet créé par AgentLake : rien d’affiché', async () => {
    routes['inventory:get'] = () => state({ adopted: false });
    const { container } = wrap(<InventoryCard projectId="kiamiya/site" />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
