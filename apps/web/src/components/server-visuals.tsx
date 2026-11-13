import { useState, type ReactElement, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isGameId, type GameId, type ServerState } from '@mornihosting/shared';
import { playerFace } from '@/lib/pixel';
import { cn } from '@/lib/utils';
import { Badge, LogoMark } from './art';
import { blockOf, McBlock } from './mc-block';
import { Pill, type PillTone } from './ui/pill';
import demoImages from 'virtual:demo-images';

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
const FLOODGATE_UUID = '00000000-0000-0000-';

/** Whose face the panel should fetch from Mojang: the given skin (a name or uuid), by default the name if it is a Java name. */
function skinOf(name: string, skin: string | null | undefined): string | null {
  // Bedrock players (Floodgate) have made-up UUIDs starting with zeros: no Java skin behind them.
  if (skin?.startsWith(FLOODGATE_UUID)) return null;
  if (skin !== undefined) return skin;
  return JAVA_NAME.test(name) ? name : null;
}

/**
 * A player's face (the panel fetches the current skin from Mojang, /api/heads); falls back to a drawn face offline or for Bedrock names.
 * `skin` picks the account explicitly (null: always draw), e.g. the user's linked Minecraft account.
 */
/** Colours of the player pictures for other games (from dark to light), in the spirit of each game. */
const GAME_TINTS: Readonly<Record<GameId, readonly [string, string]>> = {
  factorio: ['#7a4a12', '#e3962b'],
  cs2: ['#3b2a12', '#de9b35'],
  gmod: ['#0d3b66', '#3f8fd8'],
  satisfactory: ['#5a3a06', '#f2a51a'],
  ets2: ['#123d2a', '#3fae6b'],
  hytale: ['#2c1b55', '#8d6cf0'],
};
// Words of a player name for its initials: "Lena_Mueller", "lena mueller" and "lena-mueller" give "LM".
// https://regex101.com/?flavor=javascript&regex=%5B%5Cs_.%5C-%5D%2B&testString=Lena_Mueller%0Alena%20mueller%0Alena-mueller
const NAME_PARTS = /[\s_.-]+/;
const INITIALS = 2;

/** A player in another game than Minecraft: initials on the game's colours instead of a Minecraft head. */
function GamePlayer({
  name,
  game,
  className,
}: {
  name: string;
  game: GameId;
  className?: string;
}): ReactElement {
  const [dark, light] = GAME_TINTS[game];
  const parts = name.split(NAME_PARTS).filter(Boolean);
  const letters = (parts.length > 1 ? parts.map((p) => p[0] ?? '') : [...(parts[0] ?? '?')])
    .slice(0, INITIALS)
    .join('')
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center rounded-[5px] text-[0.6em] font-extrabold text-white shadow-sm',
        className,
      )}
      style={{ background: `linear-gradient(135deg, ${light}, ${dark})` }}
    >
      {letters}
    </span>
  );
}

/** The panel asks Mojang again after five minutes; the browser follows. */
const SKIN_REFRESH_MS = 300_000;
const skinRound = (): number => Math.floor(Date.now() / SKIN_REFRESH_MS);

export function PlayerHead({
  name,
  skin,
  game,
  className,
}: {
  name: string;
  skin?: string | null;
  /** The server's edition; other games get their own picture instead of a Minecraft head. */
  game?: string;
  className?: string;
}): ReactElement {
  const lookup = skinOf(name, skin);
  const round = skinRound();
  // One failed load (Mojang briefly busy) must not keep the drawn face: try again with the next round.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === `${lookup ?? ''}:${round}`;
  if (game && isGameId(game)) return <GamePlayer name={name} game={game} className={className} />;
  // The demo cannot load pictures from other sites: it carries a few faces itself and draws the rest.
  const embedded = DEMO && lookup ? demoImages.heads[lookup.replaceAll('-', '')] : undefined;
  const usable = !failed && !DEMO && lookup !== null;
  return (
    <img
      src={embedded ?? (usable ? `/api/heads/${encodeURIComponent(lookup)}?v=${round}` : playerFace(name))}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedFor(`${lookup ?? ''}:${round}`)}
      className={cn('pixelated size-6 shrink-0 rounded-[5px]', className)}
    />
  );
}

export function BrandMark({ className }: { className?: string }): ReactElement {
  return <LogoMark className={className} />;
}
