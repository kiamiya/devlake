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
