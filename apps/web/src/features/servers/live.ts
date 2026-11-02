import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ServerDetail, ServerLive, ServerSummary } from '@mornihosting/shared';
import { api } from '@/lib/api';
import { isConnected, onConnectionChange, onMessage, subscribeServers } from '@/lib/ws';

export const serversQuery = {
  queryKey: ['servers'],
  queryFn: () => api<ServerSummary[]>('/api/servers'),
} as const;
export const serverQuery = (id: string) =>
  ({ queryKey: ['server', id], queryFn: () => api<ServerDetail>(`/api/servers/${id}`) }) as const;

const HISTORY_POINTS = 30;
const REFRESH_SECONDS = 30;
const MS_PER_SECOND = 1000;

export interface LiveSample {
  readonly cpu: number;
  readonly mem: number;
  /** Bytes received and sent since the server started (the charts show the change between samples). */
  readonly rx: number | null;
  readonly tx: number | null;
}

/** Recent live samples per server, for the small charts on the cards. */
const history = new Map<string, readonly LiveSample[]>();
const historyListeners = new Set<() => void>();

function pushSample(serverId: string, live: ServerLive): void {
  if (live.cpuPercent === null || live.memoryMb === null) return;
  const next = [
    ...(history.get(serverId) ?? []),
    { cpu: live.cpuPercent, mem: live.memoryMb, rx: live.netRxBytes ?? null, tx: live.netTxBytes ?? null },
  ].slice(-HISTORY_POINTS);
  history.set(serverId, next);
  historyListeners.forEach((l) => l());
}

const EMPTY: readonly LiveSample[] = [];

export function useLiveHistory(serverId: string): readonly LiveSample[] {
  return useSyncExternalStore(
    (listener) => {
      historyListeners.add(listener);
      return () => historyListeners.delete(listener);
    },
    () => history.get(serverId) ?? EMPTY,
  );
}

/** Keeps the cached server list and details up to date from the WebSocket. Mounted once in the shell. */
export function useLiveSync(): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(isConnected());
  useEffect(() => {
    const stopSubscription = subscribeServers();
    const offStatus = onConnectionChange(setConnected);
    const offMessage = onMessage((message) => {
      if (message.type === 'live') {
        pushSample(message.serverId, message.live);
        queryClient.setQueryData<ServerSummary[]>(serversQuery.queryKey, (list) =>
          list?.map((s) => (s.id === message.serverId ? { ...s, live: message.live } : s)),
        );
        queryClient.setQueryData<ServerDetail>(['server', message.serverId], (s) =>
          s ? { ...s, live: message.live } : s,
        );
        const previous = queryClient
          .getQueryData<ServerSummary[]>(serversQuery.queryKey)
          ?.find((s) => s.id === message.serverId);
        if (!previous || (message.live.state === 'crashed' && !previous.crash)) {
          void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
          void queryClient.invalidateQueries({ queryKey: ['server', message.serverId] });
        }
      }
      if (message.type === 'deleted') void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
      if (message.type === 'approvals')
        [['approvals'], ['server-requests'], ['users'], serversQuery.queryKey].forEach((queryKey) => {
          void queryClient.invalidateQueries({ queryKey });
        });
    });
    return () => {
      stopSubscription();
      offStatus();
      offMessage();
    };
  }, [queryClient]);
  return connected;
}

export function useServers(): ReturnType<typeof useQuery<ServerSummary[]>> {
  return useQuery({ ...serversQuery, refetchInterval: REFRESH_SECONDS * MS_PER_SECOND });
}
