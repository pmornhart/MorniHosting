import { DiscordLinkPage } from '@/features/admin/DiscordLinkPage';
import { ApprovalsPage } from '@/features/approvals/ApprovalsPage';
import { Suspense, type ReactElement } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { Skeleton } from '@/components/ui/misc';
import { lazyPage } from '@/lib/lazy-page';
import { AccountPage } from '@/features/admin/AccountPage';
import { AuditPage } from '@/features/admin/AuditPage';
import { NotificationsPage } from '@/features/admin/NotificationsPage';
import { PanelSettingsPage } from '@/features/admin/PanelSettingsPage';
import { UsersPage } from '@/features/admin/UsersPage';
import { CreateServerPage } from '@/features/servers/create/CreateServerPage';
import { ImportServerPage } from '@/features/servers/create/ImportServerPage';
import { ConsoleHome } from '@/features/servers/ConsoleHome';
import { ServerLayout } from '@/features/servers/ServerLayout';

const VersionTab = lazyPage(() => import('@/features/servers/version/VersionTab'));
const NetworkTab = lazyPage(() => import('@/features/servers/network/NetworkTab'));
const AdvancedTab = lazyPage(() => import('@/features/servers/advanced/AdvancedTab'));
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
  { path: 'servers/new', element: <CreateServerPage /> },
  { path: 'notifications', element: <NotificationsPage /> },
  { path: 'users', element: <UsersPage /> },
  { path: 'approvals', element: <ApprovalsPage /> },
  { path: 'settings', element: <PanelSettingsPage /> },
  { path: 'admin', element: <Navigate to="/settings" replace /> },
  { path: 'audit', element: <AuditPage /> },
  { path: 'account', element: <AccountPage /> },
  { path: 'discord-link', element: <DiscordLinkPage /> },
  { path: 'servers/import', element: <ImportServerPage /> },
  {
    path: 'servers/:serverId',
    element: <ServerLayout />,
    children: [
      { index: true, element: <ConsoleHome /> },
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
