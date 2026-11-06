import { execFile } from 'node:child_process';

/** Exécution de git dans un dossier ; renvoie la sortie standard. */
export type GitExec = (cwd: string, args: readonly string[]) => Promise<string>;

export class EditorSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorSyncError';
  }
}

/* c8 ignore start -- appel système ; les tests d'intégration l'exercent avec un vrai dépôt */
export const systemGit: GitExec = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new EditorSyncError(
              `git ${args[0] ?? ''} a échoué : ${stderr.trim() || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
/* c8 ignore stop */

/**
 * En-tête d'authentification pour GitHub : le jeton du cockpit est passé à chaque commande,
 * jamais écrit dans l'URL ni dans `.git/config` du clone.
 */
export function authArgs(token: string | null): string[] {
  if (token === null || token === '') return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** Auteur des commits faits dans l'éditeur. */
export const EDITOR_AUTHOR = {
  name: 'AgentLake (éditeur)',
  email: 'agentlake-editor@users.noreply.github.com',
};
