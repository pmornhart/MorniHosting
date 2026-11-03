import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const REFRESH_MS = 5 * 60 * 1000;

/**
 * How many plugin/mod updates each server has. The panel checks in the background (at most every half hour
 * per server); asking here is cheap, so the dashboard and the tabs can show it everywhere.
 */
export function useContentUpdates(): Readonly<Record<string, number>> {
  const { data } = useQuery({
    queryKey: ['content-updates'],
    queryFn: () => api<Record<string, number>>('/api/content/updates'),
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
  });
  return data ?? {};
}
