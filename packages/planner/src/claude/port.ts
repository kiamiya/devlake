/** Requête à Claude Code en mode non interactif. */
export interface ClaudeRequest {
  prompt: string;
  /** Modèle choisi dans les réglages ; jamais codé en dur. */
  model: string;
  systemPrompt?: string;
  /** Schéma JSON de la sortie structurée attendue. */
  jsonSchema?: Record<string, unknown>;
  maxTurns?: number;
  /** Outils autorisés (ex. Read, Glob, Grep pour une lecture seule). */
  allowedTools?: string[];
  /** Dossier de travail (copie du dépôt du projet). */
  cwd: string;
}

export interface ClaudeResponse {
  /** Texte final de Claude. */
  text: string;
  /** Sortie structurée, si un schéma était demandé et respecté. */
  structured: unknown;
}

/** Accès à Claude ; implémenté par le CLI Claude Code et par une doublure. */
export interface ClaudePort {
  run(request: ClaudeRequest): Promise<ClaudeResponse>;
}

export class ClaudeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClaudeError';
  }
}
