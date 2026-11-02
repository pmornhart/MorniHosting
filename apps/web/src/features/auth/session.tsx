import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactElement, type ReactNode } from 'react';
import type { MeResponse, ServerPermission, SystemStatus } from '@mornihosting/shared';
import { api, ApiError, onUnauthorized, setCsrfToken } from '@/lib/api';
import { disconnect } from '@/lib/ws';
import { setLanguage } from '@/i18n';
import { applyTheme } from '@/features/shell/theme';

const HTTP_UNAUTHORIZED = 401;

export const statusQuery = {
  queryKey: ['system-status'],
  queryFn: () => api<SystemStatus>('/api/system/status'),
} as const;

async function loadMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>('/api/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === HTTP_UNAUTHORIZED) return null;
    throw err;
  }
}

export const meQuery = { queryKey: ['me'], queryFn: loadMe } as const;

interface SessionValue {
  readonly me: MeResponse;
  readonly can: (serverId: string, permission: ServerPermission) => boolean;
  readonly hasAny: (serverId: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/** Applies a fresh login: CSRF token, language and theme of the user. */
export function adoptMe(me: MeResponse): void {
  setCsrfToken(me.csrfToken);
  setLanguage(me.user.locale);
  applyTheme(me.user.theme);
}

export function SessionProvider({ me, children }: { me: MeResponse; children: ReactNode }): ReactElement {
  const queryClient = useQueryClient();
  // Set before the children render: their first requests already need the token.
  setCsrfToken(me.csrfToken);
  useEffect(() => adoptMe(me), [me]);
  useEffect(
    () =>
      onUnauthorized(() => {
        disconnect();
        queryClient.setQueryData(meQuery.queryKey, null);
      }),
    [queryClient],
  );
  const value: SessionValue = {
    me,
    can: (serverId, permission) => (me.access[serverId] ?? []).includes(permission),
    hasAny: (serverId) => Boolean(me.access[serverId]?.length),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useMe(): ReturnType<typeof useQuery<MeResponse | null>> {
  return useQuery(meQuery);
}
