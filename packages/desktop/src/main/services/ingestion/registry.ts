import { extname } from 'node:path';
import { docxParser } from './parsers/docx.js';
import { htmlParser } from './parsers/html.js';
import { imageParser, markdownParser, pdfParser, textParser } from './parsers/simple.js';
import { UnsupportedFormatError, type DocumentParser } from './types.js';

/** Registre des parseurs, par extension de fichier. */
export class ParserRegistry {
  private readonly byExtension = new Map<string, DocumentParser>();

  register(parser: DocumentParser): this {
    for (const extension of parser.extensions)
      this.byExtension.set(extension.toLowerCase(), parser);
    return this;
  }

  forFile(name: string): DocumentParser {
    const parser = this.byExtension.get(extname(name).slice(1).toLowerCase());
    if (!parser) throw new UnsupportedFormatError(name);
    return parser;
  }

  extensions(): string[] {
    return [...this.byExtension.keys()].sort();
  }
}

export function defaultRegistry(): ParserRegistry {
  return new ParserRegistry()
    .register(docxParser)
    .register(htmlParser)
    .register(markdownParser)
    .register(textParser)
    .register(pdfParser)
    .register(imageParser);
}
