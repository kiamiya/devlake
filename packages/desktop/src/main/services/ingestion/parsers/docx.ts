import mammoth from 'mammoth';
import { htmlToMarkdown, imageFrom } from '../markdown.js';
import type { DocumentParser, ExtractedImage, ParsedDocument, SourceFile } from '../types.js';
import { sanitizeAndExtract } from './html.js';

/** docx → HTML (mammoth, images extraites) → assainissement → Markdown (turndown). */
export const docxParser: DocumentParser = {
  id: 'docx',
  extensions: ['docx'],
  async parse(file: SourceFile): Promise<ParsedDocument> {
    const images = new Map<string, ExtractedImage>();
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(file.data) },
      {
        convertImage: mammoth.images.imgElement(async (element) => {
          const data = new Uint8Array(await element.readAsBuffer());
          const image = imageFrom(data, element.contentType);
          images.set(image.name, image);
          return { src: `assets/${image.name}` };
        }),
      },
    );
    const { html } = sanitizeAndExtract(result.value);
    const warnings = result.messages
      .filter((m) => m.type === 'warning')
      .map((m) => `Conversion docx : ${m.message}`);
    return { markdown: htmlToMarkdown(html), images: [...images.values()], warnings };
  },
};
