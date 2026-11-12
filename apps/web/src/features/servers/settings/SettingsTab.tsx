import { useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { SOFTWARE, isGameId } from '@mornihosting/shared';
import { EmptyState } from '@/components/page';
import { TabIntro } from '@/components/tab-intro';
import { useServer } from '../ServerLayout';
import { CraftAttackHelpCard } from './CraftAttackHelpCard';
import { GameFilesCard } from './GameFilesCard';
import { GameSettingsCard } from './GameSettingsCard';
import { GeneralCard } from './GeneralCard';
import { IconCard } from './IconCard';
import { PropertiesCard } from './PropertiesCard';
import { WorldsCard } from './WorldsCard';

const SECTIONS = ['general', 'game', 'worlds', 'icon'] as const;

/** Everything about one server on one page, with a section list to jump around. */
export default function SettingsTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const { hash } = useLocation();
  const proxy = SOFTWARE[server.software].proxy;
  // Other games have their own settings instead of server.properties, worlds and the server picture.
  const otherGame = isGameId(server.software);

  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  if (!can('config')) return <EmptyState title={t('server.noPermission')} />;
  // Bedrock players and voice chat live in the network tab, deleting in "Advanced".
  const sections = SECTIONS.filter(
    (s) => (!proxy || (s !== 'game' && s !== 'worlds')) && (!otherGame || s === 'general' || s === 'game'),
  );
  return (
    <>
      <TabIntro title={t('server.tabs.settings')} text={t('settings.intro')} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
        <nav
          aria-label={t('server.tabs.settings')}
          className="sticky top-[calc(var(--server-head-height,0px)+16px)] hidden gap-0.5 lg:grid"
        >
          {sections.map((s) => (
            <a
              key={s}
              href={`#s-${s}`}
              className="rounded-[10px] px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {t(`settings.sections.${s}`)}
            </a>
          ))}
        </nav>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
          <section id="s-general" className="scroll-mt-4">
            <GeneralCard key={`${server.id}-${server.memoryMb}-${server.version}`} server={server} />
          </section>
          {otherGame ? (
            <section id="s-game" className="grid scroll-mt-4 gap-5">
              <GameFilesCard server={server} />
              <GameSettingsCard server={server} />
            </section>
          ) : null}
          {proxy || otherGame ? null : (
            <section id="s-game" className="grid scroll-mt-4 gap-5">
              <CraftAttackHelpCard serverId={server.id} />
              <PropertiesCard server={server} />
            </section>
          )}
          {proxy || otherGame ? null : (
            <section id="s-worlds" className="scroll-mt-4">
              <WorldsCard server={server} />
            </section>
          )}
          {otherGame ? null : (
            <section id="s-icon" className="scroll-mt-4">
              <IconCard server={server} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
