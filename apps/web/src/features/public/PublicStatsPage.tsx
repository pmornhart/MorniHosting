import { useQuery } from '@tanstack/react-query';
import { Clock, Crown, Footprints, Skull, Swords, Trophy, Users } from 'lucide-react';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import type { PublicPlayer, PublicStats } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { BrandMark, PlayerHead } from '@/components/server-visuals';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { setLanguage } from '@/i18n';
import { formatCompact, formatDuration, formatRelative } from '@/lib/format';

/**
 * The public statistics page of a server (Craft Attack): who is online, who played the most, who died how often
 * and what got them. No login; it refreshes itself.
 */

const REFRESH_MS = 30_000;
const TOP = 5;
const FEED = 25;
const MS_PER_SECOND = 1000;

interface Board {
  readonly key: string;
  readonly icon: ReactNode;
  readonly value: (p: PublicPlayer) => number;
  readonly format: (n: number) => string;
}

function Tile({ icon, label, value }: { icon: ReactNode; label: string; value: string }): ReactElement {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/12 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <b className="block truncate text-xl font-bold">{value}</b>
      </span>
    </Card>
  );
}

function Leaderboard({ board, players }: { board: Board; players: readonly PublicPlayer[] }): ReactElement {
  const { t } = useTranslation();
  const ranked = [...players]
    .filter((p) => board.value(p) > 0)
    .sort((a, b) => board.value(b) - board.value(a))
    .slice(0, TOP);
  return (
    <Card className="grid content-start gap-3 p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold">
        {board.icon}
        {t(`publicStats.boards.${board.key}`)}
      </h2>
      {ranked.length ? (
        <ol className="grid gap-1.5">
          {ranked.map((p, i) => (
            <li
              key={p.uuid}
              className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 even:bg-secondary/50"
            >
              <span className="w-5 text-center text-xs font-bold text-muted-foreground">
                {i === 0 ? <Crown className="mx-auto size-4 text-amber-400" aria-hidden /> : i + 1}
              </span>
              <PlayerHead name={p.name} className="size-7 rounded-[6px]" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
              <span className="text-sm tabular-nums text-muted-foreground">
                {board.format(board.value(p))}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t('publicStats.empty')}</p>
      )}
    </Card>
  );
}

export function PublicStatsPage(): ReactElement {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['public-stats', slug],
    queryFn: () => api<PublicStats>(`/api/public/stats/${encodeURIComponent(slug)}`),
    refetchInterval: REFRESH_MS,
  });
  // Visitors have no account: the page speaks the panel's language.
  const locale = data?.locale;
  useEffect(() => {
    if (locale) setLanguage(locale);
  }, [locale]);
  const seenText = (p: PublicPlayer): string => {
    if (p.online) return t('publicStats.playingNow');
    return p.lastSeen ? t('publicStats.lastSeen', { when: formatRelative(p.lastSeen) }) : '';
  };
  const hours = (seconds: number): string => formatDuration(seconds * MS_PER_SECOND) || '0';
  const boards: readonly Board[] = [
    {
      key: 'playTime',
      icon: <Clock className="size-4 text-primary" />,
      value: (p) => p.playTimeSeconds,
      format: hours,
    },
    {
      key: 'deaths',
      icon: <Skull className="size-4 text-destructive" />,
      value: (p) => p.deaths,
      format: String,
    },
    {
      key: 'kills',
      icon: <Swords className="size-4 text-amber-400" />,
      value: (p) => p.playerKills + p.mobKills,
      format: formatCompact,
    },
    {
      key: 'distance',
      icon: <Footprints className="size-4 text-sky-400" />,
      value: (p) => p.distanceBlocks,
      format: (n) => `${formatCompact(n)} ${t('publicStats.blocks')}`,
    },
  ];

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 text-center">
        <div className="grid gap-3">
          <BrandMark className="mx-auto size-12" />
          <h1 className="text-xl font-bold">{t('publicStats.missing')}</h1>
          <p className="text-sm text-muted-foreground">{t('publicStats.missingText')}</p>
        </div>
      </main>
    );
  }

  const totals = data
    ? {
        playTime: data.players.reduce((sum, p) => sum + p.playTimeSeconds, 0),
        deaths: data.players.reduce((sum, p) => sum + p.deaths, 0),
        kills: data.players.reduce((sum, p) => sum + p.playerKills + p.mobKills, 0),
      }
    : null;

  return (
    <main className="min-h-dvh bg-background pb-16">
      <header className="relative overflow-hidden border-b border-border bg-[radial-gradient(ellipse_at_top,var(--color-primary)/0.25,transparent_60%)]">
        <div className="mx-auto grid max-w-5xl gap-4 px-4 pt-10 pb-8 sm:px-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <BrandMark className="size-6" />
            MorniHosting
          </div>
          {data ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{data.name}</h1>
                <Pill tone={data.running ? 'ok' : 'neutral'} ping={data.running}>
                  {data.running
                    ? t('publicStats.online', { online: data.playersOnline, max: data.playersMax })
                    : t('publicStats.offline')}
                </Pill>
              </div>
              {data.motd ? <p className="text-muted-foreground">{data.motd}</p> : null}
              {data.address ? (
                <div className="flex w-fit max-w-full items-center gap-2 rounded-[12px] border border-border bg-card px-3 py-2">
                  <span className="text-xs text-muted-foreground">{t('publicStats.join')}</span>
                  <code className="truncate font-mono text-sm font-semibold">{data.address}</code>
                  <CopyButton text={data.address} />
                </div>
              ) : null}
            </>
          ) : (
            <Skeleton className="h-24" />
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-6 sm:px-6">
        {data && totals ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile
                icon={<Users className="size-5" />}
                label={t('publicStats.players')}
                value={String(data.players.length)}
              />
              <Tile
                icon={<Clock className="size-5" />}
                label={t('publicStats.playTime')}
                value={hours(totals.playTime)}
              />
              <Tile
                icon={<Skull className="size-5" />}
                label={t('publicStats.deaths')}
                value={String(totals.deaths)}
              />
              <Tile
                icon={<Swords className="size-5" />}
                label={t('publicStats.kills')}
                value={formatCompact(totals.kills)}
              />
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              {boards.map((board) => (
                <Leaderboard key={board.key} board={board} players={data.players} />
              ))}
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Card className="grid content-start gap-3 p-5">
                <h2 className="flex items-center gap-2 text-sm font-bold">
                  <Skull className="size-4 text-destructive" />
                  {t('publicStats.feed')}
                </h2>
                {data.deaths.length ? (
                  <ul className="grid gap-2">
                    {data.deaths.slice(0, FEED).map((d) => (
                      <li key={`${d.at}-${d.player}`} className="flex items-center gap-2.5 text-sm">
                        <PlayerHead name={d.player} className="size-7 rounded-[6px]" />
                        <span className="min-w-0 flex-1">
                          <b>{d.player}</b> {d.how}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(d.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('publicStats.noDeaths')}</p>
                )}
              </Card>

              <Card className="grid content-start gap-3 p-5">
                <h2 className="flex items-center gap-2 text-sm font-bold">
                  <Trophy className="size-4 text-primary" />
                  {t('publicStats.everyone')}
                </h2>
                <ul className="grid gap-1.5">
                  {data.players.map((p) => (
                    <li key={p.uuid} className="flex items-center gap-2.5">
                      <span className="relative">
                        <PlayerHead name={p.name} className="size-8 rounded-[7px]" />
                        {p.online ? (
                          <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-primary" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-sm">{p.name}</b>
                        <span className="block text-xs text-muted-foreground">{seenText(p)}</span>
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {hours(p.playTimeSeconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
            <p className="text-center text-xs text-muted-foreground">
              {t('publicStats.updated', { when: formatRelative(data.updatedAt) })}
            </p>
          </>
        ) : (
          <Skeleton className="h-96" />
        )}
      </div>
    </main>
  );
}
