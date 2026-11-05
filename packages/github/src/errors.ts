/** Catégories d'erreurs GitHub exposées aux appelants. */
export type GitHubErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'validation'
  | 'rate-limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'unsupported';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;

  constructor(kind: GitHubErrorKind, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
  }
}

export function isGitHubError(error: unknown, kind?: GitHubErrorKind): error is GitHubError {
  return error instanceof GitHubError && (kind === undefined || error.kind === kind);
}

/** Erreur à partir d'un statut HTTP (hors limites de débit, traitées à part). */
export function errorFromStatus(status: number, message: string): GitHubError {
  if (status === 401)
    return new GitHubError('unauthorized', `Jeton GitHub refusé : ${message}`, status);
  if (status === 403)
    return new GitHubError('forbidden', `Accès refusé par GitHub : ${message}`, status);
  if (status === 404)
    return new GitHubError('not-found', `Introuvable sur GitHub : ${message}`, status);
  if (status === 409) return new GitHubError('conflict', `Conflit GitHub : ${message}`, status);
  if (status === 422)
    return new GitHubError('validation', `Requête refusée par GitHub : ${message}`, status);
  if (status >= 500)
    return new GitHubError(
      'server',
      `Erreur serveur GitHub (${String(status)}) : ${message}`,
      status,
    );
  return new GitHubError(
    'validation',
    `Réponse GitHub inattendue (${String(status)}) : ${message}`,
    status,
  );
}
