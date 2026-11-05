import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciChecksFor, QUALITY_PROFILES, type QualityProfile } from 'shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Gabarits qualité copiés par la tâche bootstrap (templates/quality). */
const DIR = fileURLToPath(new URL('../../../../templates/quality/', import.meta.url));

interface Workflow {
  on: { push?: { branches: string[] }; pull_request?: unknown };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      name: string;
      permissions?: Record<string, string>;
      'continue-on-error'?: unknown;
      steps: { uses?: string; run?: string }[];
    }
  >;
}

const read = (profile: QualityProfile) => readFileSync(join(DIR, profile, 'ci.yml'), 'utf8');

describe('gabarits qualité', () => {
  it('un dossier par profil qualité, avec ci.yml et README.md', () => {
    expect(readdirSync(DIR).sort()).toEqual([...QUALITY_PROFILES].sort());
    for (const profile of QUALITY_PROFILES)
      expect(readdirSync(join(DIR, profile)).sort()).toEqual(['README.md', 'ci.yml']);
  });

  it.each(QUALITY_PROFILES)(
    '%s : un job par check obligatoire de la CI, et rien de plus',
    (profile) => {
      const workflow = parse(read(profile)) as Workflow;
      const names = Object.entries(workflow.jobs).map(([id, job]) => {
        // Le nom affiché est le nom du check : identique à l'identifiant du job.
        expect(job.name).toBe(id);
        return id;
      });
      expect(names.sort()).toEqual(ciChecksFor(profile).sort());
    },
  );

  it.each(QUALITY_PROFILES)(
    '%s : déclencheurs, permissions minimales, actions épinglées, rien de non bloquant',
    (profile) => {
      const text = read(profile);
      const workflow = parse(text) as Workflow;
      expect(workflow.on.push?.branches).toEqual(['main']);
      expect(workflow.on).toHaveProperty('pull_request');
      expect(workflow.permissions).toEqual({ contents: 'read' });
      for (const job of Object.values(workflow.jobs)) {
        expect(job['continue-on-error']).toBeUndefined();
        for (const step of job.steps)
          if (step.uses !== undefined) expect(step.uses).toMatch(/@v\d+$/);
      }
      expect(workflow.jobs.codeql?.permissions).toEqual({
        contents: 'read',
        'security-events': 'write',
      });
      expect(text).not.toContain('pull_request_target');
      expect(text).toMatchSnapshot();
    },
  );
});
