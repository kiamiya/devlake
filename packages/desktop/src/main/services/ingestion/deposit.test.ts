import { FakeGitHub, lfsPointerOf } from 'github';
import { CONTEXT_INDEX_PATH, ContextIndexSchema } from 'shared';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  depositContext,
  FileTooLargeError,
  InvalidContextIndexError,
  type ImportItem,
} from './deposit.js';
import { defaultRegistry } from './registry.js';
import { UnsupportedFormatError } from './types.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const fixture = (name: string) => ({
  name,
  data: new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))),
});
const options = {
  registry: defaultRegistry(),
  maxBytes: 50 * 1024 * 1024,
  now: () => '2026-11-05T10:00:00.000Z',
};

let github: FakeGitHub;
beforeEach(() => {
  github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
});

async function index() {
  const file = await github.getFile(ref, CONTEXT_INDEX_PATH);
  return ContextIndexSchema.parse(JSON.parse(file?.content ?? '{}'));
}

describe('versement du contexte', () => {
  it('verse un brief docx en un commit : Markdown, image en LFS, index', async () => {
    const commitsBefore = github.state(ref).commits.size;
    const result = await depositContext(
      github,
      ref,
      [{ file: fixture('brief.docx'), role: 'brief' }],
      options,
    );

    expect(result).toMatchObject({
      committed: true,
      imported: [{ source: 'brief.docx', path: '.agentlake/context/brief.md', role: 'brief' }],
      skipped: [],
    });
    expect(github.state(ref).commits.size).toBe(commitsBefore + 1);

    const brief = (await github.getFile(ref, '.agentlake/context/brief.md'))?.content ?? '';
    const image = /!\[\]\((assets\/[0-9a-f]{16}\.png)\)/.exec(brief)?.[1];
    expect(image).toBeDefined();

    // Le lien d'image est valide : un pointeur LFS vers l'image envoyée.
    const logo = new Uint8Array(readFileSync(new URL('./__fixtures__/logo.png', import.meta.url)));
    const pointer = await github.getFile(ref, `.agentlake/context/${image ?? ''}`);
    expect(pointer?.content).toContain(`oid sha256:${lfsPointerOf(logo).oid}`);
    expect(github.state(ref).lfs.get(lfsPointerOf(logo).oid)).toEqual(logo);

    const entries = (await index()).files;
    expect(entries.map((e) => [e.path, e.role])).toEqual([
      ['.agentlake/context/assets/' + (image ?? '').replace('assets/', ''), 'asset'],
      ['.agentlake/context/brief.md', 'brief'],
    ]);
    expect(entries[1]).toMatchObject({
      source: 'brief.docx',
      importedAt: '2026-11-05T10:00:00.000Z',
    });
  });

  it('réimporter le même fichier ne crée pas de commit', async () => {
    await depositContext(github, ref, [{ file: fixture('brief.docx'), role: 'brief' }], options);
    const commits = github.state(ref).commits.size;
    const uploads = github.state(ref).lfsUploads;

    const again = await depositContext(
      github,
      ref,
      [{ file: { ...fixture('brief.docx'), name: 'copie.docx' }, role: 'annex' }],
      options,
    );
    expect(again).toEqual({
      committed: false,
      commitSha: null,
      imported: [],
      skipped: [{ source: 'copie.docx', reason: 'déjà importé (même contenu)' }],
      warnings: [],
    });
    expect(github.state(ref).commits.size).toBe(commits);
    expect(github.state(ref).lfsUploads).toBe(uploads);
  });

  it('déduplique aussi dans un même import et range les annexes', async () => {
    const items: ImportItem[] = [
      { file: fixture('annexe.pdf'), role: 'annex' },
      { file: { ...fixture('annexe.pdf'), name: 'doublon.pdf' }, role: 'annex' },
      { file: fixture('page.html'), role: 'annex' },
      { file: fixture('logo.png'), role: 'annex' },
    ];
    const result = await depositContext(github, ref, items, options);
    expect(result.imported.map((i) => i.path)).toEqual([
      '.agentlake/context/annexes/annexe.md',
      '.agentlake/context/annexes/page.md',
      '.agentlake/context/annexes/logo.md',
    ]);
    expect(result.skipped).toEqual([
      { source: 'doublon.pdf', reason: 'déjà importé (même contenu)' },
    ]);
    // Depuis annexes/, les images sont référencées en ../assets/.
    expect((await github.getFile(ref, '.agentlake/context/annexes/logo.md'))?.content).toMatch(
      /^!\[logo\]\(\.\.\/assets\/[0-9a-f]{16}\.png\)\n$/,
    );
    // Le logo intégré au HTML et l'image seule sont le même fichier : un seul envoi LFS.
    expect(github.state(ref).lfsUploads).toBe(1);
  });

  it('un nouveau brief remplace l’ancien ; une annexe homonyme reçoit un suffixe', async () => {
    await depositContext(github, ref, [{ file: fixture('notes.md'), role: 'brief' }], options);
    await depositContext(
      github,
      ref,
      [
        { file: fixture('notes.txt'), role: 'brief' },
        { file: { name: 'notes.md', data: new TextEncoder().encode('# Autre\n') }, role: 'annex' },
        { file: { name: 'notes.md', data: new TextEncoder().encode('# Encore\n') }, role: 'annex' },
      ],
      options,
    );
    const entries = (await index()).files;
    expect(entries.filter((e) => e.role === 'brief')).toEqual([
      expect.objectContaining({ source: 'notes.txt' }),
    ]);
    expect((await github.getFile(ref, '.agentlake/context/brief.md'))?.content).toBe(
      'Notes en texte brut.\nDeuxième ligne.\n',
    );
    expect(entries.filter((e) => e.role === 'annex').map((e) => e.path)).toEqual([
      '.agentlake/context/annexes/notes-2.md',
      '.agentlake/context/annexes/notes.md',
    ]);
  });

  it('remonte l’avertissement « OCR nécessaire »', async () => {
    const result = await depositContext(
      github,
      ref,
      [{ file: fixture('scan.pdf'), role: 'gdd' }],
      options,
    );
    expect(result.warnings).toEqual([expect.stringContaining('OCR nécessaire')]);
    expect(result.imported[0]?.path).toBe('.agentlake/context/gdd.md');
  });

  it('refuse un fichier trop gros ou d’un format inconnu avant tout versement', async () => {
    await expect(
      depositContext(github, ref, [{ file: fixture('brief.docx'), role: 'brief' }], {
        ...options,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(FileTooLargeError);
    await expect(
      depositContext(
        github,
        ref,
        [{ file: { name: 'a.xlsx', data: new Uint8Array(1) }, role: 'annex' }],
        options,
      ),
    ).rejects.toThrow(UnsupportedFormatError);
    expect(await github.getFile(ref, CONTEXT_INDEX_PATH)).toBeNull();
  });

  it('refuse un index existant invalide', async () => {
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'cassé',
      changes: [{ path: CONTEXT_INDEX_PATH, content: '{ pas du json' }],
    });
    await expect(
      depositContext(github, ref, [{ file: fixture('notes.md'), role: 'brief' }], options),
    ).rejects.toThrow(InvalidContextIndexError);
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'cassé',
      changes: [{ path: CONTEXT_INDEX_PATH, content: '{"version":1,"files":[{"path":"x"}]}' }],
    });
    await expect(
      depositContext(github, ref, [{ file: fixture('notes.md'), role: 'brief' }], options),
    ).rejects.toThrow('context.json est invalide');
  });
});
