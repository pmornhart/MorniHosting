import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ServerNetworkInfo } from '@mornihosting/shared';
import { TabIntro } from '@/components/tab-intro';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useSession } from '@/features/auth/session';
import { ConnectionCard } from '../overview/ConnectionCard';
import { useServer } from '../ServerLayout';
import { GEYSER_SOFTWARE, GeyserCard } from '../settings/GeyserCard';
import { VOICE_CHAT_SOFTWARE, VoiceChatCard } from '../settings/VoiceChatCard';
import { ViaCard } from '../settings/ViaCard';
import { VIA_SOFTWARE } from '@mornihosting/shared';

/** Shown when the server is part of a network (as proxy or behind it). */
function useNetworkInfo(serverId: string): ServerNetworkInfo | null {
  const { data } = useQuery({
    queryKey: ['server', serverId, 'network'],
    queryFn: () => api<{ network: ServerNetworkInfo | null }>(`/api/servers/${serverId}/network`),
  });
  return data?.network ?? null;
}

function NetworkMembership({ info }: { readonly info: ServerNetworkInfo | null }): ReactElement | null {
  const { t } = useTranslation();
  const { me } = useSession();
  if (!info) return null;
  return (
    <Card className="flex min-w-0 flex-wrap items-center gap-3 border-primary/40 p-4">
      <Waypoints className="size-5 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        {info.role === 'proxy'
          ? t('networkInfo.proxy', { network: info.networkName })
          : t('networkInfo.member', { network: info.networkName, name: info.memberName })}
      </p>
      {me.user.isAdmin ? (
        <Link
          to="/networks"
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          {t('networkInfo.manage')}
        </Link>
      ) : null}
    </Card>
  );
}

/** Address, reachability from outside, Bedrock players (Geyser) and voice chat: everything about connecting. */
export default function NetworkTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const config = can('config');
  const network = useNetworkInfo(server.id);
  // Behind a proxy, Bedrock players come in through the proxy's Geyser.
  const member = network?.role === 'member';
  return (
    <>
      <TabIntro title={t('network.title')} text={t('network.text')} />
      <NetworkMembership info={network} />
      <ConnectionCard server={server} />
      {config && !member && GEYSER_SOFTWARE.includes(server.software) ? <GeyserCard server={server} /> : null}
      {can('plugins') && VIA_SOFTWARE.includes(server.software) ? <ViaCard server={server} /> : null}
      {config && VOICE_CHAT_SOFTWARE.includes(server.software) ? <VoiceChatCard server={server} /> : null}
    </>
  );
}
