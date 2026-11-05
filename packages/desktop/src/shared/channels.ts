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
] as const;

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
}
