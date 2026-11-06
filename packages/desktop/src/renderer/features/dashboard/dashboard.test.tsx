// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardView } from '../../../shared/ipc-contract.js';
import { formatMinutes, RunsTable } from '../runs/RunsView.js';
import { LINE_HEIGHT, VirtualLog, visibleWindow } from '../runs/VirtualLog.js';
import { DashboardContent, Kanban } from './Dashboard.js';

// React Flow mesure le DOM : remplacé ici par un rendu minimal.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes }: { nodes: { id: string }[] }) => (
    <div data-testid="graphe">{nodes.map((n) => n.id).join(',')}</div>
  ),
  Background: () => null,
  Controls: () => null,
}));

const progress = (percent: number, done: number, total: number) => ({
  doneWeight: done,
  totalWeight: total,
  percent,
  doneTasks: done,
  totalTasks: total,
});

const dashboard = (overrides: Partial<DashboardView> = {}): DashboardView => ({
  projectId: 'kiamiya/site',
  repositoryUrl: 'https://github.com/kiamiya/site',
  paused: false,
  tasks: [
    {
      number: 1,
      id: 'T01',
      title: 'Socle',
      column: 'done',
      profile: 'architect',
      complexity: 'M',
      milestone: 'J1',
      dependencies: [],
      attempts: 1,
    },
    {
      number: 2,
      id: 'T02',
      title: 'Somme',
      column: 'running',
      profile: 'backend',
      complexity: 'S',
      milestone: 'J1',
      dependencies: ['T01'],
      attempts: 1,
    },
    {
      number: 3,
      id: 'T03',
      title: 'Agenda',
      column: 'escalated',
      profile: 'frontend',
      complexity: 'L',
      milestone: 'J2',
      dependencies: ['T01'],
      attempts: 3,
    },
  ],
  progress: {
    overall: progress(33, 1, 3),
    milestones: [
      { milestone: 'J1', progress: progress(67, 1, 2) },
      { milestone: 'J2', progress: progress(0, 0, 1) },
    ],
  },
  runs: [
    {
      id: 9,
      workflow: 'agentlake-agent-task.yml',
      name: 'AgentLake — agent, issue #3, tentative 3',
      status: 'completed',
      conclusion: 'failure',
      createdAt: '2026-11-20T10:00:00.000Z',
      url: 'https://github.com/kiamiya/site/actions/runs/9',
      minutes: 12.5,
      issueNumber: 3,
      taskId: 'T03',
      profile: 'frontend',
      attempt: 3,
    },
    {
      id: 8,
      workflow: 'ci.yml',
      name: 'CI',
      status: 'in_progress',
      conclusion: null,
      createdAt: '2026-11-20T09:00:00.000Z',
      url: 'https://github.com/kiamiya/site/actions/runs/8',
      minutes: 0.5,
      issueNumber: null,
      taskId: null,
      profile: null,
      attempt: null,
    },
  ],
  consumption: {
    month: '2026-11',
    monthMinutes: 75,
    totalMinutes: 130,
    byTask: [{ taskId: 'T03', agentRuns: 3, minutes: 40 }],
  },
  pullRequests: {
    T03: { number: 12, url: 'https://github.com/kiamiya/site/pull/12', state: 'open' },
  },
  ...overrides,
});

type Invoke = (channel: string, input: unknown) => Promise<{ ok: true; data: unknown }>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;

beforeEach(() => {
  invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve({
      ok: true,
      data: channel === 'dashboard:relaunch' ? { questionId: 'escalade-T03-3' } : { paused: true },
    }),
  );
  (window as unknown as { agentlake: { invoke: Invoke } }).agentlake = { invoke };
});

afterEach(() => {
  cleanup();
});

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe('tableau de bord', () => {
  it('avancement global et par jalon, kanban par état, graphe, consommation', () => {
    wrap(<DashboardContent dashboard={dashboard()} />);
    expect(
      screen.getByRole('progressbar', { name: 'Avancement global' }).getAttribute('aria-valuenow'),
    ).toBe('33');
    expect(
      screen.getByRole('progressbar', { name: 'Avancement J1' }).getAttribute('aria-valuenow'),
    ).toBe('67');
    expect(screen.getByRole('region', { name: 'Colonne Terminée' }).textContent).toContain(
      'T01 — Socle',
    );
    expect(screen.getByRole('region', { name: 'Colonne En cours' }).textContent).toContain('T02');
    expect(screen.getByTestId('graphe').textContent).toBe('T01,T02,T03');
    expect(screen.getByText(/Minutes Actions \(2026-11\)/).textContent).toContain('1 h 15 min');
    expect(screen.getByRole('table', { name: 'Consommation par tâche' }).textContent).toContain(
      'T03340 min',
    );
  });

  it('liens vers issue et PR ; relance d’une tâche escaladée avec consigne', async () => {
    wrap(<Kanban dashboard={dashboard()} />);
    const card = screen.getByRole('article', { name: 'Tâche T03' });
    expect(card.querySelector('a[href="https://github.com/kiamiya/site/issues/3"]')).toBeTruthy();
    expect(card.querySelector('a[href="https://github.com/kiamiya/site/pull/12"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Relancer T02' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Consigne pour T03'), { target: { value: 'entiers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Relancer T03' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('dashboard:relaunch', {
        projectId: 'kiamiya/site',
        issueNumber: 3,
        instruction: 'entiers',
      });
    });
    expect(await screen.findByRole('button', { name: 'Relance demandée' })).toBeTruthy();
  });

  it('pause : bouton et bandeau', async () => {
    wrap(<DashboardContent dashboard={dashboard({ paused: true })} />);
    expect(screen.getByRole('status').textContent).toContain('Projet en pause');
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre le projet' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('dashboard:set-paused', {
        projectId: 'kiamiya/site',
        paused: false,
      });
    });
  });
});

describe('runs', () => {
  it('profil, tâche, durée, tentative, conclusion et liens', () => {
    const onSelect = vi.fn();
    wrap(<RunsTable dashboard={dashboard()} selected={null} onSelect={onSelect} />);
    const rows = screen.getAllByRole('row');
    expect(rows[1]?.textContent).toContain('T03frontend313 minÉchec (failure)');
    expect(rows[1]?.textContent).toContain('PR #12');
    expect(rows[2]?.textContent).toContain('30 sEn cours');
    fireEvent.click(screen.getByRole('button', { name: 'CI' }));
    expect(onSelect).toHaveBeenCalledWith(8);
  });

  it('aucun run', () => {
    wrap(<RunsTable dashboard={dashboard({ runs: [] })} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Aucun run pour l’instant.')).toBeTruthy();
  });

  it.each([
    [0.25, '15 s'],
    [42.4, '42 min'],
    [135, '2 h 15 min'],
  ])('%s min → %s', (minutes, label) => {
    expect(formatMinutes(minutes)).toBe(label);
  });
});

describe('journal virtualisé', () => {
  const text = Array.from({ length: 10_000 }, (_, i) => `ligne ${String(i + 1)}`).join('\n');

  it('fenêtre visible bornée, quelle que soit la longueur', () => {
    expect(visibleWindow(0, 480, 10_000)).toEqual({ start: 0, end: 47 });
    expect(visibleWindow(9_000 * LINE_HEIGHT, 480, 10_000)).toEqual({ start: 8980, end: 9047 });
    expect(visibleWindow(10_000 * LINE_HEIGHT, 480, 10_000)).toEqual({ start: 9980, end: 10_000 });
  });

  it('10 000 lignes : moins de 100 dans le DOM, défilement jusqu’à la dernière, filtre', () => {
    wrap(<VirtualLog text={text} label="Journal du run" />);
    const log = screen.getByRole('log', { name: 'Journal du run' });
    expect(log.querySelectorAll('div > div > div').length).toBeLessThan(100);
    expect(screen.getByText('10000 lignes')).toBeTruthy();
    expect(log.firstElementChild?.getAttribute('style')).toContain(
      `height: ${String(10_000 * LINE_HEIGHT)}px`,
    );
    fireEvent.scroll(log, { target: { scrollTop: 10_000 * LINE_HEIGHT - 480 } });
    expect(screen.getByText('ligne 10000')).toBeTruthy();
    expect(screen.queryByText('ligne 1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filtrer Journal du run'), {
      target: { value: 'ligne 999' },
    });
    expect(screen.getByText('11 / 10000 lignes')).toBeTruthy();
  });
});
