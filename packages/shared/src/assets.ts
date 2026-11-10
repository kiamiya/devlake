import { z } from 'zod';
import { safeParseWith, type ParseResult } from './common.js';

/** Bibliothèque d'assets d'un projet de jeu, lue par le planificateur et les agents. */
export const ASSET_LIBRARY_PATH = '.agentlake/assets.json';

/** D'où vient un asset. */
export const ASSET_ORIGINS = [
  /** Cache de l'Asset Store de Unity (.unitypackage). */
  'unity-store-cache',
  /** VaultCache du launcher Epic (contenu Unreal Fab / Marketplace). */
  'epic-vault',
  /** Dossier déclaré par Kia. */
  'folder',
  /** Lien vers une boutique (Asset Store, Fab…), acheté ou à acheter par Kia. */
  'store-link',
  'polyhaven',
  'ambientcg',
] as const;
export const AssetOriginSchema = z.enum(ASSET_ORIGINS);
export type AssetOrigin = z.infer<typeof AssetOriginSchema>;

/** Licences : seules `cc0` et `cc-by` autorisent la redistribution dans un dépôt public. */
export const ASSET_LICENSES = ['cc0', 'cc-by', 'store', 'proprietary', 'unknown'] as const;
export const AssetLicenseSchema = z.enum(ASSET_LICENSES);
export type AssetLicense = z.infer<typeof AssetLicenseSchema>;

export const ASSET_LICENSE_LABELS: Record<AssetLicense, string> = {
  cc0: 'CC0 (domaine public)',
  'cc-by': 'CC-BY (attribution exigée)',
  store: 'Licence de boutique (Asset Store, Fab…), redistribution interdite',
  proprietary: 'Propriétaire, redistribution interdite',
  unknown: 'Licence inconnue',
};

/** Licence qui interdit (ou ne garantit pas) la redistribution publique. */
export function isRestrictedLicense(license: AssetLicense): boolean {
  return license !== 'cc0' && license !== 'cc-by';
}

/** `wanted` : lien de boutique pas encore versé ; `imported` : fichiers dans le dépôt. */
export const ASSET_STATUSES = ['wanted', 'imported'] as const;

export const AssetEntrySchema = z.object({
  /** Identifiant stable dans le projet (slug). */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Identifiant d’asset invalide.'),
  name: z.string().trim().min(1, 'Nom d’asset vide.').max(200),
  origin: AssetOriginSchema,
  status: z.enum(ASSET_STATUSES),
  license: AssetLicenseSchema,
  /** Attribution à citer (CC-BY) ou précisions sur la licence. */
  attribution: z.string().max(1000).optional(),
  /** Page de l'asset (boutique, Poly Haven, ambientCG). */
  url: z.url({ message: 'URL invalide.' }).optional(),
  /** Dossier du dépôt où sont ses fichiers (asset versé). */
  path: z.string().optional(),
  files: z.number().int().min(0).optional(),
  size: z.number().int().min(0).optional(),
  /** Issue de la tâche d'intégration créée au versement. */
  integrationIssue: z.number().int().min(1).optional(),
  note: z.string().max(2000).optional(),
  addedAt: z.iso.datetime({ message: 'Date ISO 8601 attendue.' }),
});
export type AssetEntry = z.infer<typeof AssetEntrySchema>;

export const AssetLibrarySchema = z
  .object({ version: z.literal(1), assets: z.array(AssetEntrySchema) })
  .refine((l) => new Set(l.assets.map((a) => a.id)).size === l.assets.length, {
    message: 'Un asset est listé deux fois.',
  });
export type AssetLibrary = z.infer<typeof AssetLibrarySchema>;

export const EMPTY_ASSET_LIBRARY: AssetLibrary = { version: 1, assets: [] };

export function parseAssetLibrary(input: unknown): ParseResult<AssetLibrary> {
  return safeParseWith(AssetLibrarySchema, input);
}

/** Résumé Markdown de la bibliothèque, pour les prompts du planificateur et des agents. */
export function renderAssetLibrary(library: AssetLibrary): string {
  if (library.assets.length === 0) return '_Aucun asset choisi pour l’instant._';
  return library.assets
    .map((a) => {
      const where =
        a.status === 'imported'
          ? `versé dans \`${a.path ?? '?'}\``
          : `à acquérir${a.url ? ` (${a.url})` : ''}, pas encore dans le dépôt`;
      const extra = [
        a.license === 'cc-by' && a.attribution ? `attribution : ${a.attribution}` : null,
        a.note ? `note : ${a.note}` : null,
      ].filter((x): x is string => x !== null);
      return `- **${a.name}** (\`${a.id}\`, ${a.origin}, ${a.license}) : ${where}${extra.length > 0 ? ` ; ${extra.join(' ; ')}` : ''}`;
    })
    .join('\n');
}
