// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../../../shared/ipc-contract.js';
import { HOME } from './model.js';
import { useTabShortcuts } from './shortcuts.js';
import { tabsStore } from './store.js';
import { ActivityIndicator, QuestionsBadge, TabBar } from './TabBar.js';

const project = (repo: string, pendingQuestions: number, activeAgents: number): ProjectSummary => ({
  id: `kiamiya/${repo}`,
  owner: 'kiamiya',
  repo,
  lastSyncedAt: null,
  pendingQuestions,
  activeAgents,
});

function Shortcuts() {
  useTabShortcuts(tabsStore);
  return null;
}

beforeEach(() => {
  tabsStore.setState({ tabs: [], active: HOME, settingsOpen: false, hydrated: true, sections: {} });
});
afterEach(() => {
  cleanup();
});

describe('badges', () => {
  it('affiche le nombre de questions et rien à zéro', () => {
    const { container, rerender } = render(<QuestionsBadge count={0} />);
    expect(container.innerHTML).toBe('');
    rerender(<QuestionsBadge count={2} />);
    expect(screen.getByLabelText('2 questions en attente').textContent).toBe('2');
    rerender(<QuestionsBadge count={1} />);
    expect(screen.getByLabelText('1 question en attente')).toBeTruthy();
  });

  it('signale l’activité des agents', () => {
    const { container, rerender } = render(<ActivityIndicator active={0} />);
    expect(container.innerHTML).toBe('');
    rerender(<ActivityIndicator active={3} />);
    expect(screen.getByLabelText('3 agents actifs')).toBeTruthy();
  });
});

describe('barre d’onglets', () => {
  it('affiche Accueil puis les projets avec badges, active et ferme', () => {
    tabsStore.getState().open('kiamiya/jeu');
    tabsStore.getState().open('kiamiya/site');
    render(<TabBar projects={[project('jeu', 2, 1), project('site', 0, 0)]} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Accueil', 'jeu2', 'site']);
    expect(screen.getByRole('tab', { name: /site/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('2 questions en attente')).toBeTruthy();
    expect(screen.getByLabelText('1 agent actif')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /jeu/ }));
    expect(tabsStore.getState().active).toBe('kiamiya/jeu');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer jeu' }));
    expect(tabsStore.getState().tabs).toEqual(['kiamiya/site']);
  });

  it('ouvre les réglages avec l’engrenage', () => {
    render(<TabBar projects={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Réglages' }));
    expect(tabsStore.getState().settingsOpen).toBe(true);
    expect(screen.getByRole('tab', { name: 'Accueil' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('réordonne par glisser-déposer', () => {
    for (const repo of ['jeu', 'site', 'outil']) tabsStore.getState().open(`kiamiya/${repo}`);
    render(<TabBar projects={[]} />);
    fireEvent.dragStart(screen.getByTestId('tab-kiamiya/outil'));
    fireEvent.dragOver(screen.getByTestId('tab-kiamiya/jeu'));
    fireEvent.drop(screen.getByTestId('tab-kiamiya/jeu'));
    expect(tabsStore.getState().tabs).toEqual(['kiamiya/outil', 'kiamiya/jeu', 'kiamiya/site']);
  });

  it('répond aux raccourcis clavier de la fenêtre', () => {
    for (const repo of ['jeu', 'site']) tabsStore.getState().open(`kiamiya/${repo}`);
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(tabsStore.getState().active).toBe(HOME);
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(tabsStore.getState().active).toBe('kiamiya/jeu');
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(tabsStore.getState().tabs).toEqual(['kiamiya/site']);
    fireEvent.keyDown(window, { key: 'x' });
    expect(tabsStore.getState().active).toBe('kiamiya/site');
  });
});
