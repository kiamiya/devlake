import { isGitHubError } from 'github';
import type { z } from 'zod';
import {
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
  type IpcErrorPayload,
  type IpcResult,
} from '../shared/channels.js';
import { IPC_CONTRACT } from '../shared/ipc-contract.js';
import { NoTokenError, type CockpitService } from './cockpit-service.js';
import { VaultUnavailableError } from './vault.js';

type Handler = (input: unknown) => Promise<unknown>;

/** Associe chaque canal du contrat à une méthode du service. */
export function serviceHandlers(service: CockpitService): Record<IpcChannel, Handler> {
  const input = <C extends IpcChannel>(_channel: C, value: unknown) =>
    value as z.output<(typeof IPC_CONTRACT)[C]['input']>;
  return {
    'settings:get': () => Promise.resolve(service.getSettings()),
    'settings:update': (value) =>
      Promise.resolve(service.updateSettings(input('settings:update', value))),
    'token:get-masked': () => service.getMaskedToken(),
    'token:set': (value) => service.setToken(input('token:set', value).token),
    'token:clear': () => service.clearToken(),
    'token:test': () => service.testToken(),
    'status:get': () => service.getStatus(),
    'cache:rebuild': () => service.rebuildCache(),
  };
}

/** Traduit une exception en erreur structurée, sans jamais divulguer de secret. */
export function toIpcError(error: unknown): IpcErrorPayload {
  if (isGitHubError(error)) {
    return {
      code: `GITHUB_${error.kind.toUpperCase().replace(/-/g, '_')}`,
      message: error.message,
    };
  }
  if (error instanceof NoTokenError) return { code: 'NO_TOKEN', message: error.message };
  if (error instanceof VaultUnavailableError)
    return { code: 'VAULT_UNAVAILABLE', message: error.message };
  return { code: 'INTERNAL', message: 'Erreur interne du cockpit.' };
}

/**
 * Point d'entrée de tout appel IPC : canal déclaré, entrée validée,
 * sortie validée, erreurs structurées `{ code, message }`.
 */
export async function dispatchIpc(
  handlers: Record<IpcChannel, Handler>,
  channel: unknown,
  rawInput: unknown,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL', message: `Canal IPC non déclaré : ${String(channel)}.` },
    };
  }
  const contract = IPC_CONTRACT[channel];
  const parsed = contract.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: parsed.error.issues
          .map((i) => (i.path.length ? `${i.path.join('.')} : ${i.message}` : i.message))
          .join('\n'),
      },
    };
  }
  try {
    const output = contract.output.parse(await handlers[channel](parsed.data));
    return { ok: true, data: output };
  } catch (error) {
    return { ok: false, error: toIpcError(error) };
  }
}

/** Sous-ensemble d'`ipcMain` d'Electron. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: { senderFrame: { url: string } | null }, input: unknown) => unknown,
  ): void;
}

/** Enregistre les canaux ; refuse les appels qui ne viennent pas de l'interface du cockpit. */
export function registerIpc(
  ipcMain: IpcMainLike,
  handlers: Record<IpcChannel, Handler>,
  isTrustedUrl: (url: string) => boolean,
): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, input) => {
      const url = event.senderFrame?.url ?? '';
      if (!isTrustedUrl(url)) {
        return {
          ok: false,
          error: { code: 'FORBIDDEN_SENDER', message: 'Appel IPC refusé : origine non autorisée.' },
        };
      }
      return dispatchIpc(handlers, channel, input);
    });
  }
}
