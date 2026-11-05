import { useState } from 'react';
import type { QuestionView } from '../../../shared/ipc-contract.js';
import { Button } from '../../components/ui/button.js';
import { Badge, Card, Label, Textarea } from '../../components/ui/primitives.js';
import { useChooseFiles, useImportContext } from '../../hooks/context.js';
import { useAnswerQuestion } from '../../hooks/questions.js';
import { formatAge } from './age.js';

interface Staged {
  token: string;
  name: string;
}

/** Formulaire de réponse : option ou texte libre, décision cochée par défaut, pièces jointes. */
function AnswerForm({ question }: { question: QuestionView }) {
  const [text, setText] = useState('');
  const [decision, setDecision] = useState(true);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const choose = useChooseFiles(question.projectId);
  const importContext = useImportContext(question.projectId);
  const answer = useAnswerQuestion();
  const id = `${question.projectId}-${String(question.issueNumber)}-${question.questionId}`;
  const busy = answer.isPending || importContext.isPending;
  const needsAck = staged.length > 0 && !repositoryPrivate && !acknowledged;
  const error = answer.error ?? importContext.error ?? choose.error;

  const submit = async (ignore: boolean) => {
    let attachments: string[] = [];
    if (!ignore && staged.length > 0) {
      const result = await importContext.mutateAsync({
        files: staged.map((s) => ({ token: s.token, role: 'annex' as const })),
        acknowledgePublic: acknowledged,
      });
      attachments = result.imported.map((f) => f.path);
    }
    await answer.mutateAsync({
      projectId: question.projectId,
      issueNumber: question.issueNumber,
      questionId: question.questionId,
      text,
      decision,
      ignore,
      attachments,
    });
  };

  return (
    <form
      aria-label={`Réponse à ${question.questionId}`}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false).catch(() => undefined);
      }}
    >
      {question.options.length > 0 && (
        <div role="group" aria-label="Options proposées" className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={text === option ? 'default' : 'outline'}
              onClick={() => {
                setText(option);
              }}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-text`}>Réponse</Label>
        <Textarea
          id={`${id}-text`}
          className="min-h-20 font-sans text-sm"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={decision}
          onChange={(e) => {
            setDecision(e.target.checked);
          }}
        />
        Décision du projet (ajoutée à <code>.agentlake/decisions.md</code>)
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={choose.isPending}
            onClick={() => {
              choose.mutate(undefined, {
                onSuccess: (chosen) => {
                  setRepositoryPrivate(chosen.repositoryPrivate);
                  setStaged((all) => [
                    ...all,
                    ...chosen.files.map((f) => ({ token: f.token, name: f.name })),
                  ]);
                },
              });
            }}
          >
            Joindre des fichiers
          </Button>
          {staged.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {staged.map((s) => s.name).join(', ')} (versés dans le contexte en annexe)
            </span>
          )}
        </div>
        {staged.length > 0 && !repositoryPrivate && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
              }}
            />
            Je confirme que ces pièces jointes peuvent être publiques.
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || needsAck || (text.trim() === '' && staged.length === 0)}
        >
          Répondre
        </Button>
        {question.source === 'cadrage' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void submit(true).catch(() => undefined);
            }}
          >
            Ignorer la question
          </Button>
        )}
      </div>
      {error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </form>
  );
}

/** Une question : tâche, contexte, options, ancienneté ; réponse ou formulaire. */
export function QuestionCard({
  question,
  showProject,
  now,
}: {
  question: QuestionView;
  showProject: boolean;
  now?: Date;
}) {
  return (
    <Card>
      <article aria-label={`Question ${question.questionId}`} className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2 text-sm">
          {showProject && <span className="font-mono text-xs">{question.projectId}</span>}
          <a
            href={question.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline-offset-2 hover:underline"
          >
            {question.source === 'cadrage' ? 'Cadrage' : question.issueTitle} (#
            {question.issueNumber})
          </a>
          <Badge tone={question.blocking ? 'degraded' : 'absent'}>
            {question.blocking ? 'Bloquante' : 'Non bloquante'}
          </Badge>
          <span className="text-xs text-muted-foreground">{formatAge(question.askedAt, now)}</span>
          <code className="ml-auto text-xs text-muted-foreground">{question.questionId}</code>
        </header>
        <p className="whitespace-pre-wrap text-sm">{question.text}</p>
        {question.context !== null && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Contexte</summary>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {question.context}
            </p>
          </details>
        )}
        {question.answer === null ? (
          <AnswerForm question={question} />
        ) : (
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Répondue {formatAge(question.answer.at, now)}
              {question.answer.decision === true && ' · décision du projet'}
            </p>
            <p className="whitespace-pre-wrap">
              {question.answer.text ?? 'Sans réponse écrite (question ignorée ou close ailleurs).'}
            </p>
          </div>
        )}
      </article>
    </Card>
  );
}
