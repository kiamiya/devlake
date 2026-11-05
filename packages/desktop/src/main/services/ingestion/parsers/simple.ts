import { PDFParse } from 'pdf-parse';
import { basename, extname } from 'node:path';
import { IMAGE_MIME_BY_EXTENSION, imageFrom, normalizeMarkdown } from '../markdown.js';
import type { DocumentParser, ParsedDocument, SourceFile } from '../types.js';

/** Texte UTF-8 sans marque d'ordre des octets (BOM) initiale. */
const text = (file: SourceFile) => {
  const content = Buffer.from(file.data).toString('utf8');
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
};

export const markdownParser: DocumentParser = {
  id: 'md',
  extensions: ['md', 'markdown'],
  parse: (file) =>
    Promise.resolve({ markdown: normalizeMarkdown(text(file)), images: [], warnings: [] }),
};

export const textParser: DocumentParser = {
  id: 'txt',
  extensions: ['txt'],
  parse: (file) =>
    Promise.resolve({ markdown: normalizeMarkdown(text(file)), images: [], warnings: [] }),
};

export const OCR_WARNING =
  'OCR nécessaire : le PDF ne contient pas de texte extractible (document scanné ?).';

/** PDF → texte (pdf-parse) ; sans texte, signalé « OCR nécessaire ». */
export const pdfParser: DocumentParser = {
  id: 'pdf',
  extensions: ['pdf'],
  async parse(file: SourceFile): Promise<ParsedDocument> {
    const parser = new PDFParse({ data: new Uint8Array(file.data) });
    try {
      const result = await parser.getText();
      const content = normalizeMarkdown(result.text.replace(/\n-- \d+ of \d+ --\n?/g, '\n\n'));
      if (content === '') {
        return {
          markdown: `> ${OCR_WARNING}\n`,
          images: [],
          warnings: [`${file.name} : ${OCR_WARNING}`],
        };
      }
      return { markdown: content, images: [], warnings: [] };
    } finally {
      await parser.destroy();
    }
  },
};

/** Image autonome : stockée dans `assets/` et référencée par une page Markdown. */
export const imageParser: DocumentParser = {
  id: 'image',
  extensions: Object.keys(IMAGE_MIME_BY_EXTENSION),
  parse(file: SourceFile): Promise<ParsedDocument> {
    const extension = extname(file.name).slice(1).toLowerCase();
    const image = imageFrom(
      file.data,
      IMAGE_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
    );
    const title = basename(file.name, extname(file.name));
    return Promise.resolve({
      markdown: `![${title}](assets/${image.name})\n`,
      images: [image],
      warnings: [],
    });
  },
};
