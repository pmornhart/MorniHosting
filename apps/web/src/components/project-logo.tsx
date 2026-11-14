import { useState, type ReactElement, type ReactNode } from 'react';
import { GAME_ART_IDS, PROJECT_LOGOS, type GameArtId, type LogoProject } from '@mornihosting/shared';
import demoImages from 'virtual:demo-images';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/api';

const LOGOS = PROJECT_LOGOS;
export type { LogoProject };

const DEMO = import.meta.env.MODE === 'demo';
/** The demo cannot load pictures from other sites; its build embeds them (empty outside the demo). */
const EMBEDDED = demoImages;

export function hasProjectLogo(id: string): id is LogoProject {
  return id in LOGOS;
}

export function ProjectLogo({
  project,
  fallback,
  className,
}: {
  project: LogoProject;
  fallback: ReactNode;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const src = DEMO ? EMBEDDED.logos[project] : LOGOS[project];
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('size-6 shrink-0 object-contain', className)}
    />
  );
}

/** Game card pictures: the panel fetches them once (see GAME_ART_SOURCES) and serves them from its data folder. */
const GAME_ART = Object.fromEntries(GAME_ART_IDS.map((id) => [id, `/api/game-art/${id}`])) as Record<
  GameArtId,
  string
>;
const gameArtUrl = (game: GameArtId): string => apiUrl(GAME_ART[game]);

export function GameArt({
  game,
  fallback,
  className,
}: {
  game: keyof typeof GAME_ART;
  fallback: ReactNode;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const src = DEMO ? EMBEDDED.gameArt[game] : gameArtUrl(game);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('object-cover', className)}
    />
  );
}
