import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlanTaskSchema } from './plan.js';
import { parseTaskIssueBody, renderTaskIssueBody, renderTaskIssueTitle } from './task-issue.js';
import { makeBootstrapTask, makeTask } from './test-utils.js';
import { taskArb } from './testing/arbitraries.js';

describe('TaskIssue', () => {
  it('produit des tâches valides pour les tests de propriétés', () => {
    fc.assert(fc.property(taskArb, (task) => PlanTaskSchema.safeParse(task).success));
  });

  it('aller-retour rendu → parsing sans perte', () => {
    fc.assert(
      fc.property(taskArb, (task) => {
        expect(parseTaskIssueBody(renderTaskIssueBody(task))).toEqual({ ok: true, value: task });
      }),
      { numRuns: 300 },
    );
  });

  it('relit un corps passé en fins de ligne CRLF par GitHub', () => {
    const task = makeTask({ description: 'Ligne 1\nLigne 2' });
    const crlf = renderTaskIssueBody(task).replace(/\n/g, '\r\n');
    expect(parseTaskIssueBody(crlf)).toEqual({ ok: true, value: task });
  });

  it('ne laisse aucun « --> » parasite dans le bloc caché', () => {
    const task = makeTask({ description: 'Fin de commentaire --> <script>' });
    const firstLine = renderTaskIssueBody(task).split('\n')[0] ?? '';
    expect(firstLine.indexOf('-->')).toBe(firstLine.length - 3);
  });

  it('refuse un corps sans bloc, avec un JSON cassé ou une tâche invalide', () => {
    expect(parseTaskIssueBody('## Objectif\n\nRien')).toEqual({
      ok: false,
      error: 'Bloc « <!-- agentlake:task … --> » absent en tête de l’issue.',
    });
    expect(parseTaskIssueBody('<!-- agentlake:task {pas du json} -->')).toEqual({
      ok: false,
      error: 'Le bloc « agentlake:task » ne contient pas un JSON valide.',
    });
    const invalid = parseTaskIssueBody('<!-- agentlake:task {"id":"X"} -->');
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toContain(
      'id : Identifiant de tâche attendu au format Txx',
    );
  });

  it('ignore un bloc qui n’est pas en tête du corps', () => {
    const body = `Texte\n${renderTaskIssueBody(makeTask())}`;
    expect(parseTaskIssueBody(body).ok).toBe(false);
  });

  it('titre de l’issue', () => {
    expect(renderTaskIssueTitle(makeTask())).toBe('T01 — Écran de connexion');
  });

  it('rendu Markdown d’une tâche complète (régression)', () => {
    expect(
      renderTaskIssueBody(
        makeTask({ epic: 'E1', milestone: 'J1', exclusiveResources: ['migrations'] }),
      ),
    ).toMatchSnapshot();
  });

  it('rendu Markdown d’une tâche minimale (régression)', () => {
    expect(
      renderTaskIssueBody(
        makeBootstrapTask({
          kind: 'docs',
          requiredTests: {},
          codeZones: [],
          exclusiveResources: [],
        }),
      ),
    ).toMatchSnapshot();
  });
});
