import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SERVER_MEMORY_MB, type MyQuota } from '@mornihosting/shared';
import { useSession } from '@/features/auth/session';
import { api } from './api';

export const myQuotaQuery = {
  queryKey: ['quotas', 'mine'],
  queryFn: () => api<MyQuota>('/api/quotas/mine'),
} as const;

/**
 * RAM one server of the signed-in person may get, in MB; null = no limit (admins, or an admin allowed it).
 * The order pages and server settings offer no more than this; the server checks it again.
 */
export function useServerMemoryCap(): number | null {
  const isAdmin = useSession().me.user.isAdmin;
  const { data } = useQuery({ ...myQuotaQuery, enabled: !isAdmin });
  if (isAdmin) return null;
  // Until the answer is there, the usual limit: better too little offered for a moment than too much.
  return data === undefined ? DEFAULT_SERVER_MEMORY_MB : data.serverMemoryMb;
}
