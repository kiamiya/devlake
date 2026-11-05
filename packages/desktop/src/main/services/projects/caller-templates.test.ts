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
