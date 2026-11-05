import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardDescription,
  CardTitle,
  Label,
  Textarea,
} from '../../components/ui/primitives.js';
import { invoke } from '../../lib/ipc.js';
import { PlanReview } from '../plan-review/PlanReview.js';

/** Lancement du planificateur, puis revue et validation du plan. */
export function PlanSection({ projectId }: { projectId: string }) {
  const [instruction, setInstruction] = useState('');
  const start = useMutation({
    mutationFn: (mode: 'auto' | 'regenerate') =>
      invoke('planner:start', {
        projectId,
        mode,
        ...(mode === 'regenerate' ? { instruction } : {}),
      }),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Planificateur</CardTitle>
        <CardDescription>
          Il pose ses questions dans l’issue « Cadrage » du dépôt, puis écrit le plan sur une
          branche <code>plan/vN</code> quand toutes les questions bloquantes ont une réponse.
        </CardDescription>
        <div className="flex flex-col gap-4">
          <div>
            <Button
              disabled={start.isPending}
              onClick={() => {
                start.mutate('auto');
              }}
            >
              Lancer le planificateur
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="plan-instruction">Consigne pour régénérer le plan</Label>
            <Textarea
              id="plan-instruction"
              className="font-sans text-sm"
              maxLength={4000}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
              }}
            />
            <div>
              <Button
                variant="outline"
                disabled={start.isPending || instruction.trim() === ''}
                onClick={() => {
                  start.mutate('regenerate');
                }}
              >
                Régénérer le plan
              </Button>
            </div>
          </div>
          {start.isSuccess && (
            <p role="status" className="text-sm text-success">
              Planificateur lancé : suivre l’issue « Cadrage » sur GitHub.
            </p>
          )}
          {start.error instanceof Error && (
            <p role="alert" className="text-sm text-destructive">
              {start.error.message}
            </p>
          )}
        </div>
      </Card>
      <PlanReview projectId={projectId} />
    </div>
  );
}
