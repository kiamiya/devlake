import { describe, expect, it } from 'vitest';
import {
  countRequiredTests,
  findDependencyCycle,
  needsEditor,
  parseProjectPlan,
  type ProjectPlan,
} from './plan.js';
import { makeBootstrapTask, makePlan, makeTask } from './test-utils.js';

function errorOf(plan: unknown): string {
  const result = parseProjectPlan(plan);
  if (result.ok) throw new Error('Le plan aurait dû être refusé.');
  return result.error;
}

describe('ProjectPlan — plans valides', () => {
  const valid: [string, ProjectPlan][] = [
    ['plan de référence', makePlan()],
    ['bootstrap seul', makePlan({ tasks: [makeBootstrapTask()], epics: [], milestones: [] })],
    [
      'tâche docs sans test',
      makePlan({
        tasks: [
          makeBootstrapTask(),
          makeTask({ kind: 'docs', profile: 'docs', requiredTests: {} }),
        ],
        profiles: [
          { profile: 'architect', justification: 'Bootstrap.' },
          { profile: 'docs', justification: 'Docs.' },
        ],
      }),
    ],
    [
      'losange de dépendances',
      makePlan({
        tasks: [
          makeBootstrapTask(),
          makeTask({ id: 'T01', dependencies: ['T00'] }),
          makeTask({ id: 'T02', dependencies: ['T00'] }),
          makeTask({ id: 'T03', dependencies: ['T01', 'T02'] }),
        ],
        epics: [],
        milestones: [],
        profiles: [
          { profile: 'architect', justification: 'Bootstrap.' },
          { profile: 'frontend', justification: 'UI.' },
        ],
      }),
    ],
    ['identifiant à trois chiffres', makePlan({ tasks: [makeBootstrapTask({ id: 'T100' })] })],
    ['sans hypothèse', makePlan({ assumptions: [] })],
  ];

  it.each(valid)('accepte : %s', (_name, plan) => {
    expect(parseProjectPlan(plan)).toEqual({ ok: true, value: plan });
  });
});

describe('ProjectPlan — plans invalides', () => {
  const base = makePlan();
  const [bootstrap, login, readme] = base.tasks as [
    ProjectPlan['tasks'][number],
    ProjectPlan['tasks'][number],
    ProjectPlan['tasks'][number],
  ];

  const invalid: [string, unknown, string][] = [
    [
      'needsEditor non booléen',
      { ...base, tasks: [bootstrap, { ...login, profile: 'unity', needsEditor: 'non' }, readme] },
      'needsEditor doit valoir true ou false.',
    ],
    [
      'cycle',
      {
        ...base,
        tasks: [
          bootstrap,
          { ...login, dependencies: ['T02'] },
          { ...readme, dependencies: ['T01'] },
        ],
      },
      'Dépendances circulaires : T01 → T02 → T01.',
    ],
    [
      'dépendance inconnue',
      { ...base, tasks: [bootstrap, { ...login, dependencies: ['T42'] }, readme] },
      'tasks.1.dependencies.0 : La tâche T01 dépend de T42, qui n’existe pas dans le plan.',
    ],
    [
      'dépendance à soi-même',
      { ...base, tasks: [bootstrap, { ...login, dependencies: ['T01'] }, readme] },
      'La tâche T01 dépend d’elle-même.',
    ],
    [
      'tâche de code sans test',
      { ...base, tasks: [bootstrap, { ...login, requiredTests: { unit: [] } }, readme] },
      'tasks.1.requiredTests : La tâche de code T01 n’exige aucun test.',
    ],
    [
      'identifiants en double',
      { ...base, tasks: [bootstrap, login, { ...readme, id: 'T01' }] },
      'La tâche T01 est définie deux fois.',
    ],
    [
      'première tâche non architecte',
      { ...base, tasks: [{ ...bootstrap, profile: 'frontend' }, login, readme] },
      'La première tâche doit être le bootstrap : profil architect, sans dépendance.',
    ],
    [
      'bootstrap avec dépendance',
      { ...base, tasks: [{ ...bootstrap, dependencies: ['T01'] }, login, readme] },
      'La première tâche doit être le bootstrap : profil architect, sans dépendance.',
    ],
    [
      'identifiant mal formé',
      { ...base, tasks: [bootstrap, { ...login, id: 'tache-1' }, readme] },
      'tasks.1.id : Identifiant de tâche attendu au format Txx (ex. T07).',
    ],
    [
      'profil inconnu',
      { ...base, tasks: [bootstrap, { ...login, profile: 'designer' }, readme] },
      'tasks.1.profile : Profil inconnu.',
    ],
    [
      'profil non retenu',
      { ...base, tasks: [bootstrap, { ...login, profile: 'backend' }, readme] },
      'La tâche T01 utilise le profil backend, qui n’est pas retenu dans le plan.',
    ],
    [
      'épopée inconnue',
      { ...base, tasks: [bootstrap, { ...login, epic: 'E9' }, readme] },
      'La tâche T01 renvoie à l’épopée inconnue E9.',
    ],
    [
      'jalon inconnu',
      { ...base, tasks: [bootstrap, { ...login, milestone: 'J9' }, readme] },
      'La tâche T01 renvoie au jalon inconnu J9.',
    ],
    ['aucune tâche', { ...base, tasks: [] }, 'Le plan doit contenir au moins une tâche.'],
    [
      'sans critère d’acceptation',
      { ...base, tasks: [bootstrap, { ...login, acceptanceCriteria: [] }, readme] },
      'Une tâche doit avoir au moins un critère d’acceptation.',
    ],
    [
      'complexité invalide',
      { ...base, tasks: [bootstrap, { ...login, complexity: 'XL' }, readme] },
      'Complexité attendue : S, M ou L.',
    ],
    [
      'épopée en double',
      { ...base, epics: [...base.epics, { id: 'E1', title: 'Encore' }] },
      'L’épopée E1 est définie deux fois.',
    ],
    [
      'jalon en double',
      { ...base, milestones: [...base.milestones, { id: 'J1', title: 'Encore' }] },
      'Le jalon J1 est défini deux fois.',
    ],
    ['zéro agent', { ...base, proposedAgents: 0 }, 'Le plan doit proposer au moins un agent.'],
    [
      'profil retenu deux fois',
      { ...base, profiles: [...base.profiles, { profile: 'docs', justification: 'Encore.' }] },
      'Le profil docs est retenu deux fois.',
    ],
    ['résumé vide', { ...base, summary: '   ' }, 'summary : Le résumé ne peut pas être vide.'],
    [
      'titre sur deux lignes',
      { ...base, tasks: [bootstrap, { ...login, title: 'Ligne 1\nLigne 2' }, readme] },
      'Le titre doit tenir sur une ligne.',
    ],
    [
      'marqueur caché dans la description',
      {
        ...base,
        tasks: [bootstrap, { ...login, description: 'x <!-- agentlake:task {} -->' }, readme],
      },
      'La description ne doit pas contenir « <!-- agentlake: ».',
    ],
    ['pas un objet', 'plan', 'objet attendu'],
  ];

  it.each(invalid)('refuse : %s', (_name, plan, message) => {
    expect(errorOf(plan)).toContain(message);
  });
});

describe('outils du plan', () => {
  it('besoin d’éditeur : profils de jeu, sauf code pur marqué needsEditor false', () => {
    expect(needsEditor({ profile: 'unity' })).toBe(true);
    expect(needsEditor({ profile: 'unreal', needsEditor: true })).toBe(true);
    expect(needsEditor({ profile: 'unity', needsEditor: false })).toBe(false);
    expect(needsEditor({ profile: 'backend' })).toBe(false);
    expect(needsEditor({ profile: 'backend', needsEditor: true })).toBe(false);
  });

  it('compte les tests exigés toutes catégories confondues', () => {
    expect(countRequiredTests({ unit: ['a', 'b'], e2e: ['c'] })).toBe(3);
    expect(countRequiredTests({})).toBe(0);
  });

  it('ne trouve pas de cycle dans un graphe acyclique et ignore les dépendances inconnues', () => {
    expect(
      findDependencyCycle([
        { id: 'T00', dependencies: [] },
        { id: 'T01', dependencies: ['T00', 'T99'] },
      ]),
    ).toBeUndefined();
  });

  it('trouve un cycle long', () => {
    expect(
      findDependencyCycle([
        { id: 'T00', dependencies: ['T02'] },
        { id: 'T01', dependencies: ['T00'] },
        { id: 'T02', dependencies: ['T01'] },
      ]),
    ).toEqual(['T00', 'T02', 'T01', 'T00']);
  });
});
