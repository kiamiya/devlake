// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetLibraryView } from '../../../shared/ipc-contract.js';
import { AssetsSection } from './AssetsSection.js';

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

const view = (overrides: Partial<AssetLibraryView> = {}): AssetLibraryView => ({
  type: 'unity',
  game: true,
  private: false,
  library: {
    version: 1,
    assets: [
      {
        id: 'foret',
        name: 'Forêt',
        origin: 'store-link',
        status: 'wanted',
        license: 'store',
        url: 'https://assetstore.unity.com/packages/3d/foret',
        addedAt: '2026-11-10T10:00:00.000Z',
      },
    ],
  },
  ...overrides,
});

describe('section Assets', () => {
  it('projet non jeu : explication seulement', async () => {
    routes['assets:library'] = () => view({ type: 'web', game: false });
    wrap(<AssetsSection projectId="kiamiya/site" />);
    expect((await screen.findByRole('note')).textContent).toContain('projets de jeu');
  });

  it('mes assets : choix, avertissement public à confirmer, versement et tâche', async () => {
    routes['assets:library'] = () => view();
    routes['assets:owned'] = () => ({
      assets: [
        {
          key: 'k1',
          name: 'Caisses',
          origin: 'unity-store-cache',
          kind: 'unitypackage',
          engine: 'unity',
          path: 'C:/cache/Caisses.unitypackage',
          size: 2_500_000,
          publisher: 'Studio',
        },
        {
          key: 'k2',
          name: 'Ruines',
          origin: 'epic-vault',
          kind: 'unreal-content',
          engine: 'unreal',
          path: 'C:/vault/Ruines',
          size: null,
          publisher: null,
        },
      ],
      notes: [],
    });
    routes['assets:import'] = () => ({
      entry: {
        id: 'caisses',
        name: 'Caisses',
        origin: 'store-link',
        status: 'imported',
        license: 'store',
        path: 'Assets/Caisses',
        files: 12,
        size: 2_400_000,
        integrationIssue: 7,
        addedAt: '2026-11-10T10:00:00.000Z',
      },
      commitSha: 'abc',
      task: { taskId: 'T500', issueNumber: 7, url: 'https://github.com/kiamiya/jeu/issues/7' },
      warnings: [],
    });
    wrap(<AssetsSection projectId="kiamiya/jeu" />);
    expect(await screen.findByText('Forêt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chercher mes assets' }));
    // Contenu Unreal masqué dans un projet Unity.
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir Caisses' }));
    expect(screen.queryByText('Ruines')).toBeNull();

    fireEvent.change(screen.getByLabelText('Remplit le lien de boutique'), {
      target: { value: 'foret' },
    });
    const submit = screen.getByRole('button', { name: 'Verser dans le projet' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Je confirme verser cet asset dans un dépôt public'));
    fireEvent.click(submit);
    expect((await screen.findByText(/Tâche d’intégration T500/)).textContent).toContain('issue #7');
    expect(invoke).toHaveBeenCalledWith('assets:import', {
      projectId: 'kiamiya/jeu',
      from: { kind: 'owned', key: 'k1' },
      name: 'Caisses',
      license: 'store',
      replaces: 'foret',
      acknowledgePublicLicense: true,
    });
  });

  it('boutique : ajoute un lien ; gratuites : recherche puis choix en CC0', async () => {
    routes['assets:library'] = () => view({ private: true });
    routes['assets:add-link'] = () => ({});
    routes['assets:search'] = () => [
      {
        source: 'polyhaven',
        id: 'crate',
        name: 'Wooden Crate',
        type: 'model',
        thumbnail: 'data:image/png;base64,iVA=',
        url: 'https://polyhaven.com/a/crate',
      },
    ];
    wrap(<AssetsSection projectId="kiamiya/jeu" />);
    fireEvent.change(await screen.findByLabelText('Lien de l’asset'), {
      target: { value: 'https://www.fab.com/listings/abc' },
    });
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Château' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter à la bibliothèque' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('assets:add-link', {
        projectId: 'kiamiya/jeu',
        url: 'https://www.fab.com/listings/abc',
        name: 'Château',
        license: 'store',
      });
    });

    fireEvent.change(screen.getByLabelText('Recherche'), { target: { value: 'crate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rechercher' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir Wooden Crate' }));
    // Licence du formulaire de versement (la boutique a aussi la sienne).
    expect(document.querySelector<HTMLSelectElement>('#asset-license')?.value).toBe('cc0');
    expect(document.querySelector<HTMLSelectElement>('#store-license')?.value).toBe('store');
    // Dépôt privé : aucun avertissement.
    expect(screen.queryByText(/Je confirme verser/)).toBeNull();
  });
});
