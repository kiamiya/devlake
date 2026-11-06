import { describe, expect, it } from 'vitest';
import {
  EMPTY_DISPATCH_META,
  parseGlobalConfig,
  readDispatchMeta,
  renderGlobalConfig,
  writeDispatchMeta,
} from './dispatch.js';
import { parseTaskIssueBody, renderTaskIssueBody } from './task-issue.js';
import { makeTask } from './test-utils.js';

describe('métadonnées du dispatcher dans l’issue', () => {
  const body = renderTaskIssueBody(makeTask());

  it('absentes ou illisibles : aucune tentative', () => {
    expect(readDispatchMeta(body)).toEqual(EMPTY_DISPATCH_META);
    expect(readDispatchMeta(`${body}\n<!-- agentlake:dispatch pas-du-json -->\n`)).toEqual(
      EMPTY_DISPATCH_META,
    );
    expect(readDispatchMeta(`${body}\n<!-- agentlake:dispatch {"attempts":-1} -->\n`)).toEqual(
      EMPTY_DISPATCH_META,
    );
  });

  it('écrites en fin de corps, remplacées sans toucher à la tâche', () => {
    const once = writeDispatchMeta(body, { attempts: 1, launchedAt: '2026-11-05T12:00:00.000Z' });
    const twice = writeDispatchMeta(once, { attempts: 2, launchedAt: null });
    expect(readDispatchMeta(twice)).toEqual({ ...EMPTY_DISPATCH_META, attempts: 2 });
    expect(twice.match(/agentlake:dispatch/g)).toHaveLength(1);
    expect(parseTaskIssueBody(twice)).toEqual(parseTaskIssueBody(body));
    expect(readDispatchMeta(twice.replaceAll('\n', '\r\n'))).toEqual({
      ...EMPTY_DISPATCH_META,
      attempts: 2,
    });
  });
});

describe('configuration globale', () => {
  it('aller-retour, et erreurs lisibles', () => {
    expect(parseGlobalConfig(renderGlobalConfig({ maxConcurrentAgents: 4 }))).toEqual({
      ok: true,
      value: { maxConcurrentAgents: 4, paused: false, projects: [] },
    });
    // Pause globale et projets : écrits par le cockpit, absents des anciennes configurations.
    expect(
      parseGlobalConfig(
        renderGlobalConfig({ maxConcurrentAgents: 2, paused: true, projects: ['kiamiya/site'] }),
      ),
    ).toEqual({
      ok: true,
      value: { maxConcurrentAgents: 2, paused: true, projects: ['kiamiya/site'] },
    });
    const pause = parseGlobalConfig('maxConcurrentAgents: 2\npaused: oui\n');
    expect(!pause.ok && pause.error).toContain('paused doit valoir true ou false.');
    const projects = parseGlobalConfig('maxConcurrentAgents: 2\nprojects: [site]\n');
    expect(!projects.ok && projects.error).toContain('Projet attendu au format owner/repo.');
    expect(parseGlobalConfig('a: [')).toMatchObject({ ok: false });
    const invalid = parseGlobalConfig('maxConcurrentAgents: 1.5\n');
    expect(!invalid.ok && invalid.error).toContain('Le plafond global doit être un entier.');
  });
});
