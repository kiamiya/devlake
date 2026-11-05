import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IpcInput } from '../../shared/ipc-contract.js';
import { dropFiles, invoke } from '../lib/ipc.js';

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

export function useDropFiles(projectId: string) {
  return useMutation({ mutationFn: (files: readonly File[]) => dropFiles(projectId, files) });
}

export function useStagedPreviews(projectId: string, tokens: readonly string[]) {
  return useQuery({
    queryKey: ['context', projectId, 'staged', ...tokens],
    queryFn: () => invoke('context:preview-staged', { projectId, tokens: [...tokens] }),
    enabled: tokens.length > 0,
  });
}

export function useDocumentPreview(projectId: string, path: string | null) {
  return useQuery({
    queryKey: ['context', projectId, 'preview', path],
    queryFn: () => invoke('context:preview', { projectId, path: path ?? '' }),
    enabled: path !== null,
  });
}

export function useDecisions(projectId: string) {
  return useQuery({
    queryKey: ['context', projectId, 'decisions'],
    queryFn: () => invoke('context:decisions', { projectId }),
  });
}

/** Mutation qui rafraîchit la liste des documents une fois terminée. */
function useContextMutation<T, R>(projectId: string, mutationFn: (value: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useImportContext(projectId: string) {
  return useContextMutation(projectId, (input: Omit<IpcInput<'context:import'>, 'projectId'>) =>
    invoke('context:import', { projectId, ...input }),
  );
}

export function useSetRole(projectId: string) {
  return useContextMutation(projectId, (input: { path: string; role: 'brief' | 'gdd' | 'annex' }) =>
    invoke('context:set-role', { projectId, ...input }),
  );
}

export function useSetNote(projectId: string) {
  return useContextMutation(projectId, (input: { path: string; note: string }) =>
    invoke('context:set-note', { projectId, ...input }),
  );
}

export function useRemoveDocument(projectId: string) {
  return useContextMutation(projectId, (path: string) =>
    invoke('context:remove', { projectId, path }),
  );
}
