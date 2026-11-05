import { z } from 'zod';
import type { IpcChannel } from './channels.js';
import { SettingsPatchSchema, SettingsSchema } from './settings.js';

export const IntegrationStateSchema = z.enum(['ok', 'degraded', 'absent']);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const IntegrationStatusSchema = z.object({
  id: z.enum(['github', 'aura']),
  label: z.string(),
  state: IntegrationStateSchema,
  detail: z.string(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

const MaskedTokenSchema = z.object({ masked: z.string().nullable() });

const NoInput = z.undefined();

/** Contrat de chaque canal : entrée et sortie validées des deux côtés. */
export const IPC_CONTRACT = {
  'settings:get': { input: NoInput, output: SettingsSchema },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'token:get-masked': { input: NoInput, output: MaskedTokenSchema },
  'token:set': {
    input: z.object({ token: z.string().trim().min(1, 'Le jeton est vide.') }),
    output: MaskedTokenSchema,
  },
  'token:clear': { input: NoInput, output: MaskedTokenSchema },
  'token:test': { input: NoInput, output: z.object({ login: z.string() }) },
  'status:get': { input: NoInput, output: z.array(IntegrationStatusSchema) },
  'cache:rebuild': {
    input: NoInput,
    output: z.object({ projects: z.number(), issues: z.number(), runs: z.number() }),
  },
} as const satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>;

export type IpcInput<C extends IpcChannel> = z.input<(typeof IPC_CONTRACT)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<(typeof IPC_CONTRACT)[C]['output']>;
