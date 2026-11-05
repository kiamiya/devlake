import { ProfileIdSchema } from 'shared';
import { z } from 'zod';

/** Bloc JSON collé depuis l'écran « MCP Configuration » d'Aura : doit être un objet JSON. */
const AuraMcpBlockSchema = z
  .string()
  .refine((text) => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    } catch {
      return false;
    }
  }, 'Le bloc collé depuis Aura doit être un objet JSON valide.')
  .nullable();

export const SettingsSchema = z.object({
  /** Compte GitHub des projets. */
  githubAccount: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Nom de compte GitHub invalide.'),
  /** Plafond global d'agents simultanés, tous projets confondus (C_global). */
  maxConcurrentAgents: z
    .number()
    .int('Le plafond d’agents doit être un entier.')
    .min(1, 'Le plafond d’agents doit être au moins 1.')
    .max(50, 'Le plafond d’agents ne peut pas dépasser 50.'),
  /** Tentatives d'agent avant escalade. */
  maxAttempts: z
    .number()
    .int('Le nombre de tentatives doit être un entier.')
    .min(1, 'Il faut au moins une tentative.')
    .max(10, 'Au plus 10 tentatives.'),
  /** Modèle Claude par profil ; aucun modèle n'est codé en dur. */
  modelsByProfile: z.partialRecord(ProfileIdSchema, z.string().trim().min(1, 'Modèle vide.')),
  /** Dossier des clones dédiés à l'éditeur Unity/Unreal. */
  editorClonesDir: z.string().trim().min(1, 'Dossier vide.').nullable(),
  /** Version épinglée (tag) des workflows réutilisables de devlake, posée au bootstrap. */
  workflowsVersion: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, 'Version invalide : lettres, chiffres, « . », « _ » ou « - ».'),
  /** Configurations MCP d'Aura, collées telles quelles. */
  auraMcp: z.object({ unity: AuraMcpBlockSchema, unreal: AuraMcpBlockSchema }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  githubAccount: 'kiamiya',
  maxConcurrentAgents: 3,
  maxAttempts: 3,
  modelsByProfile: {},
  editorClonesDir: null,
  workflowsVersion: 'v1',
  auraMcp: { unity: null, unreal: null },
};

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
