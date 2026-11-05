import { contextBridge, ipcRenderer } from 'electron';
import { isIpcChannel, type AgentLakeBridge, type IpcResult } from '../shared/channels.js';

/** Seuls les canaux déclarés sont exposés au renderer, sous `window.agentlake`. */
const bridge: AgentLakeBridge = {
  invoke: (channel, input) => {
    if (!isIpcChannel(channel)) {
      return Promise.resolve<IpcResult<unknown>>({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: `Canal IPC non déclaré : ${String(channel)}.` },
      });
    }
    return ipcRenderer.invoke(channel, input) as Promise<IpcResult<unknown>>;
  },
};

contextBridge.exposeInMainWorld('agentlake', bridge);
