import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeMarkdown, sha256 } from './markdown.js';
import { sanitizeAndExtract } from './parsers/html.js';
import { OCR_WARNING } from './parsers/simple.js';
import { defaultRegistry, ParserRegistry } from './registry.js';
import { UnsupportedFormatError } from './types.js';

const fixture = (name: string) => ({
  name,
  data: new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))),
});
const registry = defaultRegistry();
const parse = (name: string) => registry.forFile(name).parse(fixture(name));

describe('registre des parseurs', () => {
  it('choisit le parseur par extension, sans tenir compte de la casse', () => {
    expect(registry.forFile('Brief.DOCX').id).toBe('docx');
    expect(registry.forFile('page.htm').id).toBe('html');
    expect(registry.forFile('photo.JPG').id).toBe('image');
    expect(registry.extensions()).toEqual(
      expect.arrayContaining(['docx', 'html', 'md', 'txt', 'pdf', 'png', 'jpg']),
    );
  });

  it('refuse un format inconnu avec un message clair', () => {
    expect(() => registry.forFile('tableur.xlsx')).toThrow(UnsupportedFormatError);
    expect(() => new ParserRegistry().forFile('a.md')).toThrow('Format non pris en charge : a.md.');
  });
});

describe('docx', () => {
  it('rend titres, emphase, listes, tableau et image (régression)', async () => {
    const doc = await parse('brief.docx');
    expect(doc.markdown).toMatchSnapshot();
    expect(doc.markdown).toContain('# Brief — Application de réservation');
    expect(doc.markdown).toContain('## Objectifs');
    expect(doc.markdown).toMatch(/\*\*fictive\*\*/);
    expect(doc.markdown).toMatch(/\*coiffure\*/);
    expect(doc.markdown).toMatch(/^- Réserver en moins d’une minute$/m);
    expect(doc.markdown).toMatch(/^1\. +Choisir un salon$/m);
    expect(doc.markdown).toMatch(/\| Coupe \| 30 min \| 25 € \|/);

    const logo = readFileSync(new URL('./__fixtures__/logo.png', import.meta.url));
    expect(doc.images).toEqual([
      {
        name: `${sha256(logo).slice(0, 16)}.png`,
        data: new Uint8Array(logo),
        mimeType: 'image/png',
      },
    ]);
    expect(doc.markdown).toContain(`](assets/${doc.images[0]?.name ?? ''})`);
  });
});

describe('html', () => {
  it('neutralise scripts, gestionnaires, liens javascript et iframes (sécurité)', async () => {
    const doc = await parse('page.html');
    expect(doc.markdown).toMatchSnapshot();
    for (const forbidden of [
      'alert',
      'voler',
      'javascript:',
      'onerror',
      'onclick',
      'iframe',
      'display: none',
    ]) {
      expect(doc.markdown).not.toContain(forbidden);
    }
    expect(doc.markdown).toContain('[lien sûr](https://example.com/doc)');
    expect(doc.markdown).toContain('| Col A | Col B |');
    expect(doc.images).toHaveLength(1);
    expect(doc.markdown).toContain(`![logo intégré](assets/${doc.images[0]?.name ?? ''})`);
    expect(doc.markdown).not.toContain('data:image');
  });

  it('garde les images distantes et retire les images locales', () => {
    const { html } = sanitizeAndExtract(
      '<img src="https://example.com/a.png" alt="a"><img src="b.png" alt="b">',
    );
    expect(html).toContain('https://example.com/a.png');
    expect(html).not.toContain('b.png');
  });
});

describe('md, txt, pdf et images', () => {
  it('normalise le Markdown (régression)', async () => {
    const doc = await parse('notes.md');
    expect(doc.markdown).toBe('# Notes\n\n- Point **un**\n- Point deux\n\nFin.\n');
  });

  it('reprend le texte brut', async () => {
    expect((await parse('notes.txt')).markdown).toBe('Notes en texte brut.\nDeuxième ligne.\n');
  });

  it('extrait le texte d’un PDF (régression)', async () => {
    const doc = await parse('annexe.pdf');
    expect(doc.warnings).toEqual([]);
    expect(doc.markdown).toMatchSnapshot();
    expect(doc.markdown).toContain('Annexe technique');
  });

  it('signale « OCR nécessaire » pour un PDF sans texte', async () => {
    const doc = await parse('scan.pdf');
    expect(doc.warnings).toEqual([`scan.pdf : ${OCR_WARNING}`]);
    expect(doc.markdown).toBe(`> ${OCR_WARNING}\n`);
  });

  it('référence une image autonome dans assets/', async () => {
    const doc = await parse('logo.png');
    expect(doc.images).toHaveLength(1);
    expect(doc.markdown).toBe(`![logo](assets/${doc.images[0]?.name ?? ''})\n`);
  });

  it('normalise les fins de ligne et lignes vides', () => {
    expect(normalizeMarkdown('a  \r\n\r\n\r\n\r\nb\t')).toBe('a\n\nb\n');
    expect(normalizeMarkdown(' \n ')).toBe('');
  });
});
