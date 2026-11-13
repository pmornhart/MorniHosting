import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { TeamAbility, TeamAction, TeamBoardView, TeamSettings } from '@mornihosting/shared';
import { api } from '@/lib/api';

/** The game writes every 5 seconds; the page follows it. */
const REFRESH_MS = 5000;
const KEY_HEADER = 'x-team-key';
/** Time the game needs to carry out a button before the page asks again. */
const ACTION_SETTLE_MS = 2500;

export interface TeamRequest {
  readonly action: TeamAction;
  readonly target: string;
  readonly minutes?: number;
  readonly reason?: string;
  readonly rank?: string;
}

const base = (slug: string): string => `/api/public/team/${encodeURIComponent(slug)}`;

/** The demo banner switches between owner and supporter; the page follows at once. */
const DEMO_EVENT = 'mh-team-demo';

export function useTeamBoard(slug: string, key: string) {
  const client = useQueryClient();
  useEffect(() => {
    if (import.meta.env.MODE !== 'demo') return undefined;
    const again = (): void => void client.invalidateQueries({ queryKey: ['team-board'] });
    window.addEventListener(DEMO_EVENT, again);
    return () => window.removeEventListener(DEMO_EVENT, again);
  }, [client]);
  return useQuery({
    queryKey: ['team-board', slug, key],
    queryFn: () => api<TeamBoardView>(base(slug), { headers: { [KEY_HEADER]: key } }),
    refetchInterval: REFRESH_MS,
    enabled: key !== '',
    retry: false,
  });
}

export function useTeamAction(slug: string, key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: TeamRequest) =>
      api<{ ok: true }>(`${base(slug)}/action`, {
        method: 'POST',
        body: request,
        headers: { [KEY_HEADER]: key },
      }),
    // The game carries it out within a second or two; then the page shows it.
    onSuccess: () =>
      setTimeout(() => void client.invalidateQueries({ queryKey: ['team-board', slug] }), ACTION_SETTLE_MS),
  });
}

export function useTeamRules(slug: string, key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rules: string[]) =>
      api<{ ok: true }>(`${base(slug)}/rules`, {
        method: 'PUT',
        body: { rules },
        headers: { [KEY_HEADER]: key },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['team-board', slug] }),
  });
}

export function useTeamSettings(slug: string, key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<TeamSettings>) =>
      api<{ ok: true }>(`${base(slug)}/settings`, {
        method: 'PUT',
        body: changes,
        headers: { [KEY_HEADER]: key },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['team-board', slug] }),
  });
}

export const can = (view: TeamBoardView, ability: TeamAbility): boolean =>
  view.me.abilities.includes(ability);
