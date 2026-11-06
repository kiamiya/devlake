import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHub } from 'github';
import { CONTEXT_INDEX_PATH, parseProjectPlan } from 'shared';
import { makeProjectConfig } from 'shared/test-utils';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ClaudeCliPort } from './claude/cli-port.js';
import { PLAN_PATH, PROJECT_CONFIG_PATH, runPlanner } from './planner.js';
import { loadPrompts } from './prompts.js';

/**
 * @live (jamais en CI) : le vrai planificateur, avec le vrai Claude, sur les briefs de
 * référence de la bibliothèque de régression. Un LLM ne rend jamais deux fois le même plan :
 * contrôles structurels seulement (plan valide, taille, profils), jamais à l'identique.
 *
 * CLAUDE_CODE_OAUTH_TOKEN=… AGENTLAKE_LIVE_MODEL=<modèle> npm run test:live
 */
const LIBRARY = fileURLToPath(new URL('../../../tests/fixtures/regression/', import.meta.url));
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const model = process.env.AGENTLAKE_LIVE_MODEL;
const enabled = Boolean(token && model);

/** Ce que le contrôle structurel lit d'un scénario. */
const ScenarioSchema = z.object({
  name: z.string(),
  brief: z.string(),
  plan: z.object({
    tasks: z.array(z.object({ id: z.string(), profile: z.string() })),
    profiles: z.array(z.object({ profile: z.string() })),
  }),
});

const scenarios = readdirSync(join(LIBRARY, 'scenarios'))
  .filter((f) => f.endsWith('.json'))
  .map((f) =>
    ScenarioSchema.parse(JSON.parse(readFileSync(join(LIBRARY, 'scenarios', f), 'utf8'))),
  );

describe.skipIf(!enabled)('@live planificateur — briefs de référence', () => {
  it.each(scenarios)(
    '$name : plan valide, de taille et de profils plausibles',
    async (scenario) => {
      const ref = { owner: 'kiamiya', repo: `live-${scenario.name}` };
      const github = new FakeGitHub({ actor: 'kiamiya' });
      github.seedRepository(ref);
      const brief = readFileSync(join(LIBRARY, scenario.brief), 'utf8');
      const briefPath = '.agentlake/context/brief.md';
      const index = {
        version: 1,
        files: [
          {
            path: briefPath,
            role: 'brief',
            source: 'brief.docx',
            sha256: createHash('sha256').update(brief).digest('hex'),
            size: brief.length,
            importedAt: new Date().toISOString(),
          },
        ],
      };
      const files: Record<string, string> = {
        [PROJECT_CONFIG_PATH]: stringify(makeProjectConfig({ type: 'web', qualityProfile: 'web' })),
        [CONTEXT_INDEX_PATH]: JSON.stringify(index, null, 2),
        [briefPath]: brief,
      };
      await github.commitFiles(ref, {
        branch: 'main',
        message: 'contexte',
        changes: Object.entries(files).map(([path, content]) => ({ path, content })),
      });
      // Copie de travail où Claude lit les documents.
      const workspace = mkdtempSync(join(tmpdir(), 'agentlake-live-planner-'));
      try {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(join(workspace, path, '..'), { recursive: true });
          writeFileSync(join(workspace, path), content);
        }
        const outcome = await runPlanner(
          { ref, mode: 'regenerate', model: model ?? '', maxAgents: 3 },
          {
            github,
            claude: new ClaudeCliPort({ oauthToken: token ?? '' }),
            prompts: await loadPrompts(),
            readFile: async (path) => (await github.getFile(ref, path, 'main'))?.content ?? null,
            workspace,
          },
        );
        expect(outcome.phase).toBe('plan');
        if (outcome.phase !== 'plan') return;
        const file = await github.getFile(ref, PLAN_PATH, outcome.branch);
        const plan = parseProjectPlan(JSON.parse(file?.content ?? '{}'));
        expect(plan.ok ? null : plan.error).toBeNull();
        if (!plan.ok) return;

        const expected = scenario.plan.tasks.length;
        expect(plan.value.tasks.length).toBeGreaterThanOrEqual(Math.ceil(expected / 2));
        expect(plan.value.tasks.length).toBeLessThanOrEqual(expected * 3);
        // Profils : au moins un des profils métier attendus (hors architecte) est retenu.
        const retained = new Set(plan.value.profiles.map((p) => p.profile));
        const expectedProfiles = scenario.plan.profiles
          .map((p) => p.profile)
          .filter((p) => p !== 'architect');
        expect(expectedProfiles.some((p) => retained.has(p as never))).toBe(true);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    30 * 60_000,
  );
});
