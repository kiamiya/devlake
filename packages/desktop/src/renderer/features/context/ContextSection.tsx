import { useState } from 'react';
import type { DepositResultView } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../../components/ui/primitives.js';
import { useChooseFiles, useContextEntries, useImportContext } from '../../hooks/context.js';

type Role = 'brief' | 'gdd' | 'annex';

const ROLE_LABELS: Record<string, string> = {
  brief: 'Brief',
  gdd: 'GDD',
  annex: 'Annexe',
  asset: 'Image',
};

interface Staged {
  token: string;
  name: string;
  size: number;
  role: Role;
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} Ko`
    : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function Result({ result }: { result: DepositResultView }) {
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      <p>
        {result.committed
          ? `${String(result.imported.length)} document${result.imported.length > 1 ? 's' : ''} versé${result.imported.length > 1 ? 's' : ''} en un commit.`
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

/** Import minimal de documents dans le contexte ; la bibliothèque complète arrive avec T07. */
export function ContextSection({ projectId }: { projectId: string }) {
  const entries = useContextEntries(projectId);
  const choose = useChooseFiles(projectId);
  const deposit = useImportContext(projectId);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [isPrivate, setPrivate] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);

  const pick = () => {
    deposit.reset();
    choose.mutate(undefined, {
      onSuccess: ({ files, repositoryPrivate }) => {
        setStaged(files.map((f) => ({ ...f, role: 'annex' })));
        setPrivate(repositoryPrivate);
        setAcknowledged(false);
      },
    });
  };

  const send = () => {
    deposit.mutate(
      {
        files: staged.map(({ token, role }) => ({ token, role })),
        acknowledgePublic: acknowledged,
      },
      {
        onSuccess: () => {
          setStaged([]);
        },
      },
    );
  };

  const error = choose.error ?? deposit.error ?? entries.error;
  const documents = (entries.data ?? []).filter((e) => e.role !== 'asset');
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Documents du contexte</CardTitle>
        <CardDescription>
          Versés dans <code>.agentlake/context/</code> du dépôt, en Markdown ; les images vont dans
          Git LFS.
        </CardDescription>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun document versé.</p>
        ) : (
          <ul aria-label="Documents versés" className="flex flex-col gap-1 text-sm">
            {documents.map((e) => (
              <li key={e.path} className="flex justify-between gap-4">
                <span className="font-mono">{e.path.replace('.agentlake/context/', '')}</span>
                <span className="text-muted-foreground">
                  {ROLE_LABELS[e.role]} · {e.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>Importer</CardTitle>
        <CardDescription>Formats : docx, html, md, txt, pdf et images.</CardDescription>
        <div className="flex flex-col gap-4">
          <div>
            <Button variant="outline" onClick={pick} disabled={choose.isPending}>
              Choisir des fichiers
            </Button>
          </div>
          {staged.length > 0 && (
            <>
              <ul aria-label="Fichiers à verser" className="flex flex-col gap-2">
                {staged.map((file, i) => (
                  <li key={file.token} className="flex items-center justify-between gap-4 text-sm">
                    <span>
                      {file.name} <span className="text-muted-foreground">({size(file.size)})</span>
                    </span>
                    <select
                      aria-label={`Rôle de ${file.name}`}
                      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={file.role}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        setStaged((all) => all.map((f, j) => (j === i ? { ...f, role } : f)));
                      }}
                    >
                      <option value="brief">Brief</option>
                      <option value="gdd">GDD</option>
                      <option value="annex">Annexe</option>
                    </select>
                  </li>
                ))}
              </ul>
              {!isPrivate && (
                <div
                  role="note"
                  className="flex flex-col gap-2 rounded-md bg-warning/15 p-3 text-sm"
                >
                  <p>
                    Ce dépôt est <strong>public</strong> : ces documents seront visibles de tous sur
                    GitHub.
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
                  onClick={send}
                  disabled={deposit.isPending || (!isPrivate && !acknowledged)}
                >
                  {deposit.isPending ? 'Versement…' : 'Verser dans le dépôt'}
                </Button>
              </div>
            </>
          )}
          {deposit.data && <Result result={deposit.data} />}
          {error instanceof Error && (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
