import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardDescription,
  CardTitle,
  Label,
  Textarea,
} from '../../components/ui/primitives.js';
import { POLL_MS } from '../../hooks/projects.js';
import { invoke } from '../../lib/ipc.js';
import { MarkdownPreview } from '../context/MarkdownPreview.js';

export const inventoryKey = (projectId: string) => ['inventory', projectId] as const;

export function useInventory(projectId: string) {
  return useQuery({
    queryKey: inventoryKey(projectId),
    queryFn: () => invoke('inventory:get', { projectId }),
    refetchInterval: POLL_MS,
  });
}

/**
 * État des lieux d'un projet repris : lancé par le planificateur, relu ici, puis versé dans
 * le contexte. Le planificateur ne planifie la suite qu'une fois l'état des lieux validé.
 */
export function InventoryCard({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const inventory = useInventory(projectId);
  const [instruction, setInstruction] = useState('');
  const start = useMutation({
    mutationFn: () =>
      invoke('planner:start', {
        projectId,
        mode: 'inventory',
        ...(instruction.trim() !== '' ? { instruction } : {}),
      }),
  });
  const validate = useMutation({
    mutationFn: (version: number) => invoke('inventory:validate', { projectId, version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: inventoryKey(projectId) });
      await client.invalidateQueries({ queryKey: ['context', projectId] });
    },
  });

  const state = inventory.data;
  if (!state?.adopted) return null;
  const latest = state.latest;
  const error = inventory.error ?? start.error ?? validate.error;

  return (
    <Card>
      <CardTitle>État des lieux</CardTitle>
      <CardDescription>
        Projet repris : le planificateur parcourt d’abord le dépôt (code, tests, CI, assets, issues
        et PR ouvertes) et propose un état des lieux sur une branche <code>etat-des-lieux/vN</code>.
        Une fois validé, il rejoint le contexte et sert au cadrage, au plan et aux agents.
      </CardDescription>
      <div className="flex flex-col gap-4">
        <p role="status" className="text-sm">
          {state.validated
            ? 'État des lieux validé : le planificateur peut planifier la suite.'
            : latest === null
              ? 'Aucun état des lieux pour l’instant.'
              : `État des lieux v${String(latest.version)} à relire et valider.`}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="inventory-instruction">Consigne (facultative)</Label>
          <Textarea
            id="inventory-instruction"
            className="font-sans text-sm"
            maxLength={4000}
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant={latest === null ? 'default' : 'outline'}
              disabled={start.isPending}
              onClick={() => {
                start.mutate();
              }}
            >
              {latest === null ? 'Lancer l’état des lieux' : 'Refaire l’état des lieux'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void inventory.refetch();
              }}
            >
              Rafraîchir
            </Button>
          </div>
          {start.isSuccess && (
            <p role="status" className="text-sm text-success">
              État des lieux lancé : il apparaîtra ici une fois prêt (suivre l’issue « Cadrage »).
            </p>
          )}
        </div>
        {latest !== null && (
          <div className="flex flex-col gap-2">
            <MarkdownPreview
              markdown={latest.content}
              images={{}}
              label={`État des lieux v${String(latest.version)}`}
            />
            <div>
              <Button
                disabled={validate.isPending}
                onClick={() => {
                  validate.mutate(latest.version);
                }}
              >
                Valider l’état des lieux v{latest.version}
              </Button>
            </div>
          </div>
        )}
        {error instanceof Error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </Card>
  );
}
