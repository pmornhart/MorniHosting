import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Clock, Play, Square, SquareTerminal, TriangleAlert } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useContentUpdates } from '@/features/servers/content/updates';
import { DownloadInfo } from '@/components/download-info';
import { Link, useNavigate } from 'react-router';
import { SOFTWARE, isGameId, type ServerAction, type ServerSummary } from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { PlayerHead, ServerIcon, StatePill } from '@/components/server-visuals';
import { Sparkline } from '@/components/sparkline';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/misc';
import { Tag } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { formatMemoryMb, formatNumber, versionLabel } from '@/lib/format';
import { useSession } from '@/features/auth/session';
import { serversQuery, useLiveHistory } from '@/features/servers/live';

const MAX_HEADS = 4;
const CPU_SCALE = 100;
/** Shown as a pulsing bar while the start has no measurable progress. */
const INDETERMINATE_PERCENT = 60;
const MODDED: readonly string[] = ['forge', 'neoforge'];

export function useServerAction(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: ServerAction) =>
      api(`/api/servers/${serverId}/actions/${action}`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
    },
  });
}

function Stat({ label, value, chart }: { label: string; value: string; chart: ReactNode }): ReactElement {
  return (
    <div className="grid gap-0.5 rounded-[10px] bg-secondary px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular text-[15px] font-bold">{value}</span>
      <div className="mt-1">{chart}</div>
    </div>
  );
}

function Body({ server }: { server: ServerSummary }): ReactElement {
  const { t } = useTranslation();
  const samples = useLiveHistory(server.id);
  const live = server.live;
  if (live.state === 'running') {
    const mem = live.memoryMb ?? 0;
    return (
      <div className="grid grid-cols-2 gap-2.5">
        <Stat
          label={t('card.memory')}
          value={`${formatMemoryMb(mem)} / ${formatMemoryMb(server.memoryMb)}`}
          chart={<Sparkline values={samples.map((s) => s.mem)} max={server.memoryMb} />}
        />
        <Stat
          label={t('card.cpu')}
          value={`${formatNumber(live.cpuPercent ?? 0)} %`}
          chart={<Sparkline values={samples.map((s) => s.cpu)} max={CPU_SCALE} />}
        />
      </div>
    );
  }
  if (live.state === 'starting' || live.state === 'installing') {
    return (
      <div className="grid gap-2">
        <div className="flex items-center justify-between text-[13px] text-muted-foreground">
          <span>{live.progress !== null ? t('card.downloading') : t('card.loadingWorld')}</span>
          {live.progress !== null ? (
            <span className="tabular font-semibold text-foreground">{live.progress} %</span>
          ) : null}
        </div>
        <Progress
          value={live.progress ?? INDETERMINATE_PERCENT}
          tone="warning"
          className={live.progress === null ? 'animate-pulse' : undefined}
        />
        <DownloadInfo download={live.download ?? null} />
        {MODDED.includes(server.software) ? (
          <p className="flex gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5 text-[13px]">
            <Clock className="mt-0.5 size-4 shrink-0" />
            {t('card.moddedHint')}
          </p>
        ) : null}
      </div>
    );
  }
  if (live.state === 'crashed' && server.crash) {
    return (
      <p className="flex gap-2 rounded-[10px] bg-destructive-soft px-3 py-2.5 text-[13px]">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          <b>{t(`crash.${server.crash.ruleId}.title`)}.</b>{' '}
          {t(`crash.${server.crash.ruleId}.text`, server.crash.params)}
        </span>
      </p>
    );
  }
  return (
    <p className="flex gap-2 rounded-[10px] bg-secondary px-3 py-2.5 text-[13px] text-muted-foreground">
      <Clock className="mt-0.5 size-4 shrink-0" />
      {t('card.stoppedHint')}
    </p>
  );
}

export function ServerCard({ server }: { server: ServerSummary }): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useSession();
  const action = useServerAction(server.id);
  const live = server.live;
  const canControl = can(server.id, 'control');
  const players = live.players;
  const footerAction = (() => {
    if (live.state === 'crashed') {
      return (
        <Button size="sm" onClick={() => navigate(`/servers/${server.id}`)}>
          {t('card.crashSolution')}
        </Button>
      );
    }
    if (!canControl) return null;
    if (live.state === 'running') {
      return (
        <Button
          size="sm"
          variant="secondary"
          disabled={action.isPending}
          onClick={() => action.mutate('stop')}
        >
          <Square />
          {t('actions.stop')}
        </Button>
      );
    }
    if (live.state === 'stopped') {
      return (
        <Button size="sm" disabled={action.isPending} onClick={() => action.mutate('start')}>
          <Play />
          {t('actions.start')}
        </Button>
      );
    }
    return (
      <Button size="sm" variant="ghost" onClick={() => navigate(`/servers/${server.id}/console`)}>
        <SquareTerminal />
        {t('actions.console')}
      </Button>
    );
  })();
  const nobody = live.state === 'starting' ? t('card.nobodyYet') : t('card.nobodyOnline');
  const updateCount = useContentUpdates()[server.id] ?? 0;

  return (
    <Card className="mh-lift group grid grid-rows-[auto_auto_auto_1fr] gap-3.5 p-[18px]">
      <div className="flex items-center gap-3">
        <ServerIcon id={server.id} software={server.software} hasIcon={server.hasIcon} className="mh-hop" />
        <Link to={`/servers/${server.id}`} className="min-w-0 flex-1 after:absolute">
          <b className="block truncate text-[15px] font-bold hover:underline">{server.name}</b>
          {/* Wraps instead of overlapping when the name is long ("Counter-Strike 2" + "Immer aktuell"). */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
            <span className="whitespace-nowrap">
              {server.software === 'bedrock' ? 'Bedrock' : SOFTWARE[server.software].label}
            </span>
            <Tag>{versionLabel(server.software, server.version)}</Tag>
            {isGameId(server.edition) ? null : `· ${server.edition === 'java' ? 'Java' : 'Bedrock'}`}
          </span>
        </Link>
        <StatePill state={live.state} className="shrink-0 self-start" />
      </div>
      {updateCount ? (
        <Link
          to={`/servers/${server.id}/content?view=installed`}
          className="relative z-10 -mt-1 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[12px] font-semibold text-primary hover:bg-primary/25"
        >
          <ArrowUpCircle className="size-3.5" aria-hidden />
          {t('content.updatesBadge', { count: updateCount })}
        </Link>
      ) : null}
      <div className="flex items-center gap-2 rounded-[8px] border border-border bg-secondary py-1 pl-2.5 pr-1 font-mono text-[13px] font-medium">
        <span className="min-w-0 flex-1 truncate">{server.address}</span>
        <CopyButton
          text={server.address}
          label={t('card.copyAddress')}
          toastText={t('card.addressCopied')}
          className="size-7"
        />
      </div>
      <Body server={server} />
      {/* The footer sits at the bottom, so stopped and running cards in a row line up. */}
      <div className="flex items-center gap-2 self-end">
        {players.length ? (
          <span className="flex items-center">
            {players.slice(0, MAX_HEADS).map((name, i) => (
              <PlayerHead
                key={name}
                name={name}
                className={i ? '-ml-1.5 border-2 border-card' : 'border-2 border-card'}
              />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          {players.length
            ? t('card.playersOnline', { online: live.playersOnline, max: live.playersMax })
            : nobody}
        </span>
        {footerAction}
      </div>
    </Card>
  );
}
