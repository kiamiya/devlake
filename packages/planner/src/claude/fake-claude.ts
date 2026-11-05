import type { ClaudePort, ClaudeRequest, ClaudeResponse } from './port.js';

/** Doublure de Claude : renvoie des réponses préparées, dans l'ordre, et garde les requêtes. */
export class FakeClaude implements ClaudePort {
  readonly requests: ClaudeRequest[] = [];
  private readonly queue: (ClaudeResponse | Error)[];

  constructor(responses: (ClaudeResponse | Error)[] = []) {
    this.queue = [...responses];
  }

  /** Réponse structurée (le texte reprend le JSON). */
  static structured(value: unknown): ClaudeResponse {
    return { text: JSON.stringify(value), structured: value };
  }

  push(...responses: (ClaudeResponse | Error)[]): this {
    this.queue.push(...responses);
    return this;
  }

  run(request: ClaudeRequest): Promise<ClaudeResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined)
      return Promise.reject(new Error('FakeClaude : aucune réponse préparée.'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}
