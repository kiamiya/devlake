// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuditEntryView,
  BridgeViewData,
  TunnelStateView,
} from '../../../shared/ipc-contract.js';
import { BridgeCard, BridgePanel, describeCall, TunnelCard } from './BridgePanel.js';

const call: AuditEntryView = {
  at: '2026-11-21T10:00:00.000Z',
  editor: 'unity',
  repo: 'kiamiya/jeu',
  runId: '42',
  tool: 'scene_list',
  durationMs: 12,
  outcome: 'ok',
  detail: null,
};

const bridge = (overrides: Partial<BridgeViewData> = {}): BridgeViewData => ({
  editor: 'unity',
  running: true,
  port: 8765,
  activeRun: { runId: '42', repo: 'kiamiya/jeu' },
  lastCall: call,
  configured: true,
  allowedTools: ['scene_list'],
  configuredPort: 8765,
  ...overrides,
});

type Invoke = (channel: string, input: unknown) => Promise<{ ok: true; data: unknown }>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;
let tunnelState: TunnelStateView;

beforeEach(() => {
  tunnelState = {
    open: true,
    url: 'https://poste.tailnet.ts.net',
    provider: 'tailscale',
    killed: false,
    autoExpose: true,
    projects: [{ id: 'kiamiya/jeu', editor: 'unity', url: 'https://poste.tailnet.ts.net/unity' }],
    error: null,
  };
  invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve({
      ok: true,
      data: channel.startsWith('tunnel:')
        ? tunnelState
        : channel === 'bridge:list'
          ? [
              bridge(),
              bridge({
                editor: 'unreal',
                running: false,
                port: null,
                activeRun: null,
                lastCall: null,
                configured: false,
                allowedTools: [],
                configuredPort: 8766,
              }),
            ]
          : channel === 'bridge:tools'
            ? [
                { name: 'scene_list', description: 'Liste les scènes', allowed: true },
                { name: 'run_script', description: '', allowed: false },
              ]
            : channel === 'bridge:audit'
              ? [
                  call,
                  {
                    ...call,
                    tool: null,
                    runId: null,
                    repo: null,
                    outcome: 'refused',
                    detail: 'Jeton du pont expiré.',
                  },
                ]
              : bridge(),
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

describe('pont Aura dans le cockpit', () => {
  it('état, run actif, dernier appel ; arrêt', async () => {
    wrap(<BridgeCard bridge={bridge()} />);
    const card = screen.getByRole('region', { name: 'Pont Unity' });
    expect(card.textContent).toContain('Démarré');
    expect(card.textContent).toContain('127.0.0.1:8765');
    expect(card.textContent).toContain('Éditeur utilisé par le run 42 (kiamiya/jeu).');
    expect(card.textContent).toContain('Dernier appel : scene_list · run 42 · réussi · 12 ms');
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter le pont Unity' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('bridge:stop', { editor: 'unity' });
    });
  });

  it('liste blanche : cocher un outil d’Aura ou en ajouter un par son nom', async () => {
    wrap(<BridgeCard bridge={bridge()} />);
    const script = await screen.findByRole('checkbox', { name: /run_script/ });
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /scene_list/ }).checked).toBe(
      true,
    );
    fireEvent.click(script);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('bridge:set-tools', {
        editor: 'unity',
        tools: ['scene_list', 'run_script'],
      });
    });
    fireEvent.change(screen.getByLabelText('Ajouter un outil Unity'), {
      target: { value: ' editor_status ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Autoriser' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('bridge:set-tools', {
        editor: 'unity',
        tools: ['scene_list', 'editor_status'],
      });
    });
  });

  it('journal d’audit : appels et accès refusés', async () => {
    wrap(<BridgeCard bridge={bridge()} />);
    const table = await screen.findByRole('table', { name: 'Journal d’audit Unity' });
    expect(table.textContent).toContain('kiamiya/jeu #42scene_list12 msréussi');
    expect(table.textContent).toContain('accès—refusé');
  });

  it('pont non configuré : démarrage impossible ; panneau avec les deux éditeurs', async () => {
    wrap(<BridgePanel />);
    expect(await screen.findByRole('region', { name: 'Pont Unreal' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Démarrer le pont Unreal' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText(/Colle d’abord la configuration MCP d’Aura \(Unreal\)/)).toBeTruthy();
  });

  it('démarrer un pont configuré', async () => {
    wrap(
      <BridgeCard
        bridge={bridge({ running: false, port: null, activeRun: null, lastCall: null })}
      />,
    );
    expect(screen.getByText('Aucun agent connecté.')).toBeTruthy();
    expect(screen.getByText('Dernier appel : aucun')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Démarrer le pont Unity' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('bridge:start', { editor: 'unity' });
    });
    expect(describeCall({ ...call, tool: null, runId: null, outcome: 'refused' })).toBe(
      'accès · inconnu · refusé',
    );
  });
});

describe('tunnel dans le cockpit', () => {
  it('ouvert : URL publique, projets reliés, fermeture et interrupteur', async () => {
    wrap(<TunnelCard />);
    const card = await screen.findByRole('region', { name: 'Tunnel' });
    expect(card.textContent).toContain('Tunnel (Tailscale Funnel)');
    expect(card.textContent).toContain('Ouvert');
    expect(card.textContent).toContain('URL publique : https://poste.tailnet.ts.net');
    expect(screen.getByRole('list', { name: 'Projets de jeu reliés' }).textContent).toContain(
      'kiamiya/jeu → https://poste.tailnet.ts.net/unity',
    );
    expect(card.textContent).toContain('Exposition automatique');
    fireEvent.click(screen.getByRole('button', { name: 'Interrupteur d’arrêt' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tunnel:kill', undefined);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fermer le tunnel' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tunnel:close', undefined);
    });
  });

  it('coupé par l’interrupteur, exposition manuelle, erreur affichée ; réouverture', async () => {
    tunnelState = {
      ...tunnelState,
      open: false,
      url: null,
      killed: true,
      autoExpose: false,
      projects: [],
      provider: 'cloudflare',
      error: 'cloudflared introuvable',
    };
    wrap(<TunnelCard />);
    const card = await screen.findByRole('region', { name: 'Tunnel' });
    expect(card.textContent).toContain('Cloudflare Tunnel');
    expect(card.textContent).toContain('Coupé par l’interrupteur');
    expect(card.textContent).toContain('Exposition manuelle');
    expect(screen.getByRole('alert').textContent).toBe('cloudflared introuvable');
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le tunnel' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('tunnel:open', undefined);
    });
  });
});
