import { z } from 'zod';

/** Profils d'agents (voir docs/cadrage.md, section Agents). */
export const PROFILE_IDS = [
  'architect',
  'frontend',
  'backend',
  'data',
  'mobile',
  'devops',
  'qa',
  'unity',
  'unreal',
  'blender',
  'reviewer',
  'docs',
] as const;
/**
 * Éditeurs du poste reliés aux agents par un pont : Unity et Unreal (Aura), Blender (3D).
 * Chacun a son pont, son verrou et son clone dédié ; le profil d'agent du même nom l'utilise.
 */
export const EDITORS = ['unity', 'unreal', 'blender'] as const;
export type EditorId = (typeof EDITORS)[number];
export const EditorIdSchema = z.enum(EDITORS, {
  error: `Éditeur inconnu. Valeurs possibles : ${EDITORS.join(', ')}.`,
});

/** Variable de dépôt qui porte l'URL publique du pont d'un éditeur. */
export function bridgeUrlVariable(editor: EditorId): 'AURA_BRIDGE_URL' | 'BLENDER_BRIDGE_URL' {
  return editor === 'blender' ? 'BLENDER_BRIDGE_URL' : 'AURA_BRIDGE_URL';
}

export const ProfileIdSchema = z.enum(PROFILE_IDS, {
  error: `Profil inconnu. Valeurs possibles : ${PROFILE_IDS.join(', ')}.`,
});
export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const PROJECT_TYPES = [
  'web',
  'unity',
  'unreal',
  'mobile',
  'tool',
  'backend',
  'script',
] as const;
export const ProjectTypeSchema = z.enum(PROJECT_TYPES, {
  error: `Type de projet inconnu. Valeurs possibles : ${PROJECT_TYPES.join(', ')}.`,
});
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/** Profils qualité (tableau « Profils par type de projet » du cadrage). */
export const QUALITY_PROFILES = ['web', 'backend', 'mobile', 'tool', 'unity', 'unreal'] as const;
export const QualityProfileSchema = z.enum(QUALITY_PROFILES, {
  error: `Profil qualité inconnu. Valeurs possibles : ${QUALITY_PROFILES.join(', ')}.`,
});
export type QualityProfile = z.infer<typeof QualityProfileSchema>;

export const TASK_ID_PATTERN = /^T\d{2,}$/;
export const TaskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, 'Identifiant de tâche attendu au format Txx (ex. T07).');
export type TaskId = z.infer<typeof TaskIdSchema>;

export const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const QuestionIdSchema = z
  .string()
  .regex(
    QUESTION_ID_PATTERN,
    'Identifiant de question invalide : lettres, chiffres, « . », « _ » ou « - », sans espace.',
  );
export type QuestionId = z.infer<typeof QuestionIdSchema>;
