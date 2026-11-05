import { FakeGitHub } from 'github';
import { CONTEXT_INDEX_PATH, ContextIndexSchema } from 'shared';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  planValidatedAt,
  previewDocument,
  previewFiles,
  readDecisions,
  removeDocument,
  setDocumentNote,
  setDocumentRole,
  UnknownDocumentError,
} from './context-ops.js';
import { depositContext } from './deposit.js';
import { defaultRegistry } from './registry.js';

const ref = { owner: 'kiamiya', repo: 'site' };
const registry = defaultRegistry();
const fixture = (name: string) => ({
  name,
  data: new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))),
});
const text = (name: string, content: string) => ({ name, data: new TextEncoder().encode(content) });

let github: FakeGitHub;
beforeEach(async () => {
  github = new FakeGitHub({ actor: 'kiamiya' });
  github.seedRepository(ref);
  await depositContext(
    github,
    ref,
    [
      { file: fixture('brief.docx'), role: 'brief' },
      { file: text('Spécifications.md', '# Spécifications\n'), role: 'annex' },
      { file: fixture('logo.png'), role: 'annex' },
    ],
    { registry, maxBytes: 50 * 1024 * 1024 },
  );
});

async function index() {
  return ContextIndexSchema.parse(
    JSON.parse((await github.getFile(ref, CONTEXT_INDEX_PATH))?.content ?? ''),
  );
}
const content = async (path: string) => (await github.getFile(ref, path))?.content;

describe('rôle d’un document', () => {
  it('une annexe qui devient le brief échange sa place avec l’ancien brief, en un commit', async () => {
    const oldBrief = await content('.agentlake/context/brief.md');
    const commits = github.state(ref).commits.size;

    await setDocumentRole(github, ref, '.agentlake/context/annexes/specifications.md', 'brief');

    expect(github.state(ref).commits.size).toBe(commits + 1);
    expect(await content('.agentlake/context/brief.md')).toBe('# Spécifications\n');
    expect(await content('.agentlake/context/annexes/specifications.md')).toBeUndefined();
    // L'ancien brief devient une annexe ; ses liens d'images passent en ../assets/.
    const moved = await content('.agentlake/context/annexes/brief.md');
    expect(moved).toBe(oldBrief?.replaceAll('](assets/', '](../assets/'));
    const roles = (await index()).files
      .filter((f) => f.role !== 'asset')
      .map((f) => [f.path, f.role, f.source]);
    expect(roles).toEqual([
      ['.agentlake/context/annexes/brief.md', 'annex', 'brief.docx'],
      ['.agentlake/context/annexes/logo.md', 'annex', 'logo.png'],
      ['.agentlake/context/brief.md', 'brief', 'Spécifications.md'],
    ]);
  });

  it('un brief qui devient GDD ou annexe ; même rôle : aucun commit', async () => {
    expect(await setDocumentRole(github, ref, '.agentlake/context/brief.md', 'brief')).toBeNull();
    await setDocumentRole(github, ref, '.agentlake/context/brief.md', 'gdd');
    expect(await content('.agentlake/context/gdd.md')).toContain('# Brief');
    await setDocumentRole(github, ref, '.agentlake/context/annexes/logo.md', 'gdd');
    expect(await content('.agentlake/context/gdd.md')).toMatch(/^!\[logo\]\(assets\//);
    expect(await content('.agentlake/context/annexes/brief.md')).toContain('# Brief');
  });

  it('refuse un document inconnu ou une image', async () => {
    await expect(
      setDocumentRole(github, ref, '.agentlake/context/absent.md', 'brief'),
    ).rejects.toThrow(UnknownDocumentError);
    const asset = (await index()).files.find((f) => f.role === 'asset')?.path ?? '';
    await expect(setDocumentNote(github, ref, asset, 'x')).rejects.toThrow(UnknownDocumentError);
  });
});

describe('note et retrait', () => {
  it('ajoute, ne recommite pas une note identique, puis efface une note', async () => {
    await setDocumentNote(
      github,
      ref,
      '.agentlake/context/brief.md',
      '  À relire avec le client  ',
    );
    expect((await index()).files.find((f) => f.role === 'brief')?.note).toBe(
      'À relire avec le client',
    );
    expect(
      await setDocumentNote(github, ref, '.agentlake/context/brief.md', 'À relire avec le client'),
    ).toBeNull();
    await setDocumentNote(github, ref, '.agentlake/context/brief.md', '');
    expect((await index()).files.find((f) => f.role === 'brief')).not.toHaveProperty('note');
  });

  it('retire un document et ses images que plus rien n’utilise', async () => {
    // Le logo est utilisé par le brief et par l'annexe logo.md.
    await removeDocument(github, ref, '.agentlake/context/annexes/logo.md');
    expect(await content('.agentlake/context/annexes/logo.md')).toBeUndefined();
    expect((await index()).files.filter((f) => f.role === 'asset')).toHaveLength(1);

    await removeDocument(github, ref, '.agentlake/context/brief.md');
    const files = (await index()).files;
    expect(files.map((f) => f.path)).toEqual(['.agentlake/context/annexes/specifications.md']);
  });
});

describe('aperçus, décisions et validation du plan', () => {
  it('prévisualise un document versé avec ses images lues dans LFS', async () => {
    const preview = await previewDocument(github, ref, '.agentlake/context/annexes/logo.md');
    expect(preview.markdown).toMatch(/^!\[logo\]\(\.\.\/assets\/[0-9a-f]{16}\.png\)\n$/);
    const [link, url] = Object.entries(preview.images)[0] ?? [];
    expect(link).toMatch(/^\.\.\/assets\/[0-9a-f]{16}\.png$/);
    const logo = readFileSync(new URL('./__fixtures__/logo.png', import.meta.url));
    expect(url).toBe(`data:image/png;base64,${logo.toString('base64')}`);
    expect(preview.warnings).toEqual([]);
  });

  it('signale une image manquante dans l’aperçu', async () => {
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'image cassée',
      changes: [
        {
          path: '.agentlake/context/annexes/specifications.md',
          content: '![x](../assets/absent.png)\n',
        },
      ],
    });
    const preview = await previewDocument(
      github,
      ref,
      '.agentlake/context/annexes/specifications.md',
    );
    expect(preview.warnings).toEqual(['Image introuvable : absent.png.']);
  });

  it('prévisualise des fichiers pas encore versés', async () => {
    const [docx, html] = await previewFiles(registry, [
      fixture('brief.docx'),
      fixture('page.html'),
    ]);
    expect(docx?.markdown).toContain('# Brief');
    expect(Object.values(docx?.images ?? {})[0]).toMatch(/^data:image\/png;base64,/);
    expect(html?.markdown).not.toContain('voler');
  });

  it('lit decisions.md et la date de validation du plan', async () => {
    expect(await readDecisions(github, ref)).toBeNull();
    expect(await planValidatedAt(github, ref)).toBeNull();
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'plan',
      changes: [
        { path: '.agentlake/decisions.md', content: '# Décisions\n\n- Supabase.\n' },
        { path: '.agentlake/plan.json', content: '{"validatedAt":"2026-11-05T09:00:00.000Z"}' },
      ],
    });
    expect(await readDecisions(github, ref)).toBe('# Décisions\n\n- Supabase.\n');
    expect(await planValidatedAt(github, ref)).toBe('2026-11-05T09:00:00.000Z');
    await github.commitFiles(ref, {
      branch: 'main',
      message: 'plan cassé',
      changes: [{ path: '.agentlake/plan.json', content: '{ cassé' }],
    });
    expect(await planValidatedAt(github, ref)).toBeNull();
  });
});
