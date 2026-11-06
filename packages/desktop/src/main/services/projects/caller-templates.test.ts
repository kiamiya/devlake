import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadAgentProfile, PROFILE_IDS } from 'shared';
import { CALLER_TEMPLATES, PROFILE_TEMPLATES } from './caller-templates.js';
import { DEVLAKE_REPOSITORY, renderCallers } from './files.js';

describe('gabarits réels templates/caller', () => {
  const files = renderCallers(CALLER_TEMPLATES, { repository: DEVLAKE_REPOSITORY, ref: 'v1' });

  it('contient les quatre workflows d’appel', () => {
    expect([...files.keys()]).toEqual([
      '.github/workflows/agentlake-agent-task.yml',
      '.github/workflows/agentlake-dispatcher.yml',
      '.github/workflows/agentlake-planner.yml',
      '.github/workflows/agentlake-review.yml',
    ]);
  });

  it.each([...files.entries()])(
    '%s : YAML valide, permissions minimales, workflow épinglé',
    (_path, content) => {
      const workflow = parse(content) as {
        permissions: unknown;
        jobs: Record<
          string,
          { uses: string; permissions: Record<string, string>; secrets: string }
        >;
      };
      expect(workflow.permissions).toEqual({});
      for (const job of Object.values(workflow.jobs)) {
        expect(job.uses).toMatch(/^kiamiya\/devlake\/\.github\/workflows\/[a-z-]+\.yml@v1$/);
        expect(job.permissions).toBeTypeOf('object');
        expect(job.secrets).toBe('inherit');
      }
      expect(content).not.toContain('pull_request_target');
    },
  );

  it('le dispatcher écoute les événements du cycle de vie, filtrés par le script lui-même', () => {
    const workflow = parse(files.get('.github/workflows/agentlake-dispatcher.yml') ?? '') as {
      on: Record<string, unknown>;
      concurrency?: unknown;
      jobs: { dispatch: { if?: string; with: Record<string, string> } };
    };
    expect(Object.keys(workflow.on)).toEqual([
      'schedule',
      'issues',
      'issue_comment',
      'pull_request',
      'check_suite',
      'workflow_run',
      'workflow_dispatch',
    ]);
    expect(workflow.on.schedule).toEqual([{ cron: '*/10 * * * *' }]);
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['AgentLake — agent'],
      types: ['completed'],
    });
    // Filtre d'auteur dans le script, avec une trace : pas de `if` qui sauterait le job en silence.
    expect(workflow.jobs.dispatch.if).toBeUndefined();
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.dispatch.with).toEqual({ devlake_ref: 'v1' });
  });

  it('l’agent porte un titre de run qui le relie à son issue et sa tentative', () => {
    const content = files.get('.github/workflows/agentlake-agent-task.yml') ?? '';
    expect((parse(content) as { 'run-name': string })['run-name']).toBe(
      'AgentLake — agent, issue #${{ inputs.issue_number }}, tentative ${{ inputs.attempt }}',
    );
  });
});

describe('gabarit d’appel de l’agent', () => {
  const content =
    renderCallers(CALLER_TEMPLATES, { repository: DEVLAKE_REPOSITORY, ref: 'v1' }).get(
      '.github/workflows/agentlake-agent-task.yml',
    ) ?? '';
  const workflow = parse(content) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    concurrency?: unknown;
    jobs: { agent: { with: Record<string, string>; permissions: Record<string, string> } };
  };

  it('transmet issue, profil, tentative, raison et version de devlake', () => {
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      'issue_number',
      'profile',
      'attempt',
      'resume_reason',
      'needs_editor',
      'editor',
    ]);
    expect(workflow.jobs.agent.with).toEqual({
      issue_number: '${{ inputs.issue_number }}',
      profile: '${{ inputs.profile }}',
      attempt: '${{ inputs.attempt }}',
      resume_reason: '${{ inputs.resume_reason }}',
      needs_editor: '${{ inputs.needs_editor }}',
      editor: '${{ inputs.editor }}',
      devlake_ref: 'v1',
    });
  });

  it('accorde le jeton OIDC de l’app Claude et n’ajoute pas de concurrence en double', () => {
    expect(workflow.jobs.agent.permissions['id-token']).toBe('write');
    expect(workflow.concurrency).toBeUndefined();
  });
});

describe('gabarit d’appel du planificateur', () => {
  const content =
    renderCallers(CALLER_TEMPLATES, { repository: DEVLAKE_REPOSITORY, ref: 'v1' }).get(
      '.github/workflows/agentlake-planner.yml',
    ) ?? '';
  const workflow = parse(content) as {
    on: Record<string, unknown>;
    concurrency?: unknown;
    jobs: { plan: { if: string; with: Record<string, string> } };
  };

  it('se lance depuis le cockpit ou sur une réponse dans l’issue Cadrage, par le propriétaire seulement', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'issue_comment']);
    expect(workflow.jobs.plan.if).toContain('github.event.sender.login == github.repository_owner');
    expect(workflow.jobs.plan.if).toContain(
      "contains(github.event.issue.labels.*.name, 'agentlake:cadrage')",
    );
    expect(workflow.concurrency).toBeUndefined();
  });

  it('transmet mode, modèle, plafond, consigne et version de devlake', () => {
    expect(Object.keys(workflow.jobs.plan.with)).toEqual([
      'mode',
      'model',
      'max_agents',
      'instruction',
      'devlake_ref',
    ]);
    expect(workflow.jobs.plan.with.devlake_ref).toBe('v1');
  });
});

describe('profils par défaut intégrés au cockpit', () => {
  it('embarque les onze profils, valides, copiés tels quels au bootstrap', () => {
    expect(Object.keys(PROFILE_TEMPLATES).sort()).toEqual(
      PROFILE_IDS.map((id) => `${id}.yml`).sort(),
    );
    for (const id of PROFILE_IDS) {
      const loaded = loadAgentProfile(PROFILE_TEMPLATES[`${id}.yml`] ?? '', id);
      expect(loaded.ok ? 'valide' : loaded.error).toBe('valide');
    }
  });
});
