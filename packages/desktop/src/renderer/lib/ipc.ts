import type { AgentLakeBridge, IpcChannel, IpcErrorPayload } from '../../shared/channels.js';
import type { IpcInput, IpcOutput } from '../../shared/ipc-contract.js';

declare global {
  interface Window {
    agentlake: AgentLakeBridge;
  }
}

/** Erreur structurée renvoyée par le processus principal. */
export class IpcError extends Error {
  readonly code: string;

  constructor(payload: IpcErrorPayload) {
    super(payload.message);
    this.name = 'IpcError';
    this.code = payload.code;
  }
}

/** Appel IPC typé par le contrat partagé. */
export async function invoke<C extends IpcChannel>(
  channel: C,
  ...input: IpcInput<C> extends undefined ? [] : [IpcInput<C>]
): Promise<IpcOutput<C>> {
  const result = await window.agentlake.invoke(channel, input[0]);
  if (!result.ok) throw new IpcError(result.error);
  return result.data as IpcOutput<C>;
}
