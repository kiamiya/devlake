import { z } from 'zod';

// Messages d'erreur zod en français (textes destinés à Kia et renvoyés au modèle).
z.config(z.locales.fr());

/** Résultat d'un parseur : jamais d'exception, une erreur lisible en français. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Marqueur réservé aux blocs cachés d'AgentLake dans le Markdown. */
export const HIDDEN_MARKER = '<!-- agentlake:';

/** Texte non vide, sans espace de début ou de fin, sans retour chariot ni marqueur caché. */
export function cleanText(label: string) {
  return z
    .string()
    .refine((s) => s.trim().length > 0, `${label} ne peut pas être vide.`)
    .refine((s) => s === s.trim(), `${label} ne doit pas commencer ni finir par un espace.`)
    .refine((s) => !s.includes('\r'), `${label} doit utiliser des fins de ligne LF.`)
    .refine(
      (s) => !s.includes(HIDDEN_MARKER),
      `${label} ne doit pas contenir « ${HIDDEN_MARKER} ».`,
    );
}

/** Comme cleanText, sur une seule ligne. */
export function cleanLine(label: string) {
  return cleanText(label).refine((s) => !s.includes('\n'), `${label} doit tenir sur une ligne.`);
}

/** Formate les erreurs zod : « chemin : message » par ligne. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path} : ${issue.message}` : issue.message;
    })
    .join('\n');
}

export function safeParseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: formatZodError(result.error) };
}

const BACKSLASH = String.fromCharCode(92);

/** Encode du JSON pour un commentaire HTML : aucun « < » ni « > » ne subsiste. */
export function encodeHiddenJson(value: unknown): string {
  // Les chevrons deviennent des échappements unicode JSON, que JSON.parse restitue tels quels.
  return JSON.stringify(value)
    .replace(/</g, `${BACKSLASH}u003c`)
    .replace(/>/g, `${BACKSLASH}u003e`);
}

/** Lit les attributs « clé=valeur » d'un en-tête caché. */
export function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(/([A-Za-z][\w-]*)=(\S+)/g)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) attributes.set(key, value);
  }
  return attributes;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
