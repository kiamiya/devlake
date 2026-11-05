import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectPlan } from 'shared';
import { invoke } from '../lib/ipc.js';

const key = (projectId: string) => ['plan', projectId] as const;

export function usePlanVersions(projectId: string) {
  return useQuery({
    queryKey: [...key(projectId), 'versions'],
    queryFn: () => invoke('plan:versions', { projectId }),
  });
}

export function usePlan(projectId: string, version: number | null) {
  return useQuery({
    queryKey: [...key(projectId), 'v', version],
    queryFn: () => invoke('plan:get', { projectId, version: version ?? 1 }),
    enabled: version !== null,
  });
}

function usePlanMutation<T, R>(projectId: string, mutationFn: (value: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useSavePlan(projectId: string) {
  return usePlanMutation(projectId, (input: { version: number; plan: ProjectPlan }) =>
    invoke('plan:save', { projectId, ...input }),
  );
}

export function useSetProjectCap(projectId: string) {
  return usePlanMutation(projectId, (cap: number | null) =>
    invoke('plan:set-cap', { projectId, cap }),
  );
}

export function useValidatePlan(projectId: string) {
  return usePlanMutation(projectId, (version: number) =>
    invoke('plan:validate', { projectId, version }),
  );
}
