import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  DROPPED_FILES_CHANNEL,
  isIpcChannel,
  type AgentLakeBridge,
  type IpcResult,
} from '../shared/channels.js';

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
  // Les chemins des fichiers déposés ne sont lus qu'ici, jamais par le renderer :
  // il ne peut donc pas faire lire un fichier qu'il n'a pas reçu par glisser-déposer.
  dropFiles: (projectId, files) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file)).filter(
      (path) => path !== '',
    );
    return ipcRenderer.invoke(DROPPED_FILES_CHANNEL, { projectId, paths }) as Promise<
      IpcResult<unknown>
    >;
  },
};

contextBridge.exposeInMainWorld('agentlake', bridge);
