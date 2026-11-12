import { FakeGitHub } from 'github';
import {
  parseQuestionComment,
  parseTaskIssueBody,
  renderTaskIssueBody,
  stateLabel,
  TASK_LABEL,
} from 'shared';
import { makeTask } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { delegate, DelegationRequestSchema, type DelegationRequest } from './delegate.js';

const ref = { owner: 'kiamiya', repo: 'site' };

const docs: DelegationRequest = DelegationRequestSchema.parse({
  profile: 'docs',
  title: 'Documenter l’API des créneaux',
  description: 'Page de doc des routes /slots.',
  kind: 'docs',
  acceptance_criteria: ['Chaque route est décrite avec un exemple.'],
  paths: ['docs/api/slots.md'],
});

async function setup(parentTask = makeTask({ id: 'T05', title: 'API des créneaux' })) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  const parent = await github.createIssue(ref, {
    title: parentTask.id,
    body: renderTaskIssueBody(parentTask),
    labels: [TASK_LABEL, stateLabel('running')],
  });
  return { github, parent: { issueNumber: parent.number, task: parentTask } };
}

const tasks = async (github: FakeGitHub) =>
  (await github.listIssues(ref, { labels: [TASK_LABEL], state: 'all' })).flatMap((i) => {
    const t = parseTaskIssueBody(i.body);
    return t.ok ? [{ number: i.number, task: t.value, labels: i.labels }] : [];
  });

describe('délégation entre agents', () => {
  it('sous-tâche créée (T500), dépend de la tâche mère, périmètre et origine ; pas de doublon', async () => {
    const { github, parent } = await setup();
    const result = await delegate(github, ref, parent, [docs]);
    expect(result).toEqual({
      created: [{ taskId: 'T500', issueNumber: 2, profile: 'docs' }],
      refused: [],
    });
    const created = (await tasks(github)).find((t) => t.task.id === 'T500');
    expect(created?.task).toMatchObject({
      profile: 'docs',
      kind: 'docs',
      dependencies: ['T05'],
      scope: { paths: ['docs/api/slots.md'] },
      delegation: { parent: 'T05', depth: 1 },
    });
    expect(created?.task.description).toContain('Déléguée par T05 (#1).');
    expect(created?.labels).toContain(stateLabel('queued'));
    expect(await github.getDependencies(ref, 2)).toEqual([1]);
    expect((await github.listComments(ref, 1))[0]?.body).toContain(
      '**Délégation** : T500 (#2, docs)',
    );
    // Tentative relancée : la même demande n'est pas recréée.
    expect((await delegate(github, ref, parent, [docs])).created).toEqual([]);
    expect(await tasks(github)).toHaveLength(2);
  });

  it('limites : 3 sous-tâches par tâche, 2 niveaux ; code sans test refusé ; Kia prévenu', async () => {
    const { github, parent } = await setup();
    const many = ['A', 'B', 'C', 'D'].map((n) => ({ ...docs, title: `Doc ${n}` }));
    const code = DelegationRequestSchema.parse({
      ...docs,
      profile: 'backend',
      kind: 'code',
      title: 'Route sans test',
    });
    const result = await delegate(github, ref, parent, [code, ...many]);
    expect(result.created.map((c) => c.taskId)).toEqual(['T500', 'T501', 'T502']);
    expect(result.refused).toEqual([
      { title: 'Route sans test', reason: 'une tâche de code doit exiger un test' },
      { title: 'Doc D', reason: '3 sous-tâches au plus par tâche' },
    ]);
    const question = parseQuestionComment((await github.listComments(ref, 1)).at(-1)?.body ?? '');
    expect(question.ok && question.value).toMatchObject({
      id: 'delegation-t05',
      blocking: false,
    });

    const deep = await setup(
      makeTask({ id: 'T600', title: 'Sous-sous', delegation: { parent: 'T500', depth: 2 } }),
    );
    expect((await delegate(deep.github, ref, deep.parent, [docs])).refused[0]?.reason).toContain(
      'profondeur de délégation dépassée',
    );
  });

  it('identifiants au-delà des tâches existantes et du plan', async () => {
    const { github, parent } = await setup(makeTask({ id: 'T510', title: 'Ad hoc' }));
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'plan',
      changes: [{ path: '.agentlake/plan.json', content: '{"tasks":[{"id":"T520"}]}' }],
    });
    expect((await delegate(github, ref, parent, [docs])).created[0]?.taskId).toBe('T521');
  });
});
