import type { RepoRef } from 'github';
import { z } from 'zod';

/**
 * Compte de Kia : variable Actions `AGENTLAKE_OWNER` posée au bootstrap. Pour un dépôt
 * d'organisation, le propriétaire du dépôt n'est pas Kia ; sans la variable (projets
 * bootstrappés avant), c'est le propriétaire du dépôt.
 */
export function accountOf(ref: RepoRef, account?: string | null): string {
  const value = account?.trim() ?? '';
  return value === '' ? ref.owner : value;
}

/** Variable d'environnement `AGENTLAKE_OWNER`, facultative. */
export const AccountEnvSchema = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));
