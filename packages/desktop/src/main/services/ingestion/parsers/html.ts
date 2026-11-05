import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown, imageFrom } from '../markdown.js';
import type { DocumentParser, ExtractedImage, ParsedDocument, SourceFile } from '../types.js';

const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Tableaux lisibles par turndown-plugin-gfm : la première ligne devient l'en-tête
 * si aucune n'est marquée (cas de mammoth), et les paragraphes des cellules sont aplatis.
 */
function prepareTables(document: Document): void {
  for (const table of document.querySelectorAll('table')) {
    for (const p of table.querySelectorAll('td p, th p')) {
      p.replaceWith(...Array.from(p.childNodes), document.createTextNode(' '));
    }
    const first = table.querySelector('tr');
    if (first && !table.querySelector('th, thead')) {
      for (const cell of Array.from(first.querySelectorAll('td'))) {
        const th = document.createElement('th');
        th.innerHTML = cell.innerHTML;
        cell.replaceWith(th);
      }
    }
  }
}

/**
 * Assainit le HTML (DOMPurify), puis remplace les images en data URI par
 * des fichiers `assets/<empreinte>` ; renvoie le HTML prêt pour turndown.
 */
export function sanitizeAndExtract(html: string): { html: string; images: ExtractedImage[] } {
  const { window } = new JSDOM('');
  const purify = createDOMPurify(window);
  const clean = purify.sanitize(html, {
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
  const dom = new JSDOM(`<body>${clean}</body>`);
  const images = new Map<string, ExtractedImage>();
  for (const img of dom.window.document.querySelectorAll('img')) {
    const match = DATA_URI.exec(img.getAttribute('src') ?? '');
    if (match) {
      const [, mime = '', base64 = ''] = match;
      const image = imageFrom(new Uint8Array(Buffer.from(base64, 'base64')), mime.toLowerCase());
      images.set(image.name, image);
      img.setAttribute('src', `assets/${image.name}`);
    } else if (!/^(https?:\/\/|assets\/)/i.test(img.getAttribute('src') ?? '')) {
      // Image locale introuvable depuis un fichier isolé : on la retire.
      // (Les images déjà extraites, comme celles du docx, pointent vers assets/.)
      img.remove();
    }
  }
  prepareTables(dom.window.document);
  return { html: dom.window.document.body.innerHTML, images: [...images.values()] };
}

export const htmlParser: DocumentParser = {
  id: 'html',
  extensions: ['html', 'htm'],
  parse(file: SourceFile): Promise<ParsedDocument> {
    const { html, images } = sanitizeAndExtract(Buffer.from(file.data).toString('utf8'));
    return Promise.resolve({ markdown: htmlToMarkdown(html), images, warnings: [] });
  },
};
