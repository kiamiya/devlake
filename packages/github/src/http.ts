import type { Octokit } from '@octokit/core';
import type { z } from 'zod';
import { GitHubError, errorFromStatus } from './errors.js';

export interface RetryOptions {
  /** Relances après le premier essai. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Délai maximal d'un appel. */
  timeoutMs: number;
  /** Au-delà, une limite de débit devient une erreur au lieu d'une attente. */
  maxRateLimitWaitMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 30_000,
  maxRateLimitWaitMs: 5 * 60_000,
};

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

interface ErrorShape {
  status?: unknown;
  name?: unknown;
  message?: unknown;
  response?: { headers?: Record<string, unknown>; data?: unknown };
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function apiMessage(error: ErrorShape): string {
  const data = error.response?.data;
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const message = data.message;
    if (typeof message === 'string') return message;
  }
  return typeof error.message === 'string' ? error.message : 'erreur inconnue';
}

type Outcome =
  { retry: true; delayMs: number; error: GitHubError } | { retry: false; error: GitHubError };

/**
 * Appels HTTP à GitHub avec délai, relances et respect des limites de débit.
 * Toute réponse est validée par un schéma zod avant d'être rendue.
 */
export class GitHubHttp {
  private rateLimitResetAt: number | undefined;

  constructor(
    private readonly octokit: Octokit,
    private readonly options: RetryOptions = DEFAULT_RETRY_OPTIONS,
    private readonly clock: Clock = systemClock,
    private readonly random: () => number = Math.random,
  ) {}

  async request<S extends z.ZodType>(
    route: string,
    params: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const data = await this.raw(route, params);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new GitHubError(
        'invalid-response',
        `Réponse inattendue de GitHub pour « ${route} » : ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join(' ; ')}`,
      );
    }
    return parsed.data;
  }

  /** Appel sans validation de la réponse (corps vide ou texte). */
  async raw(route: string, params: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForRateLimit();
      try {
        const response = await this.octokit.request(route, {
          ...params,
          request: { signal: AbortSignal.timeout(this.options.timeoutMs) },
        });
        this.recordRateLimit(response.headers);
        return response.data as unknown;
      } catch (error) {
        const outcome = this.classify(error as ErrorShape, attempt);
        if (!outcome.retry) throw outcome.error;
        await this.clock.sleep(outcome.delayMs);
      }
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.rateLimitResetAt === undefined) return;
    const wait = this.rateLimitResetAt - this.clock.now();
    this.rateLimitResetAt = undefined;
    if (wait <= 0) return;
    if (wait > this.options.maxRateLimitWaitMs) {
      throw new GitHubError(
        'rate-limited',
        `Limite de débit GitHub atteinte ; reprise possible dans ${String(Math.ceil(wait / 1000))} s.`,
      );
    }
    await this.clock.sleep(wait);
  }

  private recordRateLimit(headers: Record<string, unknown> | undefined): void {
    const remaining = header(headers, 'x-ratelimit-remaining');
    const reset = header(headers, 'x-ratelimit-reset');
    if (remaining === '0' && reset !== undefined) {
      this.rateLimitResetAt = Number(reset) * 1000;
    }
  }

  private backoff(attempt: number): number {
    const exponential = this.options.baseDelayMs * 2 ** attempt;
    const jitter = 0.5 + this.random() / 2;
    return Math.min(this.options.maxDelayMs, Math.round(exponential * jitter));
  }

  private classify(error: ErrorShape, attempt: number): Outcome {
    const canRetry = attempt < this.options.maxRetries;
    const status = typeof error.status === 'number' ? error.status : undefined;
    const headers = error.response?.headers;

    // Octokit relaie l'AbortError tel quel, mais enveloppe le TimeoutError (cause).
    const causeName = (error as { cause?: { name?: unknown } }).cause?.name;
    const timedOut = [error.name, causeName].some(
      (n) => n === 'AbortError' || n === 'TimeoutError',
    );
    if (timedOut) {
      const timeout = new GitHubError(
        'timeout',
        `GitHub n’a pas répondu en ${String(this.options.timeoutMs)} ms.`,
        undefined,
        { cause: error },
      );
      return canRetry
        ? { retry: true, delayMs: this.backoff(attempt), error: timeout }
        : { retry: false, error: timeout };
    }

    if (status === undefined || error.response === undefined) {
      const network = new GitHubError(
        'network',
        `GitHub injoignable : ${apiMessage(error)}`,
        status,
        {
          cause: error,
        },
      );
      return canRetry
        ? { retry: true, delayMs: this.backoff(attempt), error: network }
        : { retry: false, error: network };
    }

    const retryAfter = header(headers, 'retry-after');
    const remaining = header(headers, 'x-ratelimit-remaining');
    const reset = header(headers, 'x-ratelimit-reset');
    const rateLimited =
      (status === 403 || status === 429) && (retryAfter !== undefined || remaining === '0');
    if (rateLimited) {
      const wait =
        retryAfter !== undefined
          ? Number(retryAfter) * 1000
          : Math.max(0, Number(reset) * 1000 - this.clock.now());
      const limited = new GitHubError(
        'rate-limited',
        `Limite de débit GitHub atteinte ; reprise possible dans ${String(Math.ceil(wait / 1000))} s.`,
        status,
        { cause: error },
      );
      return canRetry && wait <= this.options.maxRateLimitWaitMs
        ? { retry: true, delayMs: wait, error: limited }
        : { retry: false, error: limited };
    }

    const typed = errorFromStatus(status, apiMessage(error));
    typed.cause = error;
    if (status >= 500 && canRetry)
      return { retry: true, delayMs: this.backoff(attempt), error: typed };
    return { retry: false, error: typed };
  }
}
