import { useState } from 'react';
import type { ChosenFilesView, DepositResultView } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../../components/ui/primitives.js';
import {
  useChooseFiles,
  useContextEntries,
  useDecisions,
  useDocumentPreview,
  useDropFiles,
  useImportContext,
  useRemoveDocument,
  useSetNote,
  useSetRole,
  useStagedPreviews,
} from '../../hooks/context.js';
import { DocumentList, formatSize, type DocumentRole } from './DocumentList.js';
import { DropZone } from './DropZone.js';
import { MarkdownPreview } from './MarkdownPreview.js';

interface Staged {
  token: string;
  name: string;
  size: number;
  role: DocumentRole;
}

function Result({ result }: { result: DepositResultView }) {
  const n = result.imported.length;
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      <p>
        {result.committed
          ? `${String(n)} document${n > 1 ? 's' : ''} versé${n > 1 ? 's' : ''} en un commit.`
          : 'Aucun changement : rien de nouveau à verser.'}
      </p>
      {result.skipped.map((s) => (
        <p key={s.source} className="text-muted-foreground">
          {s.source} : {s.reason}
        </p>
      ))}
      {result.warnings.map((w) => (
        <p key={w} className="text-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

function StagedFiles({
  projectId,
  staged,
  setStaged,
  repositoryPrivate,
  onDone,
}: {
  projectId: string;
  staged: Staged[];
  setStaged: (update: (all: Staged[]) => Staged[]) => void;
  repositoryPrivate: boolean;
  onDone: (result: DepositResultView) => void;
}) {
  const previews = useStagedPreviews(
    projectId,
    staged.map((s) => s.token),
  );
  const deposit = useImportContext(projectId);
  const [acknowledged, setAcknowledged] = useState(false);
  const byToken = new Map((previews.data ?? []).map((p) => [p.token, p]));

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Fichiers à verser" className="flex flex-col gap-4">
        {staged.map((file, i) => {
          const preview = byToken.get(file.token);
          return (
            <li key={file.token} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span>
                  {file.name}{' '}
                  <span className="text-muted-foreground">({formatSize(file.size)})</span>
                </span>
                <select
                  aria-label={`Rôle de ${file.name}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={file.role}
                  onChange={(e) => {
                    const role = e.target.value as DocumentRole;
                    setStaged((all) => all.map((f, j) => (j === i ? { ...f, role } : f)));
                  }}
                >
                  <option value="brief">Brief</option>
                  <option value="gdd">GDD</option>
                  <option value="annex">Annexe</option>
                </select>
              </div>
              {preview ? (
                <>
                  <MarkdownPreview
                    markdown={preview.markdown}
                    images={preview.images}
                    label={`Aperçu de ${file.name}`}
                  />
                  {preview.warnings.map((w) => (
                    <p key={w} className="text-xs text-warning">
                      {w}
                    </p>
                  ))}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {previews.isPending ? 'Conversion…' : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {previews.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {previews.error.message}
        </p>
      )}
      {!repositoryPrivate && (
        <div role="note" className="flex flex-col gap-2 rounded-md bg-warning/15 p-3 text-sm">
          <p>
            Ce dépôt est <strong>public</strong> : ces documents seront visibles de tous sur GitHub.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
              }}
            />
            Je confirme que ces documents peuvent être publics.
          </label>
        </div>
      )}
      <div>
        <Button
          disabled={deposit.isPending || (!repositoryPrivate && !acknowledged)}
          onClick={() => {
            deposit.mutate(
              {
                files: staged.map(({ token, role }) => ({ token, role })),
                acknowledgePublic: acknowledged,
              },
              { onSuccess: onDone },
            );
          }}
        >
          {deposit.isPending
            ? 'Versement…'
            : `Verser ${String(staged.length)} fichier${staged.length > 1 ? 's' : ''}`}
        </Button>
      </div>
      {deposit.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {deposit.error.message}
        </p>
      )}
    </div>
  );
}

/** Bibliothèque de contexte du projet : documents versés, dépôt de fichiers, aperçus, décisions. */
export function ContextSection({ projectId }: { projectId: string }) {
  const entries = useContextEntries(projectId);
  const decisions = useDecisions(projectId);
  const choose = useChooseFiles(projectId);
  const drop = useDropFiles(projectId);
  const setRole = useSetRole(projectId);
  const setNote = useSetNote(projectId);
  const remove = useRemoveDocument(projectId);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [result, setResult] = useState<DepositResultView | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const preview = useDocumentPreview(projectId, previewPath);

  const stage = (chosen: ChosenFilesView) => {
    setResult(null);
    setRepositoryPrivate(chosen.repositoryPrivate);
    setStaged((all) => [...all, ...chosen.files.map((f) => ({ ...f, role: 'annex' as const }))]);
  };

  const busy = setRole.isPending || setNote.isPending || remove.isPending;
  const error =
    entries.error ?? choose.error ?? drop.error ?? setRole.error ?? setNote.error ?? remove.error;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Ajouter des documents</CardTitle>
        <CardDescription>
          Convertis en Markdown et versés en un commit dans <code>.agentlake/context/</code> ; les
          images vont dans Git LFS.
        </CardDescription>
        <div className="flex flex-col gap-4">
          <DropZone
            disabled={drop.isPending}
            onFiles={(files) => {
              drop.mutate(files, { onSuccess: stage });
            }}
          />
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={choose.isPending}
              onClick={() => {
                choose.mutate(undefined, { onSuccess: stage });
              }}
            >
              Choisir des fichiers
            </Button>
          </div>
          {staged.length > 0 && (
            <StagedFiles
              projectId={projectId}
              staged={staged}
              setStaged={setStaged}
              repositoryPrivate={repositoryPrivate}
              onDone={(deposited) => {
                setStaged([]);
                setResult(deposited);
              }}
            />
          )}
          {result && <Result result={result} />}
        </div>
      </Card>

      <Card>
        <CardTitle>Documents du contexte</CardTitle>
        <CardDescription>
          Badge « nouveau contexte » : ajouté après la validation du plan.
        </CardDescription>
        <DocumentList
          entries={entries.data?.entries ?? []}
          planValidatedAt={entries.data?.planValidatedAt ?? null}
          busy={busy}
          onPreview={setPreviewPath}
          onRole={(path, role) => {
            setRole.mutate({ path, role });
          }}
          onNote={(path, note) => {
            setNote.mutate({ path, note });
          }}
          onRemove={(path) => {
            if (previewPath === path) setPreviewPath(null);
            remove.mutate(path);
          }}
        />
        {previewPath !== null && (
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">
                {previewPath.replace('.agentlake/context/', '')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPreviewPath(null);
                }}
              >
                Fermer l’aperçu
              </Button>
            </div>
            {preview.data && (
              <MarkdownPreview
                markdown={preview.data.markdown}
                images={preview.data.images}
                label="Aperçu du document"
              />
            )}
          </div>
        )}
        {error instanceof Error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error.message}
          </p>
        )}
      </Card>

      <Card>
        <CardTitle>Décisions du projet</CardTitle>
        <CardDescription>
          <code>.agentlake/decisions.md</code> : réponses promues en décisions, lues par tous les
          agents.
        </CardDescription>
        {decisions.data?.content ? (
          <MarkdownPreview markdown={decisions.data.content} images={{}} label="Décisions" />
        ) : (
          <p className="text-sm text-muted-foreground">Aucune décision pour l’instant.</p>
        )}
      </Card>
    </div>
  );
}
