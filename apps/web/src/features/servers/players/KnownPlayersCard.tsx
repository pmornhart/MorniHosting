import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search, UsersRound } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { KnownPlayer } from '@mornihosting/shared';
import { PlayerHead } from '@/components/server-visuals';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatRelative } from '@/lib/format';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Every player who ever joined: search and open one for inventory, stats and chat (also offline). */
export function KnownPlayersCard({ serverId, live }: { serverId: string; live: string }): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data } = useQuery({
    queryKey: ['players-known', serverId, live],
    queryFn: () => api<KnownPlayer[]>(`/api/servers/${serverId}/players/known`),
  });
  const shown = (data ?? []).filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Card className="grid gap-3 p-5">
      <div className="grid gap-1">
        <CardTitle className="flex items-center gap-2">
          <UsersRound className="size-5 text-primary" aria-hidden />
          {t('playerDetail.listTitle', { count: data?.length ?? 0 })}
        </CardTitle>
        <CardDescription>{t('playerDetail.listText')}</CardDescription>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('playerDetail.search')}
          className="pl-9"
          aria-label={t('playerDetail.search')}
        />
      </div>
      {data && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data.length ? t('playerDetail.noMatch') : t('playerDetail.nobodyYet')}
        </p>
      ) : null}
      <ul className="grid gap-1.5">
        {shown.map((p) => (
          <li key={p.uuid}>
            <Link
              to={p.uuid}
              className="group flex min-w-0 items-center gap-3 rounded-[10px] border border-transparent bg-secondary/40 px-3 py-2 hover:border-primary/40 hover:bg-secondary"
            >
              <PlayerHead name={p.name} className="size-8 shrink-0 rounded-[6px]" />
              <span className="grid min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <b className="truncate text-[14px] font-semibold">{p.name}</b>
                  <span
                    className={cn(
                      'rounded-[5px] px-1.5 py-px text-[10px] font-bold uppercase',
                      p.online ? 'bg-success text-background' : 'bg-destructive text-white',
                    )}
                  >
                    {p.online ? t('playerDetail.online') : t('playerDetail.offline')}
                  </span>
                  {p.op ? <span className="text-[11px] font-bold text-success">OP</span> : null}
                </span>
                <span className="truncate text-[12px] text-muted-foreground">
                  {p.savedAt ? t('playerDetail.lastSeen', { when: formatRelative(p.savedAt) }) : p.uuid}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
