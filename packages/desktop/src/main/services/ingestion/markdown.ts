import { createHash } from 'node:crypto';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { ExtractedImage } from './types.js';

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/** Image nommée par son empreinte : la même image n'est stockée qu'une fois. */
export function imageFrom(data: Uint8Array, mimeType: string): ExtractedImage {
  const extension = EXTENSIONS[mimeType] ?? 'bin';
  return { name: `${sha256(data).slice(0, 16)}.${extension}`, data, mimeType };
}

/** Markdown normalisé : LF, sans espaces de fin, au plus une ligne vide, une fin de ligne finale. */
export function normalizeMarkdown(markdown: string): string {
  const text = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? '' : `${text}\n`;
}

/** HTML (déjà assaini) → Markdown GFM : titres #, listes, tableaux, code clôturé. */
export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  service.use(gfm);
  // Listes : un seul espace après le marqueur (« - item », « 1. item »).
  service.addRule('listItem', {
    filter: 'li',
    replacement(content, node, options) {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker ?? '-'} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? '1');
        prefix = `${String(start + Array.prototype.indexOf.call(parent.children, node))}. `;
      }
      const NL = String.fromCharCode(10);
      const lines = content.split(NL);
      while (lines[0] === '') lines.shift();
      const trailing = lines.length > 0 && lines[lines.length - 1] === '';
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const indent = ' '.repeat(prefix.length);
      const body = lines.join(NL + indent) + (trailing ? NL : '');
      return prefix + body + (node.nextSibling && !body.endsWith(NL) ? NL : '');
    },
  });
  return normalizeMarkdown(service.turndown(html));
}
