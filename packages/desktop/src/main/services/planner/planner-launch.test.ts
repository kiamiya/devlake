import { FakeGitHub } from 'github';
import { AvailableToolsSchema } from 'shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { createRepositories } from '../../db/repositories.js';
import { PlannerLaunchService } from './planner-launch.js';

const ref = { owner: 'kiamiya', repo: 'jeu' };

async function setup(type: string) {
  const github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  await github.commitFiles(ref, {
    branch: 'main',
    message: 'p',
    changes: [
      {
        path: '.agentlake/project.yml',
        content: `type: ${type}\nqualityProfile: ${type === 'web' ? 'web' : type}\nlimits:\n  maxAttempts: 3\nprofiles: [architect]\nexclusiveResources: []\nbridgeRequired: true\n`,
      },
    ],
  });
  const repos = createRepositories(openDatabase(':memory:').db);
  repos.projects.upsert('kiamiya', 'jeu', '2026-11-12T08:00:00.000Z');
  repos.settings.update({
    plannerModel: 'modele',
    auraBridge: {
      unity: { port: 8765, allowedTools: ['unitymcp__manage_scene', 'unitymcp__read_console'] },
      unreal: { port: 8766, allowedTools: [] },
      blender: { port: 8767, allowedTools: ['blender__get_scene_info'] },
    },
  });
  return { github, repos, service: new PlannerLaunchService(repos, () => Promise.resolve(github)) };
}

describe('lancement du planificateur', () => {
  it('projet de jeu : outils autorisés publiés une fois (pas de commit s’ils sont inchangés)', async () => {
    const { github, service } = await setup('unity');
    await service.start({ projectId: 'kiamiya/jeu', mode: 'auto' });
    const tools = AvailableToolsSchema.parse(
      JSON.parse((await github.getFile(ref, '.agentlake/tools.json'))?.content ?? ''),
    );
    expect(tools.editors).toEqual({
      unity: ['unitymcp__manage_scene', 'unitymcp__read_console'],
      blender: ['blender__get_scene_info'],
    });
    const commits = github.state(ref).commits.size;
    await service.start({ projectId: 'kiamiya/jeu', mode: 'regenerate', instruction: 'x' });
    expect(github.state(ref).commits.size).toBe(commits);
    expect(github.state(ref).dispatches).toHaveLength(2);
  });

  it('projet web : rien de publié', async () => {
    const { github, service } = await setup('web');
    await service.start({ projectId: 'kiamiya/jeu', mode: 'auto' });
    expect(await github.getFile(ref, '.agentlake/tools.json')).toBeNull();
  });
});
