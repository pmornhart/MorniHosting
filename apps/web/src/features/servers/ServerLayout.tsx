import { useQuery } from '@tanstack/react-query';
import type { LayoutGrid } from 'lucide-react';
import {
  Archive,
  CalendarClock,
  Folder,
  Box,
  MoreHorizontal,
  Network,
  Play,
  Puzzle,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  UserPlus,
  UsersRound,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { SOFTWARE, isGameId, type ServerDetail, type ServerPermission } from '@mornihosting/shared';
import { OtherGameScene } from '@/components/game-card';
import { GameScene } from '@/components/art';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/page';
import { GameArt } from '@/components/project-logo';
import { ServerIcon } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { versionLabel } from '@/lib/format';
import { useServerAction } from '@/features/dashboard/ServerCard';
import { serverQuery } from './live';
import { useShareInfo } from './overview/share';

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
/** Height of the server head that stays in place while scrolling, for menus sticking below it. */
const HEAD_HEIGHT_VAR = '--server-head-height';

export interface ServerOutletContext {
  readonly server: ServerDetail;
  readonly can: (permission: ServerPermission) => boolean;
}

export function useServer(): ServerOutletContext {
  return useOutletContext<ServerOutletContext>();
}

interface TabDef {
  readonly to: string;
  readonly key: string;
  readonly icon: typeof LayoutGrid;
  readonly permission: ServerPermission | null;
  readonly show: (server: ServerDetail) => boolean;
}

const TABS: readonly TabDef[] = [
  { to: '', key: 'console', icon: SquareTerminal, permission: null, show: () => true },
  {
    to: 'players',
    key: 'players',
    icon: UsersRound,
    permission: 'players',
    show: (s) => !SOFTWARE[s.software].proxy && !isGameId(s.software),
  },
  { to: 'settings', key: 'settings', icon: SlidersHorizontal, permission: 'config', show: () => true },
  { to: 'files', key: 'files', icon: Folder, permission: 'files', show: () => true },
  { to: 'version', key: 'version', icon: Box, permission: 'config', show: (s) => !isGameId(s.software) },
  {
    to: 'content',
    key: 'plugins',
    icon: Puzzle,
    permission: 'plugins',
    show: (s) => SOFTWARE[s.software].content !== 'none',
  },
  { to: 'backups', key: 'backups', icon: Archive, permission: 'backups', show: () => true },
  { to: 'network', key: 'network', icon: Network, permission: null, show: () => true },
  { to: 'schedules', key: 'schedules', icon: CalendarClock, permission: 'schedules', show: () => true },
  { to: 'team', key: 'team', icon: UserPlus, permission: null, show: () => true },
  { to: 'advanced', key: 'advanced', icon: ShieldCheck, permission: 'config', show: () => true },
];

function ServerActions({ server, can }: ServerOutletContext): ReactElement | null {
  const { t } = useTranslation();
  const action = useServerAction(server.id);
  const [confirmKill, setConfirmKill] = useState(false);
  if (!can('control')) return null;
  const state = server.live.state;
  const running = state === 'running' || state === 'starting';
  return (
    <div className="flex flex-wrap gap-2">
      {state === 'running' ? (
        <Button variant="secondary" disabled={action.isPending} onClick={() => action.mutate('restart')}>
          <RotateCw />
          {t('actions.restart')}
        </Button>
      ) : null}
      {running ? (
        <Button
          variant="danger"
          className="bg-[#dc2626] text-white hover:bg-[#b91c1c] hover:opacity-100"
          disabled={action.isPending}
          onClick={() => action.mutate('stop')}
        >
          <Square />
          {t('actions.stop')}
        </Button>
      ) : null}
      {state === 'stopped' || state === 'crashed' ? (
        <Button disabled={action.isPending} onClick={() => action.mutate('start')}>
          <Play />
          {t('actions.start')}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="icon" aria-label={t('common.more')}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem destructive disabled={state === 'stopped'} onSelect={() => setConfirmKill(true)}>
            <Zap />
            {t('actions.kill')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmKill}
        onOpenChange={setConfirmKill}
        title={t('actions.killConfirmTitle')}
        description={t('actions.killConfirmText')}
        confirmLabel={t('actions.kill')}
        onConfirm={async () => {
          await action.mutateAsync('kill');
        }}
      />
    </div>
  );
}

/** "Java-Port" when the server also takes Bedrock players, "Bedrock-Port" on Bedrock servers, else just "Port". */
function portLabelKey(server: ServerDetail): string {
  if (server.edition === 'bedrock') return 'server.bedrockPortLabel';
  return server.geyser ? 'server.javaPortLabel' : 'server.portLabel';
}

/** A label and value side by side, as in "PORT: 25565". */
function InfoChip({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] font-bold uppercase tracking-wide">
      {label}:
      <span className="rounded-[6px] bg-background/70 px-2 py-0.5 font-mono text-[14px] font-medium normal-case tracking-normal">
        {value}
      </span>
      {hint ? (
        <span className="text-[12px] font-medium normal-case tracking-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The head of every server page, laid out like a hoster's panel: a banner, the server picture, the address
 * to connect with, IP and ports, start/stop, and the tabs. Below the banner it stays in place while the page
 * scrolls (on large screens).
 */
function ServerHead({ server, can, children }: ServerOutletContext & { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const share = useShareInfo(server);
  const state = server.live.state;
  const online = state === 'running';
  const ip = share ? (share.data.publicIp ?? share.data.lanIp) : null;
  const art = isGameId(server.edition) ? server.edition : server.edition === 'bedrock' ? 'bedrock' : 'java';
  const head = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  // Side menus (settings) stick right below the part of the head that stays: its height without the banner.
  useEffect(() => {
    const element = head.current;
    if (!element) return undefined;
    const measure = (): void =>
      document.documentElement.style.setProperty(
        HEAD_HEIGHT_VAR,
        `${element.offsetHeight - (banner.current?.offsetHeight ?? 0)}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(HEAD_HEIGHT_VAR);
    };
  }, []);
  return (
    <div
      ref={head}
      className="relative z-20 -mx-4 -mt-6 border-b border-border bg-card sm:-mx-8 sm:-mt-7 lg:sticky lg:-top-36"
    >
      <div ref={banner} className="relative h-24 overflow-hidden bg-secondary lg:h-36">
        <GameArt
          game={art}
          className="absolute inset-0 size-full object-cover object-[50%_35%]"
          fallback={
            isGameId(art) ? (
              <OtherGameScene game={art} />
            ) : (
              <GameScene game={art} className="absolute inset-0 size-full" />
            )
          }
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-card" />
      </div>
      <div className="grid gap-4 px-4 pb-1 sm:px-8">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <ServerIcon
            id={server.id}
            software={server.software}
            hasIcon={server.hasIcon}
            className="relative z-10 -mt-12 size-24 shrink-0 rounded-[16px] shadow-float ring-4 ring-card lg:-mt-16 lg:size-28"
          />
          <div className="grid min-w-0 flex-1 basis-64 gap-2">
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[22px] font-bold leading-tight tracking-[-0.02em]">
              <span className="min-w-0 truncate">{server.name}</span>
              <span className="text-[13px] font-medium text-muted-foreground">
                {t('server.meta', {
                  software: SOFTWARE[server.software].label,
                  version: versionLabel(server.software, server.version),
                  edition: isGameId(server.edition)
                    ? t('games.dedicated')
                    : server.edition === 'java'
                      ? 'Java'
                      : 'Bedrock',
                  port: server.port,
                })}
              </span>
            </h1>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('server.connect')}
            </span>
            {share?.shareAddress ? (
              <span className="inline-flex w-fit max-w-full items-center rounded-[10px] bg-background/80">
                <span className="min-w-0 truncate px-3 py-2.5 font-mono text-[15px] sm:px-4 sm:text-[18px]">
                  {share.shareAddress}
                </span>
                <CopyButton
                  text={share.shareAddress}
                  className="mr-1.5 border-l border-border"
                  toastText={t('card.addressCopied')}
                />
              </span>
            ) : (
              <Skeleton className="h-11 w-64" />
            )}
          </div>
          <div className="pb-1">
            <ServerActions server={server} can={can} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {ip ? <InfoChip label="IP" value={ip} /> : null}
          <InfoChip
            label={t(portLabelKey(server))}
            value={String(share?.sharePort ?? server.port)}
            hint={server.edition === 'bedrock' ? t('server.bedrockPortHint') : undefined}
          />
          {server.gamePorts.slice(1).map((p) => (
            <InfoChip
              key={`${p.key}-${p.protocol}`}
              label={t(`games.ports.${p.key}`, { defaultValue: p.key })}
              value={`${p.port}/${p.protocol.toUpperCase()}`}
            />
          ))}
          {server.geyser && share?.bedrockPort ? (
            <InfoChip
              label={t('server.bedrockPortLabel')}
              value={String(share.bedrockPort)}
              hint={t('server.bedrockPortHint')}
            />
          ) : null}
          <span
            data-testid="server-state"
            className={cn(
              'inline-flex items-center gap-1.5 text-[15px] font-bold',
              online ? 'text-success' : 'text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                online ? 'mh-ping bg-success text-success' : 'bg-muted-foreground',
              )}
            />
            {t(`states.${state}`)}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ServerLayout(): ReactElement {
  const { t } = useTranslation();
  const { serverId = '' } = useParams();
  const { data: server, error, isPending } = useQuery(serverQuery(serverId));

  if (isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-11" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (error || !server) {
    const missing = error instanceof ApiError && [HTTP_NOT_FOUND, HTTP_FORBIDDEN].includes(error.status);
    return <EmptyState title={missing ? t('server.notFound') : t('errors.generic')} />;
  }

  const can = (permission: ServerPermission): boolean => server.permissions.includes(permission);
  const tabs = TABS.filter((tab) => tab.show(server) && (!tab.permission || can(tab.permission)));
  const contentTab = SOFTWARE[server.software].content === 'mods' ? 'mods' : 'plugins';
  const context: ServerOutletContext = { server, can };

  return (
    <>
      <ServerHead server={server} can={can}>
        <nav aria-label={server.name} className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((tab) => (
            <NavLink
              key={tab.key}
              to={tab.to}
              end={tab.to === ''}
              className={({ isActive }) =>
                cn(
                  '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-3 text-[14px] font-semibold text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-4',
                  isActive && 'border-primary text-foreground',
                )
              }
            >
              <tab.icon aria-hidden />
              {t(`server.tabs.${tab.key === 'plugins' ? contentTab : tab.key}`)}
            </NavLink>
          ))}
        </nav>
      </ServerHead>
      <Outlet context={context} />
    </>
  );
}
