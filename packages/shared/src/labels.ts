import { PROFILE_IDS, type ProfileId } from './ids.js';

export const TASK_LABEL = 'agentlake:task';

export const TASK_STATES = [
  'queued',
  'ready',
  'running',
  'awaiting-answer',
  'waiting-editor',
  'fixing',
  'escalated',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const INITIAL_TASK_STATE: TaskState = 'queued';

/**
 * Transitions autorisées entre états (cycle de vie du cadrage).
 * Une tâche mergée n'a pas d'état : son issue est fermée par la PR.
 */
export const STATE_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['ready'],
  ready: ['running', 'waiting-editor'],
  'waiting-editor': ['ready'],
  running: ['awaiting-answer', 'fixing'],
  'awaiting-answer': ['running'],
  fixing: ['running', 'escalated'],
  escalated: ['running'],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

const STATE_PREFIX = 'agentlake:state/';
const PROFILE_PREFIX = 'agentlake:profile/';

export function stateLabel(state: TaskState): string {
  return `${STATE_PREFIX}${state}`;
}

export function profileLabel(profile: ProfileId): string {
  return `${PROFILE_PREFIX}${profile}`;
}

export function parseStateLabel(label: string): TaskState | undefined {
  if (!label.startsWith(STATE_PREFIX)) return undefined;
  const value = label.slice(STATE_PREFIX.length);
  return TASK_STATES.find((s) => s === value);
}

export function parseProfileLabel(label: string): ProfileId | undefined {
  if (!label.startsWith(PROFILE_PREFIX)) return undefined;
  const value = label.slice(PROFILE_PREFIX.length);
  return PROFILE_IDS.find((p) => p === value);
}

/** Tous les labels qu'AgentLake pose sur un dépôt. */
export const ALL_LABELS: readonly string[] = [
  TASK_LABEL,
  ...TASK_STATES.map(stateLabel),
  ...PROFILE_IDS.map(profileLabel),
];
