import { describe, expect, it } from 'vitest';
import { parseContextIndex } from './context.js';

const entry = {
  path: '.agentlake/context/brief.md',
  role: 'brief',
  source: 'Brief.docx',
  sha256: 'a'.repeat(64),
  size: 1200,
  importedAt: '2026-11-05T10:00:00.000Z',
};

describe('index du contexte', () => {
  it('accepte un index valide', () => {
    expect(parseContextIndex({ version: 1, files: [entry] })).toEqual({
      ok: true,
      value: { version: 1, files: [entry] },
    });
  });

  it.each([
    [
      'chemin hors du contexte',
      { ...entry, path: 'src/a.md' },
      'Le fichier doit être dans .agentlake/context/.',
    ],
    ['rôle inconnu', { ...entry, role: 'note' }, 'Rôle inconnu.'],
    ['empreinte invalide', { ...entry, sha256: 'xyz' }, 'Empreinte SHA-256 invalide.'],
    ['date invalide', { ...entry, importedAt: 'hier' }, 'Date ISO 8601 attendue.'],
  ])('refuse : %s', (_name, file, message) => {
    const result = parseContextIndex({ version: 1, files: [file] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it('refuse un fichier indexé deux fois et une version inconnue', () => {
    expect(parseContextIndex({ version: 1, files: [entry, entry] })).toMatchObject({
      ok: false,
      error: 'Un fichier est indexé deux fois.',
    });
    expect(parseContextIndex({ version: 2, files: [] }).ok).toBe(false);
  });
});

describe('note d’un document', () => {
  it('accepte une note et refuse une note trop longue', () => {
    expect(parseContextIndex({ version: 1, files: [{ ...entry, note: 'À relire' }] }).ok).toBe(
      true,
    );
    const long = parseContextIndex({ version: 1, files: [{ ...entry, note: 'x'.repeat(2001) }] });
    expect(!long.ok && long.error).toContain('Note trop longue');
  });
});
