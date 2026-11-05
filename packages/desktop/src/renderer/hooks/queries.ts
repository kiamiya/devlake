import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsPatch } from '../../shared/settings.js';
import { invoke } from '../lib/ipc.js';

const keys = {
  settings: ['settings'] as const,
  token: ['token'] as const,
  status: ['status'] as const,
};

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => invoke('settings:get') });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => invoke('settings:update', patch),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings, settings);
    },
  });
}

export function useMaskedToken() {
  return useQuery({ queryKey: keys.token, queryFn: () => invoke('token:get-masked') });
}

function useTokenMutation<T>(mutationFn: (value: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: keys.token });
      await client.invalidateQueries({ queryKey: keys.status });
    },
  });
}

export function useSetToken() {
  return useTokenMutation((token: string) => invoke('token:set', { token }));
}

export function useClearToken() {
  return useTokenMutation(() => invoke('token:clear'));
}

export function useTestToken() {
  return useTokenMutation(() => invoke('token:test'));
}

export function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => invoke('status:get'),
    refetchInterval: 30_000,
  });
}
