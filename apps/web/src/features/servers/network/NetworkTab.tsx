import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { TabIntro } from '@/components/tab-intro';
import { ConnectionCard } from '../overview/ConnectionCard';
import { useServer } from '../ServerLayout';
import { GEYSER_SOFTWARE, GeyserCard } from '../settings/GeyserCard';
import { VOICE_CHAT_SOFTWARE, VoiceChatCard } from '../settings/VoiceChatCard';
import { ViaCard } from '../settings/ViaCard';
import { VIA_SOFTWARE } from '@mornihosting/shared';

/** Address, reachability from outside, Bedrock players (Geyser) and voice chat: everything about connecting. */
export default function NetworkTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const config = can('config');
  return (
    <>
      <TabIntro title={t('network.title')} text={t('network.text')} />
      <ConnectionCard server={server} />
      {config && GEYSER_SOFTWARE.includes(server.software) ? <GeyserCard server={server} /> : null}
      {can('plugins') && VIA_SOFTWARE.includes(server.software) ? <ViaCard server={server} /> : null}
      {config && VOICE_CHAT_SOFTWARE.includes(server.software) ? <VoiceChatCard server={server} /> : null}
    </>
  );
}
