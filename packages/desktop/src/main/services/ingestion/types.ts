/** Image extraite d'un document ou importée seule. */
export interface ExtractedImage {
  /** Nom de fichier final dans `assets/` : empreinte et extension. */
  name: string;
  data: Uint8Array;
  mimeType: string;
}

/** Résultat d'un parseur : Markdown normalisé et images référencées par `assets/<nom>`. */
export interface ParsedDocument {
  markdown: string;
  images: ExtractedImage[];
  /** Avertissements pour Kia (ex. « OCR nécessaire »). */
  warnings: string[];
}

export interface SourceFile {
  name: string;
  data: Uint8Array;
}

/** Un parseur par format, enregistré dans le registre. */
export interface DocumentParser {
  /** Identifiant lisible, ex. « docx ». */
  readonly id: string;
  /** Extensions gérées, en minuscules et sans point. */
  readonly extensions: readonly string[];
  parse(file: SourceFile): Promise<ParsedDocument>;
}

export class UnsupportedFormatError extends Error {
  constructor(name: string) {
    super(
      `Format non pris en charge : ${name}. Formats acceptés : docx, html, md, txt, pdf et images.`,
    );
    this.name = 'UnsupportedFormatError';
  }
}
