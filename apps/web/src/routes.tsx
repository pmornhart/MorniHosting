import { Suspense, type ComponentType, type ReactElement } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { Skeleton } from '@/components/ui/misc';
import { lazyPage } from '@/lib/lazy-page';
import { ServerLayout } from '@/features/servers/ServerLayout';

/** A page module without a default export, loaded only when it is opened. */
function namedPage<K extends string>(
  load: () => Promise<Record<K, unknown>>,
  key: K,
): ReturnType<typeof lazyPage<object>> {
  return lazyPage<object>(async () => ({ default: (await load())[key] as ComponentType<object> }));
}

const DiscordLinkPageLazy = namedPage(() => import('@/features/admin/DiscordLinkPage'), 'DiscordLinkPage');
const ApprovalsPageLazy = namedPage(() => import('@/features/approvals/ApprovalsPage'), 'ApprovalsPage');
const AccountPageLazy = lazyPage<object>(async () => ({
  default: (await import('@/features/admin/AccountPage')).AccountPage,
}));
const AuditPageLazy = namedPage(() => import('@/features/admin/AuditPage'), 'AuditPage');
const NotificationsPageLazy = namedPage(
  () => import('@/features/admin/NotificationsPage'),
  'NotificationsPage',
);
const PanelSettingsPageLazy = namedPage(
  () => import('@/features/admin/PanelSettingsPage'),
  'PanelSettingsPage',
);
const UsersPageLazy = namedPage(() => import('@/features/admin/UsersPage'), 'UsersPage');
const CreateServerPageLazy = namedPage(
  () => import('@/features/servers/create/CreateServerPage'),
  'CreateServerPage',
);
const ImportServerPageLazy = namedPage(
  () => import('@/features/servers/create/ImportServerPage'),
  'ImportServerPage',
);
const ConsoleHomeLazy = namedPage(() => import('@/features/servers/ConsoleHome'), 'ConsoleHome');
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
