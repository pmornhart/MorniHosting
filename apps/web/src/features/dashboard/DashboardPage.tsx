import { MyRequests } from './MyRequests';
import { Plus, Server, Upload, User, Users } from 'lucide-react';
import type { ReactElement } from 'react';
import type { ServerSummary } from '@mornihosting/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { useSession } from '@/features/auth/session';
import { useServers } from '@/features/servers/live';
import { HostStrip } from './HostStrip';
import { MyPaymentsHint } from '@/features/admin/PaymentsSection';
import { ServerCard } from './ServerCard';

const SKELETON_CARDS = 3;
const GRID = 'grid gap-4 md:grid-cols-2 xl:grid-cols-3';

/** A server is mine when I own it – or, as an admin, when nobody does (admins create servers without the role). */
function isMine(server: ServerSummary, userId: number, isAdmin: boolean): boolean {
  const owners = server.owners ?? [];
  return owners.some((o) => o.id === userId) || (isAdmin && owners.length === 0);
}

/**
 * My servers first; below them the servers of other people that run on this panel (with whose they are). Only one
 * kind: no headings, just the cards.
 */
function ServerGroups({
  servers,
  userId,
  isAdmin,
}: {
  servers: readonly ServerSummary[];
  userId: number;
  isAdmin: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const mine = servers.filter((s) => isMine(s, userId, isAdmin));
  const others = servers.filter((s) => !isMine(s, userId, isAdmin));
  if (!mine.length || !others.length) {
    return (
      <section className={GRID} aria-label={t('dashboard.title')}>
        {servers.map((s) => (
          <ServerCard key={s.id} server={s} showOwner={!isMine(s, userId, isAdmin)} />
        ))}
      </section>
    );
  }
  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-labelledby="mine-heading">
        <h2 id="mine-heading" className="flex items-center gap-2 text-[15px] font-semibold">
          <User className="size-4 text-primary" aria-hidden />
          {t('dashboard.mine')}
          <span className="text-[13px] font-normal text-muted-foreground">{mine.length}</span>
        </h2>
        <div className={GRID}>
          {mine.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </div>
      </section>
      <section className="grid gap-3" aria-labelledby="others-heading">
        <div>
          <h2 id="others-heading" className="flex items-center gap-2 text-[15px] font-semibold">
            <Users className="size-4 text-primary" aria-hidden />
            {t('dashboard.others')}
            <span className="text-[13px] font-normal text-muted-foreground">{others.length}</span>
          </h2>
          <p className="text-[13px] text-muted-foreground">{t('dashboard.othersText')}</p>
        </div>
        <div className={GRID}>
          {others.map((s) => (
            <ServerCard key={s.id} server={s} showOwner />
          ))}
        </div>
      </section>
    </div>
  );
}

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
      <MyPaymentsHint />
      {canCreate ? null : <MyRequests />}
      {isPending ? (
        <div className={GRID}>
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
        <ServerGroups servers={servers} userId={me.user.id} isAdmin={me.user.isAdmin} />
      ) : null}
    </>
  );
}
