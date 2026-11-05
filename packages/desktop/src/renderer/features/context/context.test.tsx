// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ContextEntry } from 'shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentList, formatSize, isNewContext } from './DocumentList.js';
import { DropZone } from './DropZone.js';
import { MarkdownPreview } from './MarkdownPreview.js';

afterEach(() => {
  cleanup();
});

const entry = (overrides: Partial<ContextEntry> = {}): ContextEntry => ({
  path: '.agentlake/context/brief.md',
  role: 'brief',
  source: 'brief.docx',
  sha256: 'a'.repeat(64),
  size: 10_914,
  importedAt: '2026-11-05T10:00:00.000Z',
  ...overrides,
});

function renderList(entries: ContextEntry[], planValidatedAt: string | null = null) {
  const handlers = { onPreview: vi.fn(), onRole: vi.fn(), onNote: vi.fn(), onRemove: vi.fn() };
  render(
    <DocumentList entries={entries} planValidatedAt={planValidatedAt} busy={false} {...handlers} />,
  );
  return handlers;
}

describe('liste des documents', () => {
  it('n’affiche que les documents, avec rôle, taille et chemin', () => {
    renderList([
      entry(),
      entry({ path: '.agentlake/context/assets/x.png', role: 'asset', source: 'brief.docx' }),
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('brief.md')).toBeTruthy();
    expect(screen.getByText(/11 Ko/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Rôle de brief.docx').value).toBe('brief');
  });

  it('marque « nouveau contexte » ce qui suit la validation du plan', () => {
    renderList(
      [
        entry({
          source: 'avant.md',
          path: '.agentlake/context/annexes/avant.md',
          role: 'annex',
          importedAt: '2026-11-01T00:00:00.000Z',
        }),
        entry({
          source: 'après.md',
          path: '.agentlake/context/annexes/apres.md',
          role: 'annex',
          importedAt: '2026-11-06T00:00:00.000Z',
        }),
      ],
      '2026-11-03T00:00:00.000Z',
    );
    expect(screen.getAllByText('nouveau contexte')).toHaveLength(1);
    expect(isNewContext(entry(), null)).toBe(false);
  });

  it('change le rôle, ouvre l’aperçu et enregistre une note', () => {
    const handlers = renderList([entry({ note: 'ancienne' })]);
    fireEvent.change(screen.getByLabelText('Rôle de brief.docx'), { target: { value: 'annex' } });
    expect(handlers.onRole).toHaveBeenCalledWith('.agentlake/context/brief.md', 'annex');
    fireEvent.click(screen.getByRole('button', { name: 'Aperçu' }));
    expect(handlers.onPreview).toHaveBeenCalledWith('.agentlake/context/brief.md');

    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Note sur brief.docx'), {
      target: { value: 'À relire' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(handlers.onNote).toHaveBeenCalledWith('.agentlake/context/brief.md', 'À relire');
  });

  it('demande une confirmation avant de retirer', () => {
    const handlers = renderList([entry()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retirer brief.docx' }));
    expect(handlers.onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retirer brief.docx' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer le retrait' }));
    expect(handlers.onRemove).toHaveBeenCalledWith('.agentlake/context/brief.md');
  });

  it('signale une liste vide et formate les tailles', () => {
    renderList([]);
    expect(screen.getByText('Aucun document versé.')).toBeTruthy();
    expect(formatSize(100)).toBe('1 Ko');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 Mo');
  });
});

describe('aperçu Markdown', () => {
  it('rend titres, tableaux et images fournies, sans interpréter le HTML brut', () => {
    const { container } = render(
      <MarkdownPreview
        label="Aperçu"
        markdown={
          '# Titre\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![logo](assets/x.png)\n\n![absente](assets/y.png)\n\n<script>alert(1)</script>\n'
        }
        images={{ 'assets/x.png': 'data:image/png;base64,AAAA' }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Titre' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'logo' }).getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(screen.getByText('[image : absente]')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('zone de dépôt', () => {
  it('transmet les fichiers déposés ou parcourus', () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} disabled={false} />);
    const files = [new File(['a'], 'a.md'), new File(['b'], 'b.md')];
    fireEvent.dragOver(screen.getByTestId('drop-zone'));
    fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files } });
    expect(onFiles).toHaveBeenCalledWith(files);

    fireEvent.change(screen.getByLabelText('Ajouter des fichiers'), {
      target: { files: [files[0]] },
    });
    expect(onFiles).toHaveBeenLastCalledWith([files[0]]);
  });

  it('ignore un dépôt vide ou pendant un traitement', () => {
    const onFiles = vi.fn();
    const { rerender } = render(<DropZone onFiles={onFiles} disabled={false} />);
    fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files: [] } });
    rerender(<DropZone onFiles={onFiles} disabled />);
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [new File(['a'], 'a.md')] },
    });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
