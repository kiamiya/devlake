import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '../lib/ipc.js';

export type Editor = 'unity' | 'unreal';

const KEY = ['bridge'] as const;
/** Rafraîchissement de l'état des ponts et du journal d'audit. */
const BRIDGE_POLL_MS = 5_000;

export function useBridges() {
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => invoke('bridge:list'),
    refetchInterval: BRIDGE_POLL_MS,
  });
}

export function useBridgeTools(editor: Editor, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, editor, 'tools'],
    queryFn: () => invoke('bridge:tools', { editor }),
    enabled,
  });
}

export function useBridgeAudit(editor: Editor, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, editor, 'audit'],
    queryFn: () => invoke('bridge:audit', { editor }),
    enabled,
    refetchInterval: BRIDGE_POLL_MS,
  });
}

function useBridgeMutation<T>(mutationFn: (value: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
      await client.invalidateQueries({ queryKey: ['status'] });
    },
  });
}

export function useStartBridge() {
  return useBridgeMutation((editor: Editor) => invoke('bridge:start', { editor }));
}

export function useStopBridge() {
  return useBridgeMutation((editor: Editor) => invoke('bridge:stop', { editor }));
}

export function useSetBridgeTools() {
  return useBridgeMutation((input: { editor: Editor; tools: string[] }) =>
    invoke('bridge:set-tools', input),
  );
}
