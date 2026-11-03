import { useTranslation } from 'react-i18next';
import { Suspense, type ReactElement } from 'react';
import { Skeleton } from '@/components/ui/misc';
import { lazyPage } from '@/lib/lazy-page';
import { ConsoleView } from './console/ConsoleView';
import { CrashCard } from './overview/CrashCard';
import { DownloadInfo } from '@/components/download-info';
import { Progress } from '@/components/ui/misc';
import { LiveTiles } from './overview/LiveTiles';
import { useServer } from './ServerLayout';
import { GameFilesCard } from './settings/GameFilesCard';

const LiveCharts = lazyPage(() => import('./overview/LiveCharts'));
const StatsChart = lazyPage(() => import('./overview/StatsChart'));

/** The first tab, as at a hoster: the console on top, then the live numbers and charts. */
export function ConsoleHome(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const showCrash = server.crash && (server.live.state === 'crashed' || server.live.state === 'stopped');
  const running = server.live.state === 'running' || server.live.state === 'starting';
  return (
    <>
      {showCrash && server.crash ? (
        <CrashCard serverId={server.id} crash={server.crash} canControl={can('control')} />
      ) : null}
      {server.live.download && server.live.progress !== null ? (
        <section className="grid gap-2 rounded-[16px] border border-warning/40 bg-card p-4 shadow-card">
          <div className="flex items-center justify-between gap-3 text-sm">
            <b>{t('card.downloading')}</b>
            <span className="tabular font-bold">{server.live.progress} %</span>
          </div>
          <Progress value={server.live.progress} tone="warning" className="mh-shimmer" />
          <DownloadInfo download={server.live.download} />
        </section>
      ) : null}
      {can('files') ? <GameFilesCard server={server} onlyMissing /> : null}
      {can('console') ? (
        <div className="rounded-[16px] border border-border bg-card p-3 sm:p-4">
          <ConsoleView
            serverId={server.id}
            edition={server.edition}
            players={server.live.players}
            running={running}
            canSend={can('commands')}
            className="h-[520px]"
          />
        </div>
      ) : null}
      <LiveTiles server={server} />
      <Suspense fallback={<Skeleton className="h-[220px] rounded-[14px]" />}>
        <LiveCharts server={server} />
      </Suspense>
      <Suspense fallback={<Skeleton className="h-[280px] rounded-[16px]" />}>
        <StatsChart serverId={server.id} />
      </Suspense>
    </>
  );
}
