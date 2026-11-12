// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdhocTaskForm } from './AdhocTaskForm.js';

type Invoke = (
  channel: string,
  input: unknown,
) => Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;

beforeEach(() => {
  invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve(
      channel === 'dashboard:get'
        ? {
            ok: true,
            data: {
              tasks: [{ id: 'T01', title: 'API des créneaux', column: 'done' }],
            },
          }
        : {
            ok: true,
            data: {
              taskId: 'T500',
              issueNumber: 12,
              url: 'https://github.com/kiamiya/site/issues/12',
              dispatched: true,
              warnings: [],
            },
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

const fill = (label: string | RegExp, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('nouvelle tâche (hors plan)', () => {
  it('dans un projet : envoie la tâche complète et confirme la création', async () => {
    wrap(<AdhocTaskForm projectId="kiamiya/site" />);
    fill('Titre', 'Corriger le fuseau');
    fill('Description', 'Les rappels partent une heure trop tôt.');
    fill('Profil d’agent', 'backend');
    fill('Taille', 'M');
    fill('Critères d’acceptation (un par ligne)', 'Rappel à 18 h');
    fill(/Tests exigés/, 'Rappel en hiver');
    fill('Catégorie des tests', 'integration');
    fireEvent.click(await screen.findByLabelText('T01 — API des créneaux'));
    fireEvent.click(screen.getByLabelText('Prioritaire : lancée avant les tâches du plan'));
    fireEvent.click(screen.getByRole('button', { name: 'Créer la tâche' }));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Tâche T500 créée (issue #12) : le dispatcher la lance dès qu’une place se libère.',
    );
    expect(invoke).toHaveBeenCalledWith('tasks:create', {
      projectId: 'kiamiya/site',
      title: 'Corriger le fuseau',
      description: 'Les rappels partent une heure trop tôt.',
      kind: 'code',
      profile: 'backend',
      complexity: 'M',
      acceptanceCriteria: 'Rappel à 18 h',
      tests: 'Rappel en hiver',
      testCategory: 'integration',
      codeZones: '',
      scopePaths: '',
      scopeTools: '',
      dependencies: ['T01'],
      priority: true,
    });
  });

  it('depuis l’Accueil : choix du projet ; refus affiché', async () => {
    invoke.mockImplementation((channel) =>
      Promise.resolve(
        channel === 'dashboard:get'
          ? { ok: true, data: { tasks: [] } }
          : {
              ok: false,
              error: {
                code: 'ADHOC_TASK_ERROR',
                message: 'Une tâche de code doit exiger au moins un test.',
              },
            },
      ),
    );
    const onClose = vi.fn();
    wrap(<AdhocTaskForm projects={['kiamiya/site', 'kiamiya/jeu']} onClose={onClose} />);
    fill('Projet', 'kiamiya/jeu');
    fill('Titre', 'Saut');
    fireEvent.click(screen.getByRole('button', { name: 'Créer la tâche' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Une tâche de code doit exiger au moins un test.',
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'tasks:create',
        expect.objectContaining({ projectId: 'kiamiya/jeu' }),
      );
    });
    expect(screen.getByText('Aucune tâche existante.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onClose).toHaveBeenCalled();
  });
});
