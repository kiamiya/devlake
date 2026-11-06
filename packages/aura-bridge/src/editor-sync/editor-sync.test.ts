import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuraBridge, type AuditEntry } from '../bridge.js';
import { compileErrors, readLogSince, waitForEditor } from './editor-log.js';
import { authArgs, EditorSyncError, type GitExec } from './git.js';
import { EditorSync, serializationWarnings } from './sync.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentlake-sync-'));
  dirs.push(dir);
  return dir;
}

/** Faux git : réponses par sous-commande, appels enregistrés. */
function fakeGit(answers: Record<string, string> = {}) {
  const calls: string[][] = [];
  const git: GitExec = (_cwd, args) => {
    calls.push([...args]);
    const command = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '';
    const key = command === 'rev-parse' ? `rev-parse ${args.at(-1) ?? ''}` : command;
    return Promise.resolve(answers[key] ?? '');
  };
  return { git, calls };
}

function sync(
  git: GitExec,
  clone: { clone: string; repo: string | null } | null,
  logPath = 'absent.log',
) {
  return new EditorSync({
    editor: 'unity',
    currentClone: () => Promise.resolve(clone),
    token: () => Promise.resolve('jeton'),
    git,
    logPath: () => Promise.resolve(logPath),
    wait: { timeoutMs: 50, quietMs: 10, pollMs: 1 },
  });
}

describe('refus de la synchronisation', () => {
  const clone = { clone: '/clones/kiamiya__jeu', repo: 'kiamiya/jeu' };

  it('éditeur fermé, ou ouvert sur un autre dépôt', async () => {
    await expect(sync(fakeGit().git, null).status('kiamiya/jeu')).rejects.toThrow(
      'Éditeur unity fermé',
    );
    await expect(
      sync(fakeGit().git, { clone: '/c', repo: 'kiamiya/autre' }).checkout(
        'kiamiya/jeu',
        'task/T01',
      ),
    ).rejects.toThrow('ouvert sur kiamiya/autre, pas sur kiamiya/jeu');
  });

  it('checkout refusé avec des modifications ou des commits non poussés', async () => {
    const dirty = fakeGit({ status: ' M Assets/Scenes/Main.unity\n' });
    await expect(sync(dirty.git, clone).checkout('kiamiya/jeu', 'task/T01')).rejects.toThrow(
      'Modifications non poussées dans l’éditeur (M Assets/Scenes/Main.unity)',
    );
    expect(dirty.calls.some((c) => c.includes('checkout'))).toBe(false);
    const ahead = fakeGit({ 'rev-list': '2\n' });
    await expect(sync(ahead.git, clone).checkout('kiamiya/jeu', 'task/T01')).rejects.toThrow(
      'Commits de l’éditeur pas encore poussés',
    );
    await expect(sync(fakeGit().git, clone).checkout('kiamiya/jeu', '--force')).rejects.toThrow(
      'Nom de branche invalide',
    );
  });

  it('branche absente de GitHub : pousser d’abord le code', async () => {
    const git: GitExec = (_cwd, args) =>
      args.includes('fetch')
        ? Promise.reject(new Error('couldn’t find remote ref'))
        : Promise.resolve(args[0] === 'rev-list' ? '0' : '');
    await expect(sync(git, clone).checkout('kiamiya/jeu', 'task/T09')).rejects.toThrow(
      'git push origin HEAD:task/T09',
    );
  });

  it('push refusé sur main et message vide', async () => {
    await expect(
      sync(fakeGit({ 'rev-parse HEAD': 'main\n' }).git, clone).commitPush(
        'kiamiya/jeu',
        'feat: scène',
      ),
    ).rejects.toThrow('Refus de pousser sur main');
    await expect(
      sync(fakeGit({ 'rev-parse HEAD': 'task/T01\n' }).git, clone).commitPush('kiamiya/jeu', '  '),
    ).rejects.toThrow('Message de commit vide.');
  });

  it('checkout : fetch authentifié, bascule, attente de l’éditeur ; erreurs de compilation remontées', async () => {
    const log = join(tempDir(), 'Editor.log');
    writeFileSync(log, 'ancien démarrage\n');
    const git = fakeGit({ 'rev-list': '0\n', 'rev-parse HEAD': 'abc123\n' });
    const editor = sync(git.git, clone, log);
    const pending = editor.checkout('kiamiya/jeu', 'task/T01-saut');
    setTimeout(() => {
      appendFileSync(
        log,
        'Assets/Scripts/Saut.cs(3,1): error CS1002: ; expected\nRefresh completed in 1.2 s\n',
      );
    }, 5);
    expect(await pending).toEqual({
      branch: 'task/T01-saut',
      sha: 'abc123',
      settled: true,
      compileErrors: ['Assets/Scripts/Saut.cs(3,1): error CS1002: ; expected'],
    });
    const fetch = git.calls.find((c) => c.includes('fetch')) ?? [];
    expect(fetch.slice(0, 2)).toEqual(authArgs('jeton'));
    expect(git.calls).toContainEqual(['checkout', '-B', 'task/T01-saut', 'origin/task/T01-saut']);
  });

  it('commit_push sans rien de modifié : rien n’est poussé', async () => {
    const git = fakeGit({ 'rev-parse HEAD': 'task/T01\n' });
    expect(await sync(git.git, clone).commitPush('kiamiya/jeu', 'feat: rien')).toEqual({
      branch: 'task/T01',
      sha: null,
      files: [],
      pushed: false,
    });
    expect(git.calls.some((c) => c.includes('push'))).toBe(false);
  });
});

describe('journal de l’éditeur', () => {
  it('erreurs de compilation Unity et Unreal, dédoublonnées', () => {
    const text =
      'a\nerror CS0103: x\nerror CS0103: x\nModule.cpp(4): error C2065: y\nLogBlueprint: Error: z';
    expect(compileErrors('unity', text)).toEqual(['error CS0103: x']);
    expect(compileErrors('unreal', text)).toEqual([
      'Module.cpp(4): error C2065: y',
      'LogBlueprint: Error: z',
    ]);
  });

  it('attente : ligne de fin, silence après activité, délai dépassé ; journal tronqué relu du début', async () => {
    const log = join(tempDir(), 'Jeu.log');
    writeFileSync(log, '');
    let clock = 0;
    const fast = {
      timeoutMs: 100,
      quietMs: 20,
      pollMs: 1,
      sleep: () => {
        clock += 5;
        return Promise.resolve();
      },
      now: () => clock,
    };
    expect(await waitForEditor('unreal', log, 0, fast)).toEqual({ settled: false, text: '' });
    appendFileSync(log, 'LogInit: Display: Engine is initialized\n');
    expect((await waitForEditor('unreal', log, 0, fast)).settled).toBe(true);
    appendFileSync(log, 'activité sans ligne de fin\n');
    clock = 0;
    expect((await waitForEditor('unity', log, 0, fast)).settled).toBe(true);
    expect(await readLogSince(log, 10_000)).toContain('Engine is initialized');
    expect(await readLogSince(join(tmpdir(), 'absent-agentlake.log'), 0)).toBe('');
  });
});

describe('sérialisation Unity', () => {
  it('texte forcé et .meta visibles, sinon avertissements', async () => {
    const clone = tempDir();
    expect(await serializationWarnings('unity', clone)).toEqual([
      'ProjectSettings/EditorSettings.asset absent : sérialisation texte non vérifiable.',
    ]);
    mkdirSync(join(clone, 'ProjectSettings'));
    const settings = join(clone, 'ProjectSettings', 'EditorSettings.asset');
    writeFileSync(
      settings,
      '  m_SerializationMode: 2\n  m_ExternalVersionControlSupport: Visible Meta Files\n',
    );
    expect(await serializationWarnings('unity', clone)).toEqual([]);
    writeFileSync(
      settings,
      '  m_SerializationMode: 0\n  m_ExternalVersionControlSupport: Hidden Meta Files\n',
    );
    expect(await serializationWarnings('unity', clone)).toHaveLength(2);
    expect(await serializationWarnings('unreal', clone)).toEqual([]);
  });
});

describe('outils du pont', () => {
  const bridges: AuraBridge[] = [];
  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop();
  });

  it('editor_* proposés à l’agent ; résultat en JSON ; refus lisible ; audités', async () => {
    const audit: AuditEntry[] = [];
    const editorSync = {
      status: () => Promise.resolve({ branch: 'task/T01', modified: [] }),
      checkout: () =>
        Promise.reject(new EditorSyncError('Modifications non poussées dans l’éditeur.')),
      commitPush: () => Promise.reject(new Error('disque plein')),
    } as unknown as EditorSync;
    const bridge = new AuraBridge({
      editor: 'unity',
      port: 0,
      secret: 's',
      allowedTools: () => [],
      connectUpstream: () =>
        Promise.resolve({
          listTools: () =>
            Promise.resolve([{ name: 'scene_list', inputSchema: { type: 'object' as const } }]),
          callTool: () => Promise.resolve({ content: [] }),
          close: () => Promise.resolve(),
        }),
      onAudit: (e) => audit.push(e),
      editorSync,
    });
    bridges.push(bridge);
    await bridge.start();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge
      .sessionServer({
        repo: 'kiamiya/jeu',
        runId: '1',
        profile: 'unity',
        exp: 9_999_999_999,
        scope: 'mcp',
      })
      .connect(serverSide);
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(clientSide);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'editor_checkout',
      'editor_commit_push',
      'editor_status',
    ]);
    expect(await client.callTool({ name: 'editor_status', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"branch": "task/T01"') as unknown }],
    });
    expect(
      await client.callTool({ name: 'editor_checkout', arguments: { branch: 'task/T01' } }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Modifications non poussées dans l’éditeur.' }],
    });
    await expect(
      client.callTool({ name: 'editor_commit_push', arguments: { message: 'x' } }),
    ).rejects.toThrow('disque plein');
    expect(audit.map((e) => [e.tool, e.outcome])).toEqual([
      ['editor_status', 'ok'],
      ['editor_checkout', 'refused'],
      ['editor_commit_push', 'error'],
    ]);
  });
});
