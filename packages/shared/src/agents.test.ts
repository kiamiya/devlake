import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNNER_CAP, maximumAntichain, proposeAgents } from './agents.js';

const task = (id: string, dependencies: string[] = [], exclusiveResources: string[] = []) => ({
  id,
  dependencies,
  exclusiveResources,
});
const caps = { runners: DEFAULT_RUNNER_CAP, global: 10 };

describe('nombre d’agents proposé', () => {
  it('graphe linéaire : un seul agent', () => {
    const tasks = [task('T00'), task('T01', ['T00']), task('T02', ['T01']), task('T03', ['T02'])];
    expect(proposeAgents(tasks, caps)).toMatchObject({ agents: 1, width: 1 });
  });

  it('graphe large : autant d’agents que de tâches indépendantes', () => {
    const tasks = [
      task('T00'),
      ...['T01', 'T02', 'T03', 'T04', 'T05'].map((id) => task(id, ['T00'])),
      task('T06', ['T01', 'T02']),
    ];
    const proposal = proposeAgents(tasks, caps);
    expect(proposal.width).toBe(5);
    expect(proposal.agents).toBe(5);
    expect(proposal.antichain).toHaveLength(5);
  });

  it('losange : la largeur suit les dépendances transitives', () => {
    // T00 → (T01, T02) → T03 → (T04, T05, T06)
    const tasks = [
      task('T00'),
      task('T01', ['T00']),
      task('T02', ['T00']),
      task('T03', ['T01', 'T02']),
      task('T04', ['T03']),
      task('T05', ['T03']),
      task('T06', ['T03']),
    ];
    expect(proposeAgents(tasks, caps).width).toBe(3);
  });

  it('ressources exclusives : les tâches qui se les partagent comptent pour une', () => {
    const tasks = [
      task('T00'),
      task('T01', ['T00'], ['editor-unity']),
      task('T02', ['T00'], ['editor-unity']),
      task('T03', ['T00'], ['migrations']),
      task('T04', ['T00'], ['migrations', 'editor-unity']),
      task('T05', ['T00']),
    ];
    // T01, T02, T03, T04 sont liées par leurs ressources ; T05 est libre.
    expect(proposeAgents(tasks, caps)).toMatchObject({ width: 2, agents: 2 });
  });

  it('applique les plafonds runners, global et projet, avec au moins un agent', () => {
    const wide = [
      task('T00'),
      ...Array.from({ length: 30 }, (_, i) => task(`T${String(i + 1).padStart(2, '0')}`, ['T00'])),
    ];
    expect(proposeAgents(wide, { runners: 20, global: 50 }).agents).toBe(20);
    expect(proposeAgents(wide, { runners: 20, global: 4 }).agents).toBe(4);
    expect(proposeAgents(wide, { runners: 20, global: 10, project: 2 }).agents).toBe(2);
    expect(proposeAgents([], caps)).toMatchObject({ agents: 1, width: 1, antichain: [] });
  });

  it('ignore les dépendances inconnues et trouve une antichaîne valide', () => {
    const tasks = [
      task('T00'),
      task('T01', ['T00', 'T99']),
      task('T02', ['T00']),
      task('T03', ['T01']),
    ];
    const antichain = maximumAntichain(tasks);
    expect(antichain).toHaveLength(2);
    // Aucune tâche de l'antichaîne ne dépend d'une autre.
    expect(antichain).not.toContain('T00');
    expect(antichain.includes('T01') && antichain.includes('T03')).toBe(false);
  });
});
