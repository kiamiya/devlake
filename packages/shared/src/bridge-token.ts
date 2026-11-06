import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EditorIdSchema } from './ids.js';

/**
 * Jeton du pont Aura : `base64url(payload).base64url(hmac-sha256)`, signé avec le secret
 * partagé `AURA_BRIDGE_SECRET`. Réservé à Node (crypto) : importé par `shared/bridge-token`,
 * jamais par l'interface du cockpit.
 */
export const BridgePayloadSchema = z.object({
  /** Dépôt du projet, « owner/repo ». */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  /** Identifiant du run GitHub Actions de l'agent. */
  runId: z.string().min(1),
  /** Profil de l'agent : choisit l'éditeur et la liste blanche d'outils. */
  profile: EditorIdSchema,
  /** Expiration, en secondes depuis l'époque Unix. */
  exp: z.number().int().positive(),
  /** Émission (secondes) : l'interrupteur du cockpit révoque les jetons émis avant lui. */
  iat: z.number().int().positive().optional(),
  /**
   * Usage : session MCP d'un agent, contrôle de santé par le dispatcher, ou tests
   * d'automatisation lancés par la CI (gabarit Unreal).
   */
  scope: z.enum(['mcp', 'health', 'ci']).default('mcp'),
});
export type BridgePayload = z.infer<typeof BridgePayloadSchema>;
export type BridgePayloadInput = z.input<typeof BridgePayloadSchema>;

/** Durée de vie d'un jeton de contrôle de santé. */
export const HEALTH_TOKEN_TTL_SECONDS = 5 * 60;

/** Date d'émission d'un jeton (déduite de l'expiration pour les jetons sans `iat`). */
export function issuedAt(payload: BridgePayload): number {
  return (
    payload.iat ??
    payload.exp - (payload.scope === 'health' ? HEALTH_TOKEN_TTL_SECONDS : BRIDGE_TOKEN_TTL_SECONDS)
  );
}

/** Durée de vie par défaut d'un jeton : la durée maximale d'un job d'agent. */
export const BRIDGE_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const encode = (data: Buffer | string) => Buffer.from(data).toString('base64url');

function mac(payloadPart: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

export function signBridgeToken(payload: BridgePayloadInput, secret: string): string {
  if (secret === '') throw new Error('Secret du pont vide.');
  const part = encode(JSON.stringify(BridgePayloadSchema.parse(payload)));
  return `${part}.${encode(mac(part, secret))}`;
}

export type BridgeTokenCheck =
  | { ok: true; payload: BridgePayload }
  | { ok: false; reason: 'format' | 'signature' | 'payload' | 'expired' };

/** Vérifie un jeton : format, signature à temps constant, contenu, expiration. */
export function verifyBridgeToken(token: string, secret: string, now: Date): BridgeTokenCheck {
  const parts = token.split('.');
  const [payloadPart, signaturePart] = parts;
  if (parts.length !== 2 || !payloadPart || !signaturePart) return { ok: false, reason: 'format' };
  const expected = mac(payloadPart, secret);
  const given = Buffer.from(signaturePart, 'base64url');
  // timingSafeEqual exige des longueurs égales ; la comparaison reste à temps constant.
  const same =
    given.length === expected.length && timingSafeEqual(given, expected) && secret !== '';
  if (!same) return { ok: false, reason: 'signature' };
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }
  const parsed = BridgePayloadSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: 'payload' };
  if (parsed.data.exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed.data };
}

export const TOKEN_REFUSALS: Record<Exclude<BridgeTokenCheck, { ok: true }>['reason'], string> = {
  format: 'Jeton du pont mal formé.',
  signature: 'Jeton du pont falsifié ou signé avec un autre secret.',
  payload: 'Contenu du jeton du pont illisible.',
  expired: 'Jeton du pont expiré.',
};

/** En-tête qui porte la signature d'une réponse du pont. */
export const BRIDGE_SIGNATURE_HEADER = 'x-agentlake-signature';

/** Signe le corps exact d'une réponse du pont (HMAC-SHA256, base64url). */
export function signBridgeResponse(body: string, secret: string): string {
  if (secret === '') throw new Error('Secret du pont vide.');
  return encode(createHmac('sha256', secret).update(`response:${body}`).digest());
}

/** Vérifie la signature d'une réponse du pont, à temps constant. */
export function verifyBridgeResponse(body: string, signature: string, secret: string): boolean {
  if (secret === '') return false;
  const expected = createHmac('sha256', secret).update(`response:${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
