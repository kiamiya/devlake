import type { ContextEntry } from 'shared';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/primitives.js';

export type DocumentRole = 'brief' | 'gdd' | 'annex';

export const ROLE_LABELS: Record<string, string> = {
  brief: 'Brief',
  gdd: 'GDD',
  annex: 'Annexe',
  asset: 'Image',
};

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${String(Math.max(1, Math.round(bytes / 1024)))} Ko`
    : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Ajouté après la validation du plan : les agents n'en ont pas tenu compte au découpage. */
export function isNewContext(entry: ContextEntry, planValidatedAt: string | null): boolean {
  return planValidatedAt !== null && entry.importedAt > planValidatedAt;
}

export interface DocumentListProps {
  entries: readonly ContextEntry[];
  planValidatedAt: string | null;
  busy: boolean;
  onPreview: (path: string) => void;
  onRole: (path: string, role: DocumentRole) => void;
  onNote: (path: string, note: string) => void;
  onRemove: (path: string) => void;
}

function NoteEditor({
  entry,
  onNote,
  busy,
}: {
  entry: ContextEntry;
  onNote: (note: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState(entry.note ?? '');
  const changed = note.trim() !== (entry.note ?? '');
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onNote(note);
      }}
    >
      <Input
        aria-label={`Note sur ${entry.source}`}
        placeholder="Note"
        value={note}
        maxLength={2000}
        onChange={(e) => {
          setNote(e.target.value);
        }}
        className="h-8"
      />
      {changed && (
        <Button size="sm" type="submit" disabled={busy}>
          Enregistrer
        </Button>
      )}
    </form>
  );
}

/** Liste des documents versés : rôle, date, taille, note, aperçu et retrait confirmé. */
export function DocumentList(props: DocumentListProps) {
  const { entries, planValidatedAt, busy } = props;
  const [confirming, setConfirming] = useState<string | null>(null);
  const documents = entries.filter((e) => e.role !== 'asset');

  if (documents.length === 0)
    return <p className="text-sm text-muted-foreground">Aucun document versé.</p>;
  return (
    <ul aria-label="Documents versés" className="flex flex-col divide-y divide-border">
      {documents.map((entry) => (
        <li key={entry.path} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{entry.source}</span>
            {isNewContext(entry, planValidatedAt) && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                nouveau contexte
              </span>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {entry.path.replace('.agentlake/context/', '')}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDate(entry.importedAt)} · {formatSize(entry.size)}
            </span>
            <select
              aria-label={`Rôle de ${entry.source}`}
              className="ml-auto h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={entry.role}
              disabled={busy}
              onChange={(e) => {
                props.onRole(entry.path, e.target.value as DocumentRole);
              }}
            >
              <option value="brief">Brief</option>
              <option value="gdd">GDD</option>
              <option value="annex">Annexe</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                props.onPreview(entry.path);
              }}
            >
              Aperçu
            </Button>
            {confirming === entry.path ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    props.onRemove(entry.path);
                  }}
                >
                  Confirmer le retrait
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirming(null);
                  }}
                >
                  Annuler
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Retirer ${entry.source}`}
                onClick={() => {
                  setConfirming(entry.path);
                }}
              >
                Retirer
              </Button>
            )}
          </div>
          <NoteEditor
            key={entry.note ?? ''}
            entry={entry}
            busy={busy}
            onNote={(note) => {
              props.onNote(entry.path, note);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
