/**
 * Canaux IPC déclarés. Le preload n'expose que ceux-ci ; ce fichier reste
 * sans dépendance pour être intégré au preload en bac à sable.
 */
export const IPC_CHANNELS = [
  'settings:get',
  'settings:update',
  'token:get-masked',
  'token:set',
  'token:clear',
  'token:test',
  'status:get',
  'cache:rebuild',
  'projects:list',
  'projects:discover',
  'projects:open',
  'projects:sync',
  'tabs:get',
  'tabs:save',
  'activity:get',
  'claude-token:get-masked',
  'claude-token:set',
  'claude-token:clear',
  'projects:create',
  'projects:bootstrap',
  'context:choose-files',
  'context:import',
  'context:list',
  'context:preview',
  'context:preview-staged',
  'context:set-role',
  'context:set-note',
  'context:remove',
  'context:decisions',
  'planner:start',
  'plan:versions',
  'plan:get',
  'plan:save',
  'plan:set-cap',
  'plan:validate',
  'questions:list',
  'questions:sync',
  'questions:answer',
  'dashboard:get',
  'dashboard:set-paused',
  'dashboard:relaunch',
  'runs:logs',
  'runs:transcript',
  'bridge:list',
  'bridge:start',
  'bridge:stop',
  'bridge:tools',
  'bridge:set-tools',
  'bridge:audit',
  'tunnel:status',
  'tunnel:open',
  'tunnel:close',
  'tunnel:kill',
  'bridge:prepare-clone',
] as const;

/**
 * Canal réservé au preload : il convertit les fichiers déposés en chemins (webUtils).
 * Absent de IPC_CHANNELS, il n'est pas accessible par l'invoke générique du renderer.
 */
export const DROPPED_FILES_CHANNEL = 'context:register-dropped';

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value);
}

/** Erreur structurée renvoyée par le processus principal. */
export interface IpcErrorPayload {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorPayload };

/** API exposée au renderer par le preload (`window.agentlake`). */
export interface AgentLakeBridge {
  invoke(channel: IpcChannel, input?: unknown): Promise<IpcResult<unknown>>;
  /** Enregistre des fichiers déposés pour un projet ; renvoie des identifiants opaques. */
  dropFiles(projectId: string, files: readonly File[]): Promise<IpcResult<unknown>>;
}
