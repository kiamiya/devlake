import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ClaudeCliPort, cliArgs, parseCliOutput } from './cli-port.js';
import { ClaudeError } from './port.js';

const request = { prompt: 'Planifie', model: 'modele-x', cwd: '/w' };

/** Faux processus enfant : écrit stdout/stderr puis se termine avec un code. */
function fakeSpawn(
  stdout: string,
  code: number,
  stderr = '',
  calls: unknown[][] = [],
): typeof spawn {
  return ((...args: unknown[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  }) as unknown as typeof spawn;
}

describe('arguments du CLI Claude', () => {
  it('mode non interactif, sortie JSON, options du profil', () => {
    expect(cliArgs(request)).toEqual([
      '-p',
      'Planifie',
      '--model',
      'modele-x',
      '--output-format',
      'json',
    ]);
    expect(
      cliArgs({
        ...request,
        systemPrompt: 'Système',
        jsonSchema: { type: 'object' },
        maxTurns: 5,
        allowedTools: ['Read', 'Grep'],
      }),
    ).toEqual([
      '-p',
      'Planifie',
      '--model',
      'modele-x',
      '--output-format',
      'json',
      '--append-system-prompt',
      'Système',
      '--json-schema',
      '{"type":"object"}',
      '--max-turns',
      '5',
      '--allowedTools',
      'Read,Grep',
    ]);
  });
});

describe('sortie du CLI Claude', () => {
  it('lit la sortie structurée, ou à défaut le JSON du texte final', () => {
    expect(parseCliOutput('{"result":"Fini","structured_output":{"a":1}}')).toEqual({
      text: 'Fini',
      structured: { a: 1 },
    });
    expect(parseCliOutput('{"result":"{\\"b\\":2}"}')).toEqual({
      text: '{"b":2}',
      structured: { b: 2 },
    });
    expect(parseCliOutput('{"result":"{ pas du json"}')).toEqual({
      text: '{ pas du json',
      structured: null,
    });
    expect(parseCliOutput('{"result":42}')).toEqual({ text: '', structured: null });
  });

  it('signale une erreur de Claude ou une sortie illisible', () => {
    expect(() => parseCliOutput('{"is_error":true,"result":"quota"}')).toThrow(
      'Claude a renvoyé une erreur : quota',
    );
    expect(() => parseCliOutput('pas du json')).toThrow(ClaudeError);
  });
});

describe('adaptateur ClaudeCliPort', () => {
  it('lance le CLI avec le jeton d’abonnement dans le dossier du projet', async () => {
    const calls: unknown[][] = [];
    const port = new ClaudeCliPort({
      oauthToken: 'jeton-oauth',
      command: 'claude',
      spawnProcess: fakeSpawn('{"result":"ok","structured_output":{"questions":[]}}', 0, '', calls),
    });
    expect(await port.run(request)).toEqual({ text: 'ok', structured: { questions: [] } });
    const [command, args, options] = calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(command).toBe('claude');
    expect(args.slice(0, 2)).toEqual(['-p', 'Planifie']);
    expect(options.cwd).toBe('/w');
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('jeton-oauth');
  });

  it('remonte un échec du CLI sans sortie', async () => {
    const port = new ClaudeCliPort({
      oauthToken: 't',
      spawnProcess: fakeSpawn('', 1, 'jeton invalide'),
    });
    await expect(port.run(request)).rejects.toThrow(
      'Le CLI Claude a échoué (code 1) : jeton invalide',
    );
  });

  it('remonte un CLI introuvable', async () => {
    const failing = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }) as unknown as typeof spawn;
    await expect(
      new ClaudeCliPort({ oauthToken: 't', spawnProcess: failing }).run(request),
    ).rejects.toThrow('CLI Claude introuvable ou en échec : ENOENT');
  });

  it('arrête un CLI trop long', async () => {
    const silent = (() =>
      Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      })) as unknown as typeof spawn;
    await expect(
      new ClaudeCliPort({ oauthToken: 't', timeoutMs: 5, spawnProcess: silent }).run(request),
    ).rejects.toThrow('Claude n’a pas terminé');
  });
});
