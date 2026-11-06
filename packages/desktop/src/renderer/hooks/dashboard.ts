import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '../lib/ipc.js';
import { POLL_MS } from './projects.js';

const key = (projectId: string) => ['dashboard', projectId] as const;

/** Tableau de bord : relu au rythme du sondage du projet (30 s). */
export function useDashboard(projectId: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => invoke('dashboard:get', { projectId }),
    refetchInterval: POLL_MS,
  });
}

export function useSetPaused(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => invoke('dashboard:set-paused', { projectId, paused }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useRelaunch(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { issueNumber: number; instruction: string }) =>
      invoke('dashboard:relaunch', { projectId, ...input }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key(projectId) });
      await client.invalidateQueries({ queryKey: ['questions'] });
    },
  });
}

export function useRunLogs(projectId: string, runId: number | null) {
  return useQuery({
    queryKey: ['runs', projectId, runId, 'logs'],
    queryFn: () => invoke('runs:logs', { projectId, runId: runId ?? 0 }),
    enabled: runId !== null,
  });
}

export function useRunTranscript(projectId: string, runId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ['runs', projectId, runId, 'transcript'],
    queryFn: () => invoke('runs:transcript', { projectId, runId: runId ?? 0 }),
    enabled: enabled && runId !== null,
  });
}
