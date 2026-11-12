// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredMcp } from '../../../shared/ipc-contract.js';
import { McpDetect } from './McpDetect.js';

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type Invoke = (channel: string, input: unknown) => Promise<Result>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;

const found: DiscoveredMcp[] = [
  {
    id: 'u1',
    name: 'unitymcp',
    editor: 'unity',
    sources: ['Claude Code (~/.claude.json)', 'Serveur HTTP en cours sur le port 8080'],
    kind: 'http',
    summary: 'http://127.0.0.1:8080/mcp',
    secrets: [],
    importable: true,
    reason: null,
    alreadyConfigured: null,
  },
  {
    id: 'm1',
    name: 'magic',
    editor: null,
    sources: ['Claude Code (~/.claude.json)'],
    kind: 'stdio',
    summary: 'npx -y @21st-dev/magic',
    secrets: ['API_KEY'],
    importable: true,
    reason: null,
    alreadyConfigured: null,
  },
  {
    id: 'h1',
    name: 'aura-unity-mcp-server',
    editor: 'unity',
    sources: ['Processus en cours'],
    kind: 'hint',
    summary: 'Processus « aura_unity_mcp.server »',
    secrets: [],
    importable: false,
    reason: 'Serveur MCP lancé par une autre application.',
    alreadyConfigured: null,
  },
];

beforeEach(() => {
  invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve(
      channel === 'mcp:detect'
        ? { ok: true, data: found }
        : {
            ok: true,
            data: [
              {
                editor: 'unity',
                name: 'unitymcp',
                slot: 'extra',
                connected: true,
                error: null,
                tools: 50,
              },
              {
                editor: 'blender',
                name: 'magic',
                slot: 'extra',
                connected: false,
                error: 'injoignable',
                tools: 0,
              },
            ],
          },
    ),
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

describe('détection des MCP du poste', () => {
  it('propose, coche par défaut ce qui est sûr, exige un éditeur, ajoute et rapporte', async () => {
    wrap(<McpDetect />);
    fireEvent.click(screen.getByRole('button', { name: 'Détecter les MCP du poste' }));
    const unity = await screen.findByLabelText<HTMLInputElement>('Ajouter unitymcp');
    expect(unity.checked).toBe(true);
    // Sans éditeur deviné : décoché ; une piste ne s'ajoute pas.
    expect(screen.getByLabelText<HTMLInputElement>('Ajouter magic').checked).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Ajouter aura-unity-mcp-server').disabled).toBe(
      true,
    );
    expect(screen.getByText(/1 secret\(s\) \(API_KEY\) rangé\(s\) dans le coffre/)).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Tous les outils');

    fireEvent.click(screen.getByLabelText('Ajouter magic'));
    expect(screen.getByRole('button', { name: 'Ajouter la sélection (1)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Éditeur de magic'), { target: { value: 'blender' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter la sélection (2)' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('mcp:import', {
        selections: [
          { id: 'u1', editor: 'unity', name: 'unitymcp' },
          { id: 'm1', editor: 'blender', name: 'magic' },
        ],
      });
    });
    expect(
      (await screen.findByText(/connecté, 50 outil\(s\) autorisé\(s\)/)).textContent,
    ).toContain('Unity');
    expect(screen.getByText(/non connecté \(injoignable\)/)).toBeTruthy();
  });
});
