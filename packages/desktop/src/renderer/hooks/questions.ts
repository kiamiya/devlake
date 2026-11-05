import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IpcInput } from '../../shared/ipc-contract.js';
import { invoke } from '../lib/ipc.js';
import { POLL_MS } from './projects.js';

const KEY = ['questions'] as const;

export type QuestionsFilter = IpcInput<'questions:list'>;

export function useQuestions(filter: QuestionsFilter) {
  return useQuery({
    queryKey: [...KEY, filter],
    queryFn: () => invoke('questions:list', filter),
  });
}

/** Sondage global des questions (30 s) : notifications et badges, tous projets confondus. */
export function useQuestionsSync() {
  const client = useQueryClient();
  return useQuery({
    queryKey: [...KEY, 'sync'],
    queryFn: async () => {
      const counts = await invoke('questions:sync');
      await client.invalidateQueries({
        queryKey: KEY,
        predicate: (q) => q.queryKey[1] !== 'sync',
      });
      return counts;
    },
    refetchInterval: POLL_MS,
    // Pas de jeton ou GitHub injoignable : les questions déjà lues restent affichées.
    retry: false,
  });
}

export function useAnswerQuestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (answer: IpcInput<'questions:answer'>) => invoke('questions:answer', answer),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
      await client.invalidateQueries({ queryKey: ['projects'] });
      await client.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
