// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionView } from '../../../shared/ipc-contract.js';
import { formatAge } from './age.js';
import { QuestionCard } from './QuestionCard.js';
import { QuestionsInbox } from './QuestionsInbox.js';

const question = (overrides: Partial<QuestionView> = {}): QuestionView => ({
  projectId: 'kiamiya/site',
  issueNumber: 4,
  issueTitle: 'T04 — Agenda',
  issueUrl: 'https://github.com/kiamiya/site/issues/4',
  questionId: 'fuseau',
  source: 'task',
  blocking: true,
  text: 'Quel fuseau horaire ?',
  context: 'Le brief ne le précise pas.',
  options: ['Europe/Paris', 'UTC'],
  askedAt: '2026-11-06T10:00:00.000Z',
  answer: null,
  ...overrides,
});

type Invoke = (channel: string, input: unknown) => Promise<{ ok: true; data: unknown }>;
let invoke: ReturnType<typeof vi.fn<Invoke>>;

beforeEach(() => {
  invoke = vi.fn<Invoke>((channel) =>
    Promise.resolve({
      ok: true,
      data:
        channel === 'questions:list'
          ? [question({ blocking: false, questionId: 'nommage' }), question()]
          : channel === 'context:choose-files'
            ? { files: [{ token: 't1', name: 'fuseaux.pdf', size: 10 }], repositoryPrivate: false }
            : channel === 'context:import'
              ? {
                  committed: true,
                  commitSha: 'abc',
                  imported: [
                    { source: 'fuseaux.pdf', path: '.agentlake/context/fuseaux.md', role: 'annex' },
                  ],
                  skipped: [],
                  warnings: [],
                }
              : question({
                  answer: { text: 'UTC', decision: true, at: '2026-11-06T11:00:00.000Z' },
                }),
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

const now = new Date('2026-11-06T13:00:00.000Z');

describe('carte de question', () => {
  it('affiche tâche, bloquante, ancienneté, contexte et options', () => {
    wrap(<QuestionCard question={question()} showProject now={now} />);
    expect(screen.getByText('kiamiya/site')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://github.com/kiamiya/site/issues/4',
    );
    expect(screen.getByText('Bloquante')).toBeTruthy();
    expect(screen.getByText('il y a 3 h')).toBeTruthy();
    expect(screen.getByText('Le brief ne le précise pas.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Options proposées' }).textContent).toContain('UTC');
  });

  it('une option remplit la réponse ; décision cochée par défaut ; publication', async () => {
    wrap(<QuestionCard question={question()} showProject={false} />);
    const submit = screen.getByRole('button', { name: 'Répondre' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'UTC' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Réponse').value).toBe('UTC');
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: /Décision du projet/ }).checked,
    ).toBe(true);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('questions:answer', {
        projectId: 'kiamiya/site',
        issueNumber: 4,
        questionId: 'fuseau',
        text: 'UTC',
        decision: true,
        ignore: false,
        attachments: [],
      });
    });
  });

  it('texte libre, décision décochée, pièce jointe versée en annexe (dépôt public confirmé)', async () => {
    wrap(<QuestionCard question={question()} showProject={false} />);
    fireEvent.change(screen.getByLabelText('Réponse'), {
      target: { value: 'Voir le tableau joint.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Décision du projet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Joindre des fichiers' }));
    await screen.findByText(/fuseaux\.pdf/);
    const submit = screen.getByRole('button', { name: 'Répondre' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /peuvent être publiques/ }));
    fireEvent.click(submit);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'questions:answer',
        expect.objectContaining({
          text: 'Voir le tableau joint.',
          decision: false,
          attachments: ['.agentlake/context/fuseaux.md'],
        }),
      );
    });
    expect(invoke).toHaveBeenCalledWith('context:import', {
      projectId: 'kiamiya/site',
      files: [{ token: 't1', role: 'annex' }],
      acknowledgePublic: true,
    });
  });

  it('question du planificateur : peut être ignorée', async () => {
    wrap(<QuestionCard question={question({ source: 'cadrage' })} showProject={false} />);
    expect(screen.getByRole('link').textContent).toContain('Cadrage');
    fireEvent.click(screen.getByRole('button', { name: 'Ignorer la question' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'questions:answer',
        expect.objectContaining({ ignore: true }),
      );
    });
  });

  it('question répondue : réponse et date, sans formulaire', () => {
    wrap(
      <QuestionCard
        question={question({
          answer: { text: 'UTC', decision: true, at: '2026-11-06T12:30:00.000Z' },
        })}
        showProject={false}
        now={now}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Répondre' })).toBeNull();
    expect(screen.getByText(/Répondue il y a 30 min · décision du projet/)).toBeTruthy();
    expect(screen.getByText('UTC')).toBeTruthy();
  });
});

describe('boîte de questions', () => {
  it('bloquantes d’abord ; historique et recherche', async () => {
    wrap(<QuestionsInbox />);
    const cards = await screen.findAllByRole('article');
    expect(cards[0]?.getAttribute('aria-label')).toBe('Question fuseau');
    expect(cards[1]?.getAttribute('aria-label')).toBe('Question nommage');
    expect(invoke).toHaveBeenCalledWith('questions:list', { status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Historique' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('questions:list', { status: 'answered' });
    });
    fireEvent.change(screen.getByLabelText('Rechercher dans les questions'), {
      target: { value: ' agenda ' },
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('questions:list', {
        status: 'answered',
        search: 'agenda',
      });
    });
  });

  it('vue d’un projet : filtre par projet ; liste vide', async () => {
    invoke.mockImplementation(() => Promise.resolve({ ok: true, data: [] }));
    wrap(<QuestionsInbox projectId="kiamiya/site" />);
    expect(await screen.findByText('Aucune question en attente.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('questions:list', {
      projectId: 'kiamiya/site',
      status: 'pending',
    });
  });
});

describe('ancienneté', () => {
  it.each([
    ['2026-11-06T12:59:40.000Z', 'à l’instant'],
    ['2026-11-06T12:15:00.000Z', 'il y a 45 min'],
    ['2026-11-06T08:00:00.000Z', 'il y a 5 h'],
    ['2026-11-03T13:00:00.000Z', 'il y a 3 j'],
    ['pas une date', ''],
  ])('%s → %s', (iso, label) => {
    expect(formatAge(iso, now)).toBe(label);
  });
});
