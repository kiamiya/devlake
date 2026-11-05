import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CALLER_TEMPLATES } from './caller-templates.js';
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

  it('le dispatcher ignore les événements d’un autre auteur que le propriétaire', () => {
    expect(files.get('.github/workflows/agentlake-dispatcher.yml')).toContain(
      "github.event_name == 'schedule' || github.event.sender.login == github.repository_owner",
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
    ]);
    expect(workflow.jobs.agent.with).toEqual({
      issue_number: '${{ inputs.issue_number }}',
      profile: '${{ inputs.profile }}',
      attempt: '${{ inputs.attempt }}',
      resume_reason: '${{ inputs.resume_reason }}',
      devlake_ref: 'v1',
    });
  });

  it('accorde le jeton OIDC de l’app Claude et n’ajoute pas de concurrence en double', () => {
    expect(workflow.jobs.agent.permissions['id-token']).toBe('write');
    expect(workflow.concurrency).toBeUndefined();
  });
});
