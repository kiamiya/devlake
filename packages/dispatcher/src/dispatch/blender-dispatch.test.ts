import { FakeGitHub } from 'github';
import { renderTaskIssueBody, stateLabel, TASK_LABEL } from 'shared';
import { makeProjectConfig, makeTask } from 'shared/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { seedGreenMain } from '../testing/checks.js';
import { PROJECT_CONFIG, runDispatch, type DispatcherDeps } from './dispatcher.js';

const ref = { owner: 'kiamiya', repo: 'jeu' };

describe('dispatcher : tâches Artiste 3D (Blender) dans un projet Unity', () => {
  it('pont Blender vérifié à part ; lancement avec l’éditeur blender, Unity sans', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    seedGreenMain(github, ref, 'unity');
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        {
          path: PROJECT_CONFIG,
          content: stringify(makeProjectConfig({ type: 'unity', qualityProfile: 'unity' })),
        },
      ],
    });
    for (const [id, profile] of [
      ['T01', 'unity'],
      ['T02', 'blender'],
    ] as const)
      await github.createIssue(ref, {
        title: id,
        body: renderTaskIssueBody(makeTask({ id, profile, dependencies: [] })),
        labels: [TASK_LABEL, stateLabel('ready')],
      });
    const bridgeHealthy = vi.fn((_editor: string) => Promise.resolve(true));
    const deps: DispatcherDeps = {
      github,
      globalCap: () => Promise.resolve({ cap: 5 }),
      bridgeHealthy,
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => new Date('2026-11-06T08:00:00Z'),
      log: () => undefined,
    };
    const result = await runDispatch(ref, deps);
    expect(result.applied.map((a) => a.kind)).toEqual(['launch', 'launch']);
    expect(bridgeHealthy.mock.calls.map((c) => c[0]).sort()).toEqual(['blender', 'unity']);
    const inputs = github.state(ref).dispatches.map((d) => d.inputs);
    expect(inputs[0]).toMatchObject({ profile: 'unity', needs_editor: 'true' });
    expect(inputs[0]).not.toHaveProperty('editor');
    expect(inputs[1]).toMatchObject({
      profile: 'blender',
      needs_editor: 'true',
      editor: 'blender',
    });
  });

  it('workflow d’appel antérieur à Blender : échec de lancement expliqué', async () => {
    const github = new FakeGitHub({ actor: 'kiamiya' });
    github.seedRepository(ref);
    seedGreenMain(github, ref, 'unity');
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'projet',
      changes: [
        {
          path: PROJECT_CONFIG,
          content: stringify(makeProjectConfig({ type: 'unity', qualityProfile: 'unity' })),
        },
      ],
    });
    await github.createIssue(ref, {
      title: 'T02',
      body: renderTaskIssueBody(makeTask({ id: 'T02', profile: 'blender', dependencies: [] })),
      labels: [TASK_LABEL, stateLabel('ready')],
    });
    vi.spyOn(github, 'dispatchWorkflow').mockRejectedValueOnce(
      new Error('Unexpected inputs provided: ["editor"]'),
    );
    const lines: string[] = [];
    await runDispatch(ref, {
      github,
      globalCap: () => Promise.resolve({ cap: 5 }),
      bridgeHealthy: () => Promise.resolve(true),
      minutesRemaining: () => Promise.resolve({ minutes: null }),
      now: () => new Date('2026-11-06T08:00:00Z'),
      log: (line) => lines.push(line),
    });
    expect(lines.join('\n')).toContain('relancer le bootstrap depuis le cockpit');
  });
});
