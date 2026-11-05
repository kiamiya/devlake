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
  'reviewer',
  'docs',
] as const;
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
