import { spawn } from 'node:child_process';
import { ClaudeError, type ClaudePort, type ClaudeRequest, type ClaudeResponse } from './port.js';

export interface ClaudeCliOptions {
  /** Exécutable du CLI Claude Code. */
  command?: string;
  /** Délai maximal d'un appel. */
  timeoutMs?: number;
  /** Jeton d'abonnement (CLAUDE_CODE_OAUTH_TOKEN). */
  oauthToken: string;
  /** Lancement d'un processus ; remplaçable en test. */
  spawnProcess?: typeof spawn;
}

/** Arguments du CLI : mode non interactif, sortie JSON. */
export function cliArgs(request: ClaudeRequest): string[] {
  const args = ['-p', request.prompt, '--model', request.model, '--output-format', 'json'];
  if (request.systemPrompt !== undefined) args.push('--append-system-prompt', request.systemPrompt);
  if (request.jsonSchema !== undefined)
    args.push('--json-schema', JSON.stringify(request.jsonSchema));
  if (request.maxTurns !== undefined) args.push('--max-turns', String(request.maxTurns));
  if (request.allowedTools !== undefined && request.allowedTools.length > 0) {
    args.push('--allowedTools', request.allowedTools.join(','));
  }
  return args;
}

/** Lit la sortie JSON du CLI : texte final et sortie structurée éventuelle. */
export function parseCliOutput(stdout: string): ClaudeResponse {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new ClaudeError(`Sortie illisible du CLI Claude : ${stdout.slice(0, 500)}`);
  }
  const result = data as { is_error?: unknown; result?: unknown; structured_output?: unknown };
  if (result.is_error === true) {
    throw new ClaudeError(
      `Claude a renvoyé une erreur : ${typeof result.result === 'string' ? result.result : 'inconnue'}`,
    );
  }
  const text = typeof result.result === 'string' ? result.result : '';
  let structured: unknown = result.structured_output ?? null;
  if (structured === null && text.trim().startsWith('{')) {
    try {
      structured = JSON.parse(text) as unknown;
    } catch {
      structured = null;
    }
  }
  return { text, structured };
}

/** Adaptateur : lance le CLI Claude Code (`claude -p`) avec le jeton d'abonnement. */
export class ClaudeCliPort implements ClaudePort {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: ClaudeCliOptions) {
    this.command = options.command ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  run(request: ClaudeRequest): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, cliArgs(request), {
        cwd: request.cwd,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new ClaudeError(
            `Claude n’a pas terminé en ${String(Math.round(this.timeoutMs / 60_000))} min.`,
          ),
        );
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new ClaudeError(`CLI Claude introuvable ou en échec : ${error.message}`, {
            cause: error,
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && stdout.trim() === '') {
          reject(
            new ClaudeError(
              `Le CLI Claude a échoué (code ${String(code)}) : ${stderr.slice(-2000)}`,
            ),
          );
          return;
        }
        try {
          resolve(parseCliOutput(stdout));
        } catch (error) {
          reject(error instanceof Error ? error : new ClaudeError(String(error)));
        }
      });
    });
  }
}
