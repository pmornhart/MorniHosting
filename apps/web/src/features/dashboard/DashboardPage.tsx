import { MyRequests } from './MyRequests';
import { Plus, Server, Upload } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { useSession } from '@/features/auth/session';
import { useServers } from '@/features/servers/live';
import { HostStrip } from './HostStrip';
import { ServerCard } from './ServerCard';

const SKELETON_CARDS = 3;

export function DashboardPage(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const { data: servers, isPending } = useServers();
  const running = servers?.filter((s) => s.live.state === 'running').length ?? 0;
  const players = servers?.reduce((sum, s) => sum + s.live.playersOnline, 0) ?? 0;
  const canCreate = me.user.canCreateServers;
  const createButtons = canCreate ? (
    <>
      <Button asChild variant="secondary">
        <Link to="/servers/import">
          <Upload />
          {t('dashboard.importServer')}
        </Link>
      </Button>
      <Button asChild>
        <Link to="/servers/new">
          <Plus />
          {t('dashboard.newServer')}
        </Link>
      </Button>
    </>
  ) : (
    <Button asChild>
      <Link to="/servers/new">
        <Plus />
        {t('nav.requestServer')}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={
          servers?.length
            ? t('dashboard.subtitle', {
                running,
                total: servers.length,
                players: t('dashboard.playersOnline', { count: players }),
              })
            : undefined
        }
        actions={createButtons}
      />
      {me.user.isAdmin ? <HostStrip /> : null}
      {canCreate ? null : <MyRequests />}
      {isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <Skeleton key={i} className="h-[280px] rounded-[16px]" />
          ))}
        </div>
      ) : null}
      {servers && !servers.length ? (
        <EmptyState
          icon={<Server />}
          title={t('dashboard.emptyTitle')}
          text={canCreate ? t('dashboard.emptyText') : t('dashboard.noAccess')}
          action={createButtons}
        />
      ) : null}
      {servers?.length ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={t('dashboard.title')}>
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </section>
      ) : null}
    </>
  );
}
