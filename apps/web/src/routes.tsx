import { Suspense, type ReactElement } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { Skeleton } from '@/components/ui/misc';
import { lazyPage } from '@/lib/lazy-page';
import { ServerLayout } from '@/features/servers/ServerLayout';

/**
 * Pages with a named export, loaded only when they are opened. The export is picked by destructuring so that the
 * unused-code check (fallow) sees which export is used.
 */
const DiscordLinkPageLazy = lazyPage<object>(async () => {
  const { DiscordLinkPage } = await import('@/features/admin/DiscordLinkPage');
  return { default: DiscordLinkPage };
});
const ApprovalsPageLazy = lazyPage<object>(async () => {
  const { ApprovalsPage } = await import('@/features/approvals/ApprovalsPage');
  return { default: ApprovalsPage };
});
const AccountPageLazy = lazyPage<object>(async () => {
  const { AccountPage } = await import('@/features/admin/AccountPage');
  return { default: AccountPage };
});
const AuditPageLazy = lazyPage<object>(async () => {
  const { AuditPage } = await import('@/features/admin/AuditPage');
  return { default: AuditPage };
});
const NotificationsPageLazy = lazyPage<object>(async () => {
  const { NotificationsPage } = await import('@/features/admin/NotificationsPage');
  return { default: NotificationsPage };
});
const PanelSettingsPageLazy = lazyPage<object>(async () => {
  const { PanelSettingsPage } = await import('@/features/admin/PanelSettingsPage');
  return { default: PanelSettingsPage };
});
const UsersPageLazy = lazyPage<object>(async () => {
  const { UsersPage } = await import('@/features/admin/UsersPage');
  return { default: UsersPage };
});
const NetworksPageLazy = lazyPage<object>(async () => {
  const { NetworksPage } = await import('@/features/networks/NetworksPage');
  return { default: NetworksPage };
});
const CreateServerPageLazy = lazyPage<object>(async () => {
  const { CreateServerPage } = await import('@/features/servers/create/CreateServerPage');
  return { default: CreateServerPage };
});
const ImportServerPageLazy = lazyPage<object>(async () => {
  const { ImportServerPage } = await import('@/features/servers/create/ImportServerPage');
  return { default: ImportServerPage };
});
const ConsoleHomeLazy = lazyPage<object>(async () => {
  const { ConsoleHome } = await import('@/features/servers/ConsoleHome');
  return { default: ConsoleHome };
});
const VersionTab = lazyPage(() => import('@/features/servers/version/VersionTab'));
const NetworkTab = lazyPage(() => import('@/features/servers/network/NetworkTab'));
const AdvancedTab = lazyPage(() => import('@/features/servers/advanced/AdvancedTab'));
const PlayerDetailPage = lazyPage(() => import('@/features/servers/players/PlayerDetailPage'));
const TeamTab = lazyPage(() => import('@/features/servers/team/TeamTab'));
const ContentTab = lazyPage(() => import('@/features/servers/content/ContentTab'));
const BackupsTab = lazyPage(() => import('@/features/servers/backups/BackupsTab'));
const SchedulesTab = lazyPage(() => import('@/features/servers/schedules/SchedulesTab'));
const FilesTab = lazyPage(() => import('@/features/servers/files/FilesTab'));
const PlayersTab = lazyPage(() => import('@/features/servers/players/PlayersTab'));
const SettingsTab = lazyPage(() => import('@/features/servers/settings/SettingsTab'));

function Lazy({ children }: { children: ReactElement }): ReactElement {
  return <Suspense fallback={<Skeleton className="h-96 rounded-[16px]" />}>{children}</Suspense>;
}

/** Feature pages inside the app shell. */
export const appRoutes: RouteObject[] = [
  {
    path: 'servers/new',
    element: (
      <Lazy>
        <CreateServerPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'notifications',
    element: (
      <Lazy>
        <NotificationsPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'users',
    element: (
      <Lazy>
        <UsersPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'networks',
    element: (
      <Lazy>
        <NetworksPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'approvals',
    element: (
      <Lazy>
        <ApprovalsPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'settings',
    element: (
      <Lazy>
        <PanelSettingsPageLazy />
      </Lazy>
    ),
  },
  { path: 'admin', element: <Navigate to="/settings" replace /> },
  {
    path: 'audit',
    element: (
      <Lazy>
        <AuditPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'account',
    element: (
      <Lazy>
        <AccountPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'discord-link',
    element: (
      <Lazy>
        <DiscordLinkPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'servers/import',
    element: (
      <Lazy>
        <ImportServerPageLazy />
      </Lazy>
    ),
  },
  {
    path: 'servers/:serverId',
    element: <ServerLayout />,
    children: [
      {
        index: true,
        element: (
          <Lazy>
            <ConsoleHomeLazy />
          </Lazy>
        ),
      },
      // The console used to be its own tab; old links land on the first tab, where it is now.
      { path: 'console', element: <Navigate to=".." replace /> },
      {
        path: 'version',
        element: (
          <Lazy>
            <VersionTab />
          </Lazy>
        ),
      },
      {
        path: 'network',
        element: (
          <Lazy>
            <NetworkTab />
          </Lazy>
        ),
      },
      {
        path: 'team',
        element: (
          <Lazy>
            <TeamTab />
          </Lazy>
        ),
      },
      {
        path: 'advanced',
        element: (
          <Lazy>
            <AdvancedTab />
          </Lazy>
        ),
      },
      {
        path: 'content',
        element: (
          <Lazy>
            <ContentTab />
          </Lazy>
        ),
      },
      {
        path: 'files',
        element: (
          <Lazy>
            <FilesTab />
          </Lazy>
        ),
      },
      {
        path: 'backups',
        element: (
          <Lazy>
            <BackupsTab />
          </Lazy>
        ),
      },
      {
        path: 'schedules',
        element: (
          <Lazy>
            <SchedulesTab />
          </Lazy>
        ),
      },
      {
        path: 'players',
        element: (
          <Lazy>
            <PlayersTab />
          </Lazy>
        ),
      },
      {
        path: 'players/:uuid',
        element: (
          <Lazy>
            <PlayerDetailPage />
          </Lazy>
        ),
      },
      {
        path: 'settings',
        element: (
          <Lazy>
            <SettingsTab />
          </Lazy>
        ),
      },
    ],
  },
];
