import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectInput } from '../../shared/ipc-contract.js';
import { invoke } from '../lib/ipc.js';

const keys = {
  projects: ['projects'] as const,
  discover: ['projects', 'discover'] as const,
  activity: ['activity'] as const,
  sync: (id: string) => ['projects', 'sync', id] as const,
};

/** Sondage de GitHub quand le cockpit est ouvert (cadrage : 30 s). */
export const POLL_MS = 30_000;

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => invoke('projects:list') });
}

export function useDiscoverProjects(enabled: boolean) {
  return useQuery({ queryKey: keys.discover, queryFn: () => invoke('projects:discover'), enabled });
}

export function useOpenProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ref: { owner: string; repo: string }) => invoke('projects:open', ref),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.projects });
      await client.invalidateQueries({ queryKey: keys.activity });
    },
  });
}

export function useActivity() {
  return useQuery({
    queryKey: keys.activity,
    queryFn: () => invoke('activity:get'),
    refetchInterval: POLL_MS,
  });
}

/** Resynchronise depuis GitHub chaque projet ouvert dans un onglet. */
export function useTabsSync(projectIds: readonly string[]) {
  const client = useQueryClient();
  useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: keys.sync(projectId),
      queryFn: async () => {
        const summary = await invoke('projects:sync', { projectId });
        await client.invalidateQueries({ queryKey: keys.projects, exact: true });
        await client.invalidateQueries({ queryKey: keys.activity });
        return summary;
      },
      refetchInterval: POLL_MS,
      // Pas de jeton ou GitHub injoignable : le cache local reste affiché.
      retry: false,
    })),
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => invoke('projects:create', input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.projects });
      await client.invalidateQueries({ queryKey: keys.activity });
    },
  });
}

export function useRebootstrap() {
  return useMutation({
    mutationFn: (projectId: string) => invoke('projects:bootstrap', { projectId }),
  });
}
