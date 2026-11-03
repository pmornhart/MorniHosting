import { useState, type ReactElement, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isGameId, type ServerState } from '@mornihosting/shared';
import { playerFace } from '@/lib/pixel';
import { cn } from '@/lib/utils';
import { Badge, LogoMark } from './art';
import { blockOf, McBlock } from './mc-block';
import { Pill, type PillTone } from './ui/pill';

const STATE_TONES: Readonly<Record<ServerState, PillTone>> = {
  installing: 'warn',
  starting: 'warn',
  running: 'ok',
  stopping: 'warn',
  stopped: 'neutral',
  crashed: 'bad',
};

export function StatePill({ state, className }: { state: ServerState; className?: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <Pill tone={STATE_TONES[state]} ping={state === 'running'} className={className}>
      {t(`states.${state}`)}
    </Pill>
  );
}

/** The id the server switcher uses for "all servers". */
export const ALL_SERVERS = 'all';

export interface ServerIconProps {
  readonly id: string;
  readonly software: string;
  readonly hasIcon: boolean;
  readonly className?: string;
}

const iconVersions = new Map<string, number>();
const iconListeners = new Set<() => void>();

/** Call after a new icon was uploaded, so every place showing it loads the new picture. */
export function refreshServerIcon(id: string): void {
  iconVersions.set(id, Date.now());
  iconListeners.forEach((listener) => listener());
}

function useIconVersion(id: string): number {
  return useSyncExternalStore(
    (listener) => {
      iconListeners.add(listener);
      return () => iconListeners.delete(listener);
    },
    () => iconVersions.get(id) ?? 0,
  );
}

/** The server's own server-icon.png if it has one, otherwise the Minecraft block of its software. */
export function ServerIcon({ id, software, hasIcon, className }: ServerIconProps): ReactElement {
  const version = useIconVersion(id);
  const iconUrl = `/api/servers/${id}/icon${version ? `?v=${version}` : ''}`;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!hasIcon || failedUrl === iconUrl) {
    if (isGameId(software)) return <Badge glyph={`game-${software}`} seed={id} className={className} />;
    return id === ALL_SERVERS ? (
      <Badge glyph="all" className={className} />
    ) : (
      <McBlock kind={blockOf(software)} className={className} />
    );
  }
  return (
    <img
      src={iconUrl}
      alt=""
      onError={() => setFailedUrl(iconUrl)}
      className={cn('pixelated size-11 shrink-0 rounded-[10px] object-cover', className)}
    />
  );
}

const DEMO = import.meta.env.MODE === 'demo';
// Java account names: "Lena_Baut" has a skin to show, "Finn 2015" (a Bedrock gamertag) does not.
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_%5D%7B3%2C16%7D%24&flags=gm&testString=Lena_Baut%0AFinn%202015
const JAVA_NAME = /^[A-Za-z0-9_]{3,16}$/;

/** What mc-heads.net should look up: the given skin (a name or uuid), by default the name if it is a Java name. */
function skinOf(name: string, skin: string | null | undefined): string | null {
  if (skin !== undefined) return skin;
  return JAVA_NAME.test(name) ? name : null;
}

/**
 * A player's face from mc-heads.net; falls back to a drawn face offline or for Bedrock names.
 * `skin` picks the account explicitly (null: always draw), e.g. the user's linked Minecraft account.
 */
export function PlayerHead({
  name,
  skin,
  className,
}: {
  name: string;
  skin?: string | null;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const lookup = skinOf(name, skin);
  // The demo cannot load pictures from other sites, so it draws the faces itself.
  const usable = !failed && !DEMO && lookup !== null;
  return (
    <img
      src={usable ? `https://mc-heads.net/avatar/${encodeURIComponent(lookup)}/32` : playerFace(name)}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('pixelated size-6 shrink-0 rounded-[5px]', className)}
    />
  );
}

export function BrandMark({ className }: { className?: string }): ReactElement {
  return <LogoMark className={className} />;
}
