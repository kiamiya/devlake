import type { McpServerSpec } from 'aura-bridge';
import { isSecretName, type SecretVault } from '../../vault.js';

/** Valeur remplacée par un secret du coffre au démarrage du pont. */
export const SECRET_REF = /^\{\{coffre:(mcp-secret-[0-9a-f]{16})\}\}$/;
/** Clés d'environnement ou d'en-tête considérées comme sensibles. */
export const SECRET_KEY = /key|token|secret|password|passwd|auth|bearer|credential|cookie/i;

export class McpImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpImportError';
  }
}

/** Remplace les références au coffre (`{{coffre:…}}`) de l'environnement et des en-têtes. */
export async function resolveSecrets(
  spec: McpServerSpec,
  vault: SecretVault,
): Promise<McpServerSpec> {
  const resolve = async (values: Record<string, string> | undefined) => {
    if (values === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const ref = SECRET_REF.exec(value)?.[1];
      if (ref === undefined || !isSecretName(ref)) {
        out[key] = value;
        continue;
      }
      const secret = await vault.get(ref);
      if (secret === null)
        throw new McpImportError(`Secret « ${key} » absent du coffre : réimporter ce serveur MCP.`);
      out[key] = secret;
    }
    return out;
  };
  if (spec.kind === 'stdio') {
    const env = await resolve(spec.env);
    return env === undefined ? spec : { ...spec, env };
  }
  const headers = await resolve(spec.headers);
  return headers === undefined ? spec : { ...spec, headers };
}
