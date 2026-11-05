import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IpcInput } from '../../shared/ipc-contract.js';
import { invoke } from '../lib/ipc.js';

const key = (projectId: string) => ['context', projectId] as const;

export function useContextEntries(projectId: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => invoke('context:list', { projectId }),
  });
}

export function useChooseFiles(projectId: string) {
  return useMutation({ mutationFn: () => invoke('context:choose-files', { projectId }) });
}

export function useImportContext(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<IpcInput<'context:import'>, 'projectId'>) =>
      invoke('context:import', { projectId, ...input }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}
