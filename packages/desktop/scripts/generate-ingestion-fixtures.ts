/**
 * Génère les fichiers de démonstration (contenu fictif) des tests d'ingestion.
 * Usage : npx tsx packages/desktop/scripts/generate-ingestion-fixtures.ts
 * Les fichiers produits sont commités ; relancer ce script seulement pour les changer.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  type IRunOptions,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const out = fileURLToPath(new URL('../src/main/services/ingestion/__fixtures__/', import.meta.url));
mkdirSync(out, { recursive: true });

/** PNG valide généré sans dépendance : dégradé de 16 × 16 pixels. */
function png(width = 16, height = 16): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // profondeur
  header.writeUInt8(2, 9); // RVB
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) rows.push(x * 16, y * 16, 160);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = png();
writeFileSync(join(out, 'logo.png'), image);

// Brief docx : titres, gras, italique, listes à puces et numérotées, tableau, image.
// Options typées : TextRun accepte aussi une chaîne, ce qui ferait confondre bold avec String.prototype.bold.
const strong: IRunOptions = { text: 'fictive', bold: true };
const emphasis: IRunOptions = { text: 'coiffure', italics: true };
const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'etapes',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
        ],
      },
    ],
  },
  sections: [
    {
      children: [
        new Paragraph({
          text: 'Brief — Application de réservation',
          heading: HeadingLevel.HEADING_1,
        }),
        new Paragraph({
          children: [
            new TextRun('Une application '),
            new TextRun(strong),
            new TextRun(' pour réserver un créneau de '),
            new TextRun(emphasis),
            new TextRun('.'),
          ],
        }),
        new Paragraph({ text: 'Objectifs', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'Réserver en moins d’une minute', bullet: { level: 0 } }),
        new Paragraph({ text: 'Rappel par e-mail la veille', bullet: { level: 0 } }),
        new Paragraph({ text: 'Parcours', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'Choisir un salon', numbering: { reference: 'etapes', level: 0 } }),
        new Paragraph({ text: 'Choisir un créneau', numbering: { reference: 'etapes', level: 0 } }),
        new Paragraph({ text: 'Confirmer', numbering: { reference: 'etapes', level: 0 } }),
        new Paragraph({ text: 'Tarifs', heading: HeadingLevel.HEADING_2 }),
        new Table({
          rows: [
            ['Prestation', 'Durée', 'Prix'],
            ['Coupe', '30 min', '25 €'],
            ['Couleur', '90 min', '60 €'],
          ].map(
            (cells) =>
              new TableRow({
                children: cells.map((text) => new TableCell({ children: [new Paragraph(text)] })),
              }),
          ),
        }),
        new Paragraph({ text: 'Maquette', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({
          children: [
            new ImageRun({ type: 'png', data: image, transformation: { width: 64, height: 64 } }),
          ],
        }),
      ],
    },
  ],
});
writeFileSync(join(out, 'brief.docx'), await Packer.toBuffer(doc));

// PDF avec texte.
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([400, 300]);
page.drawText('Annexe technique', { x: 40, y: 250, size: 18, font });
page.drawText('Base de donnees : Supabase. Hebergement : Vercel.', {
  x: 40,
  y: 220,
  size: 11,
  font,
});
pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
writeFileSync(join(out, 'annexe.pdf'), await pdf.save());

// PDF sans texte (scan) : OCR nécessaire.
const scan = await PDFDocument.create();
scan
  .addPage([400, 300])
  .drawRectangle({ x: 50, y: 50, width: 300, height: 200, color: rgb(0.8, 0.8, 0.8) });
scan.setCreationDate(new Date('2026-01-01T00:00:00Z'));
scan.setModificationDate(new Date('2026-01-01T00:00:00Z'));
writeFileSync(join(out, 'scan.pdf'), await scan.save());

// HTML avec contenus dangereux à neutraliser.
writeFileSync(
  join(out, 'page.html'),
  `<!doctype html>
<html lang="fr"><head><title>Page</title><script>alert('tête')</script></head>
<body>
<h1>Page d’accueil</h1>
<p onclick="voler()">Texte <strong>important</strong> et <a href="javascript:voler()">lien piégé</a> et <a href="https://example.com/doc">lien sûr</a>.</p>
<ul><li>Premier</li><li>Second</li></ul>
<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<img src="x" onerror="voler()" alt="piège">
<img src="data:image/png;base64,${image.toString('base64')}" alt="logo intégré">
<iframe src="https://example.com"></iframe>
<style>body { display: none }</style>
</body></html>
`,
);

writeFileSync(
  join(out, 'notes.md'),
  '# Notes\r\n\r\n- Point **un**\r\n- Point deux   \r\n\r\n\r\n\r\nFin.',
);
writeFileSync(join(out, 'notes.txt'), 'Notes en texte brut.\nDeuxième ligne.\n');

console.log(`Fixtures générées dans ${out}`);
