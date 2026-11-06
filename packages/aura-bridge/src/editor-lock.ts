/** Durée sans appel au-delà de laquelle l'éditeur est libéré. */
export const IDLE_RELEASE_MS = 10 * 60_000;

interface Holder {
  runId: string;
  repo: string;
  /** Expiration du jeton qui a ouvert la session (ms). */
  expiresAt: number;
  lastActivity: number;
}

export type LockResult = { ok: true } | { ok: false; holder: { runId: string; repo: string } };

/**
 * Un seul run à la fois sur un éditeur : le run qui ouvre la session garde l'éditeur jusqu'à
 * la fin de sa session, l'expiration de son jeton ou dix minutes sans appel.
 */
export class EditorLock {
  private holder: Holder | null = null;

  constructor(private readonly idleMs = IDLE_RELEASE_MS) {}

  private expired(now: number): boolean {
    const h = this.holder;
    return h !== null && (now >= h.expiresAt || now - h.lastActivity >= this.idleMs);
  }

  /** Prend (ou garde) l'éditeur pour ce run ; refuse si un autre run le tient encore. */
  acquire(input: { runId: string; repo: string; expiresAt: number }, now: number): LockResult {
    if (this.expired(now)) this.holder = null;
    const h = this.holder;
    if (h && h.runId !== input.runId)
      return { ok: false, holder: { runId: h.runId, repo: h.repo } };
    this.holder = { ...input, lastActivity: now };
    return { ok: true };
  }

  /** Libère l'éditeur si ce run le tient. */
  release(runId: string): void {
    if (this.holder?.runId === runId) this.holder = null;
  }

  current(now: number): { runId: string; repo: string } | null {
    if (this.expired(now)) this.holder = null;
    return this.holder ? { runId: this.holder.runId, repo: this.holder.repo } : null;
  }
}
