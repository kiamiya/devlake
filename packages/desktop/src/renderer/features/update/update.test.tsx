// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../../shared/ipc-contract.js';
import { UpdateBanner, UpdateSettings } from './UpdateBanner.js';

type Invoke = (channel: string, input: unknown) => Promise<{ ok: true; data: unknown }>;

const base: UpdateState = {
  status: 'available',
  currentVersion: '1.7.0',
  version: '1.8.0',
  notes: 'Mises à jour intégrées.',
  progress: null,
  error: null,
  checkedAt: '2026-11-12T10:00:00.000Z',
  manualInstall: false,
  dismissedVersion: null,
};

function mount(node: ReactNode, state: UpdateState, after: Partial<UpdateState> = {}) {
  const invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve({
      ok: true,
      data: channel === 'update:status' ? state : { ...state, ...after },
    }),
  );
  (window as unknown as { agentlake: { invoke: Invoke } }).agentlake = { invoke };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return invoke;
}

afterEach(() => {
  cleanup();
});

describe('bandeau de mise à jour', () => {
  it('disponible : notes, téléchargement sur clic, puis redémarrage', async () => {
    const invoke = mount(<UpdateBanner />, base, { status: 'downloaded', progress: 100 });
    expect(
      await screen.findByText('AgentLake 1.8.0 est disponible (version actuelle : 1.7.0).'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voir les nouveautés' }));
    expect(screen.getByText('Mises à jour intégrées.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Télécharger' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update:download', undefined);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Redémarrer pour mettre à jour' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update:install', undefined);
    });
    expect(screen.getByText(/s’installera à la fermeture du cockpit/)).toBeTruthy();
  });

  it('macOS : ouvrir l’installeur ; refermé pour cette version ; rien si à jour', async () => {
    const invoke = mount(
      <UpdateBanner />,
      { ...base, status: 'downloaded', manualInstall: true },
      {
        dismissedVersion: '1.8.0',
      },
    );
    expect(await screen.findByRole('button', { name: 'Ouvrir l’installeur' })).toBeTruthy();
    expect(screen.getByText(/glisse AgentLake dans Applications/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer le bandeau de mise à jour' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update:dismiss', { version: '1.8.0' });
    });
    cleanup();
    mount(<UpdateBanner />, { ...base, dismissedVersion: '1.8.0' });
    await waitFor(() => {
      expect(screen.queryByLabelText('Mise à jour du cockpit')).toBeNull();
    });
    cleanup();
    mount(<UpdateBanner />, { ...base, status: 'up-to-date', version: null });
    await waitFor(() => {
      expect(screen.queryByLabelText('Mise à jour du cockpit')).toBeNull();
    });
  });

  it('réglages : version, état et vérification manuelle (désactivée en développement)', async () => {
    const invoke = mount(<UpdateSettings />, { ...base, status: 'up-to-date', version: null });
    expect(await screen.findByText('1.7.0')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('À jour.');
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier maintenant' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update:check', undefined);
    });
    cleanup();
    mount(<UpdateSettings />, { ...base, status: 'unsupported', version: null });
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: 'Vérifier maintenant' }))
        .disabled,
    ).toBe(true);
  });
});
