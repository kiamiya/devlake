import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentBranch, originRepository, probeEditor } from '../editor-probe.js';
import { CloudflareTunnel, TailscaleFunnel, TunnelError } from './providers.js';

describe('sonde de l’éditeur', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function clones() {
    const root = mkdtempSync(join(tmpdir(), 'agentlake-clones-'));
    dirs.push(root);
    const clone = (name: string, remote: string, branch: string | null) => {
      const dir = join(root, name);
      mkdirSync(join(dir, '.git'), { recursive: true });
      writeFileSync(
        join(dir, '.git', 'HEAD'),
        branch === null ? 'a1b2c3d4\n' : `ref: refs/heads/${branch}\n`,
      );
      writeFileSync(
        join(dir, '.git', 'config'),
        `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
      return dir;
    };
    return { root, clone };
  }

  it('Unity : clone dont le verrou de l’éditeur est présent ; projet et branche courants', async () => {
    const { root, clone } = clones();
    clone('kiamiya__autre', 'https://github.com/kiamiya/autre.git', 'main');
    const jeu = clone('kiamiya__jeu', 'git@github.com:kiamiya/jeu.git', 'task/T04-saut');
    expect(await probeEditor(root, 'unity')).toEqual({
      open: false,
      repo: null,
      branch: null,
      clone: null,
    });
    mkdirSync(join(jeu, 'Temp'));
    writeFileSync(join(jeu, 'Temp', 'UnityLockfile'), '');
    expect(await probeEditor(root, 'unity')).toEqual({
      open: true,
      repo: 'kiamiya/jeu',
      branch: 'task/T04-saut',
      clone: jeu,
    });
  });

  it('Unreal : processus UnrealEditor ouvert sur le .uproject du clone', async () => {
    const { root, clone } = clones();
    const jeu = clone('kiamiya__jeu', 'https://github.com/kiamiya/jeu', 'main');
    writeFileSync(join(jeu, 'Jeu.uproject'), '{}');
    const listProcesses = vi.fn(() =>
      Promise.resolve([
        'explorer.exe',
        `"C:\\UE\\UnrealEditor.exe" "${resolve(jeu, 'Jeu.uproject')}"`,
      ]),
    );
    expect(await probeEditor(root, 'unreal', { listProcesses })).toMatchObject({
      open: true,
      repo: 'kiamiya/jeu',
    });
    expect(
      await probeEditor(root, 'unreal', { listProcesses: () => Promise.resolve(['explorer.exe']) }),
    ).toMatchObject({ open: false });
  });

  it('sans dossier des clones, ou HEAD détaché, ou remote absent', async () => {
    expect(await probeEditor(null, 'unity')).toMatchObject({ open: false });
    expect(await probeEditor(join(tmpdir(), 'inexistant-agentlake'), 'unity')).toMatchObject({
      open: false,
    });
    const { clone } = clones();
    const detached = clone('x', 'https://gitlab.com/a/b.git', null);
    expect(await currentBranch(detached)).toBeNull();
    expect(await originRepository(detached)).toBeNull();
    expect(await originRepository(join(detached, 'absent'))).toBeNull();
  });
});

describe('Tailscale Funnel', () => {
  it('ouvre le port 443 vers la passerelle et donne l’URL MagicDNS', async () => {
    const calls: string[] = [];
    const exec = (command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      return Promise.resolve(
        args[0] === 'status' ? JSON.stringify({ Self: { DNSName: 'poste.tailnet.ts.net.' } }) : '',
      );
    };
    const funnel = new TailscaleFunnel(exec);
    expect(await funnel.start(8764)).toBe('https://poste.tailnet.ts.net');
    await funnel.stop();
    expect(calls).toEqual([
      'tailscale status --json',
      'tailscale funnel --bg --https=443 8764',
      'tailscale funnel --https=443 off',
    ]);
  });

  it('erreurs lisibles : Tailscale absent, ou poste sans nom DNS', async () => {
    await expect(
      new TailscaleFunnel(() => Promise.reject(new Error('introuvable'))).start(1),
    ).rejects.toThrow('Tailscale indisponible');
    await expect(new TailscaleFunnel(() => Promise.resolve('{}')).start(1)).rejects.toThrow(
      TunnelError,
    );
  });
});

/** Faux processus cloudflared. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
    killed: boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe('Cloudflare Tunnel', () => {
  it('lit l’URL du tunnel rapide dans la sortie de cloudflared ; arrêt = fin du processus', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const tunnel = new CloudflareTunnel(spawnFn);
    const started = tunnel.start(8764);
    child.stderr.write('INF Requesting new quick Tunnel...\n');
    child.stderr.write('INF |  https://vif-renard-42.trycloudflare.com  |\n');
    expect(await started).toBe('https://vif-renard-42.trycloudflare.com');
    expect(spawnFn).toHaveBeenCalledWith('cloudflared', [
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:8764',
    ]);
    await tunnel.stop();
    expect(child.killed).toBe(true);
  });

  it('échecs : processus introuvable, arrêt prématuré, délai dépassé', async () => {
    const missing = fakeChild();
    const a = new CloudflareTunnel(() => missing as unknown as ChildProcess).start(1);
    missing.emit('error', new Error('spawn cloudflared ENOENT'));
    await expect(a).rejects.toThrow('cloudflared introuvable');

    const dying = fakeChild();
    const b = new CloudflareTunnel(() => dying as unknown as ChildProcess).start(1);
    dying.emit('exit', 1);
    await expect(b).rejects.toThrow('cloudflared s’est arrêté (code 1).');

    const silent = fakeChild();
    await expect(
      new CloudflareTunnel(() => silent as unknown as ChildProcess, 10).start(1),
    ).rejects.toThrow('pas donné d’URL publique à temps');
    expect(silent.killed).toBe(true);
  });
});
