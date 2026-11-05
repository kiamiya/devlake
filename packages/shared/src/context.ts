import { z } from 'zod';
import { safeParseWith, type ParseResult } from './common.js';

/** Dossier du contexte d'un projet. */
export const CONTEXT_DIR = '.agentlake/context';
export const CONTEXT_INDEX_PATH = `${CONTEXT_DIR}/context.json`;

export const CONTEXT_ROLES = ['brief', 'gdd', 'annex', 'asset'] as const;
export const ContextRoleSchema = z.enum(CONTEXT_ROLES, {
  error: `Rôle inconnu. Valeurs possibles : ${CONTEXT_ROLES.join(', ')}.`,
});
export type ContextRole = z.infer<typeof ContextRoleSchema>;

export const ContextEntrySchema = z.object({
  /** Chemin dans le dépôt. */
  path: z.string().startsWith(`${CONTEXT_DIR}/`, 'Le fichier doit être dans .agentlake/context/.'),
  role: ContextRoleSchema,
  /** Nom du fichier importé d'origine. */
  source: z.string().min(1),
  /** SHA-256 du fichier d'origine (ou de l'image pour un asset). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Empreinte SHA-256 invalide.'),
  size: z.number().int().min(0),
  importedAt: z.iso.datetime({ message: 'Date ISO 8601 attendue.' }),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/** Contenu de `.agentlake/context/context.json`. */
export const ContextIndexSchema = z
  .object({
    version: z.literal(1),
    files: z.array(ContextEntrySchema),
  })
  .refine((index) => new Set(index.files.map((f) => f.path)).size === index.files.length, {
    message: 'Un fichier est indexé deux fois.',
  });
export type ContextIndex = z.infer<typeof ContextIndexSchema>;

export const EMPTY_CONTEXT_INDEX: ContextIndex = { version: 1, files: [] };

export function parseContextIndex(input: unknown): ParseResult<ContextIndex> {
  return safeParseWith(ContextIndexSchema, input);
}
