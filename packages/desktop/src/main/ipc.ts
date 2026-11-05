import { GlobalConfigSyncError } from './services/global-config.js';
import { isGitHubError } from 'github';
import type { z } from 'zod';
import {
  DROPPED_FILES_CHANNEL,
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
  type IpcErrorPayload,
  type IpcResult,
} from '../shared/channels.js';
import { DroppedFilesSchema, IPC_CONTRACT } from '../shared/ipc-contract.js';
import { NoTokenError, type CockpitService } from './cockpit-service.js';
import { NotAProjectError, UnknownProjectError, type ProjectsService } from './projects-service.js';
import { BootstrapStepError, ClaudeTokenMissingError } from './services/projects/bootstrap.js';
import type { ProjectCreationService } from './services/projects/creation-service.js';
import {
  PlannerModelMissingError,
  type PlannerLaunchService,
} from './services/planner/planner-launch.js';
import { PlanError, type PlanService } from './services/plan/plan-service.js';
import {
  PublicRepoNotAcknowledgedError,
  UnknownFileError,
  type ContextService,
} from './services/ingestion/context-service.js';
import { UnknownDocumentError } from './services/ingestion/context-ops.js';
import { FileTooLargeError, InvalidContextIndexError } from './services/ingestion/deposit.js';
import { UnsupportedFormatError } from './services/ingestion/types.js';
import { VaultUnavailableError } from './vault.js';

type Handler = (input: unknown) => Promise<unknown>;

/** Associe chaque canal du contrat à une méthode du service. */
export function serviceHandlers(services: {
  cockpit: CockpitService;
  projects: ProjectsService;
  creation: ProjectCreationService;
  context: ContextService;
  planner: PlannerLaunchService;
  plan: PlanService;
}): Record<IpcChannel, Handler> {
  const { cockpit: service, projects, creation, context, planner, plan } = services;
  const input = <C extends IpcChannel>(_channel: C, value: unknown) =>
    value as z.output<(typeof IPC_CONTRACT)[C]['input']>;
  return {
    'settings:get': () => Promise.resolve(service.getSettings()),
    'settings:update': (value) => service.updateSettings(input('settings:update', value)),
    'token:get-masked': () => service.getMaskedToken(),
    'token:set': (value) => service.setToken(input('token:set', value).token),
    'token:clear': () => service.clearToken(),
    'token:test': () => service.testToken(),
    'status:get': () => service.getStatus(),
    'cache:rebuild': () => service.rebuildCache(),
    'projects:list': () => Promise.resolve(projects.list()),
    'projects:discover': () => projects.discover(),
    'projects:open': (value) => projects.open(input('projects:open', value)),
    'projects:sync': (value) => projects.sync(input('projects:sync', value).projectId),
    'tabs:get': () => Promise.resolve(projects.getTabs()),
    'tabs:save': (value) => Promise.resolve(projects.saveTabs(input('tabs:save', value))),
    'activity:get': () => Promise.resolve(projects.activity()),
    'claude-token:get-masked': () => service.getMaskedClaudeToken(),
    'claude-token:set': (value) => service.setClaudeToken(input('claude-token:set', value).token),
    'claude-token:clear': () => service.clearClaudeToken(),
    'projects:create': (value) => creation.create(input('projects:create', value)),
    'context:choose-files': (value) =>
      context.chooseFiles(input('context:choose-files', value).projectId),
    'context:import': (value) => context.import(input('context:import', value)),
    'context:list': (value) => context.list(input('context:list', value).projectId),
    'context:preview': (value) => {
      const { projectId, path } = input('context:preview', value);
      return context.preview(projectId, path);
    },
    'context:preview-staged': (value) =>
      context.previewStaged(input('context:preview-staged', value).tokens),
    'context:set-role': (value) => {
      const { projectId, path, role } = input('context:set-role', value);
      return context.setRole(projectId, path, role);
    },
    'context:set-note': (value) => {
      const { projectId, path, note } = input('context:set-note', value);
      return context.setNote(projectId, path, note);
    },
    'context:remove': (value) => {
      const { projectId, path } = input('context:remove', value);
      return context.remove(projectId, path);
    },
    'context:decisions': (value) => context.decisions(input('context:decisions', value).projectId),
    'planner:start': (value) => planner.start(input('planner:start', value)),
    'plan:versions': (value) => plan.versions(input('plan:versions', value).projectId),
    'plan:get': (value) => {
      const { projectId, version } = input('plan:get', value);
      return plan.get(projectId, version);
    },
    'plan:save': (value) => {
      const { projectId, version, plan: edited } = input('plan:save', value);
      return plan.save(projectId, version, edited);
    },
    'plan:set-cap': (value) => {
      const { projectId, cap } = input('plan:set-cap', value);
      return plan.setProjectCap(projectId, cap);
    },
    'plan:validate': (value) => {
      const { projectId, version } = input('plan:validate', value);
      return plan.validate(projectId, version);
    },
    'projects:bootstrap': (value) =>
      creation.rebootstrap(input('projects:bootstrap', value).projectId),
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
  if (error instanceof NotAProjectError) return { code: 'NOT_A_PROJECT', message: error.message };
  if (error instanceof ClaudeTokenMissingError)
    return { code: 'CLAUDE_TOKEN_MISSING', message: error.message };
  const known: [new (...args: never[]) => Error, string][] = [
    [PublicRepoNotAcknowledgedError, 'PUBLIC_REPO_NOT_ACKNOWLEDGED'],
    [UnknownFileError, 'UNKNOWN_FILE'],
    [FileTooLargeError, 'FILE_TOO_LARGE'],
    [UnsupportedFormatError, 'UNSUPPORTED_FORMAT'],
    [InvalidContextIndexError, 'INVALID_CONTEXT_INDEX'],
    [UnknownDocumentError, 'UNKNOWN_DOCUMENT'],
    [PlannerModelMissingError, 'PLANNER_MODEL_MISSING'],
    [PlanError, 'PLAN_ERROR'],
    [GlobalConfigSyncError, 'GLOBAL_CONFIG_SYNC_FAILED'],
  ];
  for (const [type, code] of known)
    if (error instanceof type) return { code, message: error.message };
  if (error instanceof BootstrapStepError)
    return { code: 'BOOTSTRAP_STEP_FAILED', message: error.message };
  if (error instanceof UnknownProjectError)
    return { code: 'UNKNOWN_PROJECT', message: error.message };
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

/** Canal réservé au preload : fichiers déposés dans le cockpit (chemins issus de webUtils). */
export async function handleDroppedFiles(
  context: ContextService,
  raw: unknown,
): Promise<IpcResult<unknown>> {
  const parsed = DroppedFilesSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: parsed.error.issues.map((i) => i.message).join('\n'),
      },
    };
  }
  try {
    return {
      ok: true,
      data: await context.registerDropped(parsed.data.projectId, parsed.data.paths),
    };
  } catch (error) {
    return { ok: false, error: toIpcError(error) };
  }
}

export function registerDroppedFiles(
  ipcMain: IpcMainLike,
  context: ContextService,
  isTrustedUrl: (url: string) => boolean,
): void {
  ipcMain.handle(DROPPED_FILES_CHANNEL, (event, input) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? '')) {
      return {
        ok: false,
        error: { code: 'FORBIDDEN_SENDER', message: 'Appel IPC refusé : origine non autorisée.' },
      };
    }
    return handleDroppedFiles(context, input);
  });
}
