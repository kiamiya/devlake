import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

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
  profile: z.enum(['unity', 'unreal']),
  /** Expiration, en secondes depuis l'époque Unix. */
  exp: z.number().int().positive(),
});
export type BridgePayload = z.infer<typeof BridgePayloadSchema>;

/** Durée de vie par défaut d'un jeton : la durée maximale d'un job d'agent. */
export const BRIDGE_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const encode = (data: Buffer | string) => Buffer.from(data).toString('base64url');

function mac(payloadPart: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

export function signBridgeToken(payload: BridgePayload, secret: string): string {
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
