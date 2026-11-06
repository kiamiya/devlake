// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { proposeAgents, type PlanTask } from 'shared';
import { makePlan } from 'shared/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanTree } from './PlanTree.js';
import { depths, PROFILE_COLORS } from './profiles.js';
import { TaskEditor } from './TaskEditor.js';
import { TeamPanel } from './TeamPanel.js';

afterEach(() => {
  cleanup();
});

const plan = makePlan();

describe('arborescence', () => {
  it('regroupe par épopée, colore par profil et signale les dépendances', () => {
    const onSelect = vi.fn();
    render(<PlanTree plan={plan} selected="T01" onSelect={onSelect} />);
    expect(screen.getByText('E1 — Authentification')).toBeTruthy();
    expect(screen.getByText('Sans épopée')).toBeTruthy();
    const t01 = screen.getByRole('button', { name: /T01/ });
    expect(t01.getAttribute('aria-pressed')).toBe('true');
    expect(t01.textContent).toContain('après T00');
    expect(t01.style.borderLeftColor).not.toBe('');
    fireEvent.click(screen.getByRole('button', { name: /T02/ }));
    expect(onSelect).toHaveBeenCalledWith('T02');
  });

  it('calcule la profondeur de chaque tâche, cycles compris', () => {
    expect(
      depths([
        { id: 'T00', dependencies: [] },
        { id: 'T01', dependencies: ['T00'] },
        { id: 'T02', dependencies: ['T01', 'T00', 'T99'] },
      ]),
    ).toEqual(
      new Map([
        ['T00', 0],
        ['T01', 1],
        ['T02', 2],
      ]),
    );
    const cyclic = depths([
      { id: 'A', dependencies: ['B'] },
      { id: 'B', dependencies: ['A'] },
    ]);
    expect(cyclic.size).toBe(2);
    expect(Object.keys(PROFILE_COLORS)).toHaveLength(12);
  });
});

describe('éditeur de tâche', () => {
  function editor(task: PlanTask = plan.tasks[1] as PlanTask) {
    const onChange = vi.fn();
    render(<TaskEditor task={task} allTasks={plan.tasks} onChange={onChange} />);
    return onChange;
  }

  it('modifie titre, profil et dépendances', () => {
    const onChange = editor();
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Connexion par lien' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Connexion par lien' }),
    );
    fireEvent.change(screen.getByLabelText('Profil'), { target: { value: 'backend' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'backend' }));
    fireEvent.click(screen.getByLabelText(/T02 — README/));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ dependencies: ['T00', 'T02'] }),
    );
    fireEvent.click(screen.getByLabelText(/T00 — Bootstrap/));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dependencies: [] }));
  });

  it('garde les lignes en cours de frappe et transmet la liste nettoyée', () => {
    const onChange = editor();
    const criteria = screen.getByLabelText<HTMLTextAreaElement>(
      'Critères d’acceptation (un par ligne)',
    );
    fireEvent.change(criteria, { target: { value: 'Premier\n' } });
    expect(criteria.value).toBe('Premier\n');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptanceCriteria: ['Premier'] }),
    );

    fireEvent.change(screen.getByLabelText('Intégration'), { target: { value: ' API auth \n\n' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requiredTests: {
          unit: ['Validation du formulaire'],
          integration: ['API auth'],
          e2e: ['Parcours de connexion complet'],
        },
      }),
    );
    fireEvent.change(screen.getByLabelText('Unitaires'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ requiredTests: { e2e: ['Parcours de connexion complet'] } }),
    );
  });
});

describe('panneau Équipe', () => {
  const proposal = proposeAgents(plan.tasks, { runners: 20, global: 3 });

  it('affiche profils, agents proposés et détail du calcul', () => {
    render(
      <TeamPanel
        plan={plan}
        proposal={proposal}
        caps={{ runners: 20, global: 3, project: null }}
        onCap={vi.fn()}
        saving={false}
      />,
    );
    expect(screen.getByTestId('agents-proposed').textContent).toBe(String(proposal.agents));
    expect(screen.getByText('Interface web.')).toBeTruthy();
    expect(screen.getByText('aucun')).toBeTruthy();
    expect(screen.getByText(/N = min\(L_DAG/).textContent).toContain(proposal.antichain.join(', '));
  });

  it('enregistre le plafond projet, ou le retire, et refuse un plafond invalide', () => {
    const onCap = vi.fn();
    render(
      <TeamPanel
        plan={plan}
        proposal={proposal}
        caps={{ runners: 20, global: 3, project: 2 }}
        onCap={onCap}
        saving={false}
      />,
    );
    const input = screen.getByLabelText('Plafond d’agents du projet');
    const submit = screen.getByRole('button', { name: 'Enregistrer le plafond' });
    fireEvent.change(input, { target: { value: '0' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(submit);
    expect(onCap).toHaveBeenLastCalledWith(4);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(submit);
    expect(onCap).toHaveBeenLastCalledWith(null);
  });
});
