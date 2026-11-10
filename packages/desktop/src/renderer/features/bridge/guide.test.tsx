// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeViewData, TunnelStateView } from '../../../shared/ipc-contract.js';
import { bridgeChecklist } from './checklist.js';
import { BridgeChecklist, McpGuide } from './McpGuide.js';

afterEach(() => {
  cleanup();
});

const bridge = (overrides: Partial<BridgeViewData> = {}): BridgeViewData => ({
  editor: 'unity',
  running: false,
  port: null,
  activeRun: null,
  lastCall: null,
  configured: false,
  allowedTools: [],
  configuredPort: 8765,
  servers: [],
  ...overrides,
});

const tunnel = (overrides: Partial<TunnelStateView> = {}): TunnelStateView => ({
  open: false,
  url: null,
  provider: 'tailscale',
  killed: false,
  autoExpose: true,
  projects: [],
  error: null,
  ...overrides,
});

const statuses = (items: ReturnType<typeof bridgeChecklist>) =>
  Object.fromEntries(items.map((i) => [i.id, i.status]));

describe('vérification du branchement d’un pont', () => {
  it('rien de fait : tout est à faire, sauf l’éditeur (à vérifier soi-même) et le tunnel automatique', () => {
    const items = bridgeChecklist(bridge(), { clonesDir: null, tunnel: tunnel() });
    expect(statuses(items)).toEqual({
      config: 'todo',
      running: 'todo',
      servers: 'todo',
      tools: 'todo',
      clones: 'todo',
      editor: 'manual',
      tunnel: 'ok',
    });
    expect(items.find((i) => i.id === 'tunnel')?.hint).toContain('s’ouvrira seul');
  });

  it('serveur injoignable signalé avec son erreur ; tout le reste en place', () => {
    const items = bridgeChecklist(
      bridge({
        running: true,
        port: 8765,
        configured: true,
        allowedTools: ['unity__create_object'],
        servers: [
          { name: 'aura', connected: true, error: null },
          { name: 'unity', connected: false, error: 'connexion refusée' },
        ],
      }),
      { clonesDir: 'D:/clones', tunnel: tunnel({ open: true, url: 'https://poste.ts.net' }) },
    );
    expect(statuses(items)).toMatchObject({
      config: 'ok',
      running: 'ok',
      servers: 'todo',
      tools: 'ok',
      clones: 'ok',
      tunnel: 'ok',
    });
    expect(items.find((i) => i.id === 'servers')?.hint).toContain('unity (connexion refusée)');
  });

  it('tunnel coupé par l’interrupteur, ou en ouverture manuelle : à faire', () => {
    expect(
      bridgeChecklist(bridge(), { clonesDir: null, tunnel: tunnel({ killed: true }) }).at(-1),
    ).toMatchObject({ status: 'todo', hint: expect.stringContaining('Interrupteur') as unknown });
    expect(
      bridgeChecklist(bridge(), { clonesDir: null, tunnel: tunnel({ autoExpose: false }) }).at(-1)
        ?.status,
    ).toBe('todo');
  });

  it('affichage : compteur, marques et indications ; Blender parle de son clone', () => {
    render(
      <BridgeChecklist
        bridge={bridge({ editor: 'blender', configured: true })}
        clonesDir={null}
        tunnel={null}
      />,
    );
    expect(screen.getByText('Vérification du branchement (1/7)')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Vérification du pont Blender' });
    expect(within(list).getAllByLabelText('à faire')).toHaveLength(5);
    expect(within(list).getByText('Blender ouvert sur le clone Blender')).toBeTruthy();
  });
});

describe('guide de branchement d’un serveur MCP', () => {
  it('Unity : étapes, formes acceptées, nom réservé, essai par une tâche', () => {
    render(<McpGuide editor="unity" />);
    expect(screen.getByText('Comment brancher un serveur MCP (Unity)')).toBeTruthy();
    const text = document.body.textContent;
    expect(text).toContain('« Configuration MCP Aura — Unity »');
    expect(text).toContain('Le nom « aura » est réservé.');
    expect(text).toContain('"command": "uvx"');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('http://127.0.0.1:<port>/mcp');
    expect(text).toContain('Une adresse distante est refusée');
    expect(text).toContain('« Préparer le clone de l’éditeur »');
    expect(text).toContain('profil unity');
  });

  it('Blender : serveur principal blender-mcp et clone Blender', () => {
    render(<McpGuide editor="blender" />);
    const text = document.body.textContent;
    expect(text).toContain('« Configuration MCP Blender (blender-mcp) »');
    expect(text).toContain('« Préparer le clone Blender »');
  });
});
