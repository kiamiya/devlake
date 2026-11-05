import { execFile } from 'node:child_process';

/** Exécution de git ; renvoie la sortie standard. */
export interface Git {
  run(args: readonly string[]): Promise<string>;
}

export class GitError extends Error {
  constructor(args: readonly string[], detail: string) {
    super(`git ${args.join(' ')} a échoué : ${detail}`);
    this.name = 'GitError';
  }
}

export function systemGit(cwd: string, env: NodeJS.ProcessEnv = process.env): Git {
  return {
    run: (args) =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          [...args],
          { cwd, env, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) reject(new GitError(args, stderr.trim() || error.message));
            else resolve(stdout);
          },
        );
      }),
  };
}

/** En-tête d'authentification git pour un jeton (jamais dans l'URL ni la configuration). */
export function authHeader(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** Extrait la branche de la tâche : reprise si elle existe sur le dépôt, sinon créée depuis main. */
export async function checkoutTaskBranch(
  git: Git,
  branch: string,
  token: string,
): Promise<'created' | 'resumed'> {
  await git.run([...authHeader(token), 'fetch', '--no-tags', 'origin', 'main']);
  const remote = (
    await git.run([...authHeader(token), 'ls-remote', '--heads', 'origin', branch])
  ).trim();
  if (remote !== '') {
    await git.run([
      ...authHeader(token),
      'fetch',
      '--no-tags',
      'origin',
      `${branch}:refs/remotes/origin/${branch}`,
    ]);
    await git.run(['checkout', '-B', branch, `origin/${branch}`]);
    return 'resumed';
  }
  await git.run(['checkout', '-B', branch, 'origin/main']);
  return 'created';
}
