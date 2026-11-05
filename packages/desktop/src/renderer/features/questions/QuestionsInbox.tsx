import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/primitives.js';
import { useQuestions } from '../../hooks/questions.js';
import { QuestionCard } from './QuestionCard.js';

type Status = 'pending' | 'answered';

/**
 * Boîte de questions : en attente ou historique, recherche. Sans `projectId`, vue globale
 * de tous les projets ; les questions bloquantes passent en premier.
 */
export function QuestionsInbox({ projectId }: { projectId?: string }) {
  const [status, setStatus] = useState<Status>('pending');
  const [search, setSearch] = useState('');
  const questions = useQuestions({
    ...(projectId === undefined ? {} : { projectId }),
    status,
    ...(search.trim() === '' ? {} : { search: search.trim() }),
  });
  const items = [...(questions.data ?? [])].sort((a, b) =>
    status === 'pending'
      ? Number(b.blocking) - Number(a.blocking) || a.askedAt.localeCompare(b.askedAt)
      : 0,
  );

  return (
    <section aria-label="Boîte de questions" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filtre des questions" className="flex gap-1">
          {(['pending', 'answered'] as const).map((s) => (
            <Button
              key={s}
              aria-pressed={status === s}
              size="sm"
              variant={status === s ? 'default' : 'outline'}
              onClick={() => {
                setStatus(s);
              }}
            >
              {s === 'pending' ? 'En attente' : 'Historique'}
            </Button>
          ))}
        </div>
        <Input
          aria-label="Rechercher dans les questions"
          placeholder="Rechercher…"
          className="ml-auto max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
      </div>
      {questions.error instanceof Error && (
        <p role="alert" className="text-sm text-destructive">
          {questions.error.message}
        </p>
      )}
      {questions.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {status === 'pending'
            ? 'Aucune question en attente.'
            : 'Aucune question dans l’historique.'}
        </p>
      )}
      <ul
        aria-label={status === 'pending' ? 'Questions en attente' : 'Historique des questions'}
        className="flex flex-col gap-3"
      >
        {items.map((q) => (
          <li key={`${q.projectId}#${String(q.issueNumber)}/${q.questionId}`}>
            <QuestionCard question={q} showProject={projectId === undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}
