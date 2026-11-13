/** Pictures the demo build embeds (logos, game card art); empty outside the demo. See vite.config.ts. */
declare module 'virtual:demo-images' {
  import type { GameArtId, LogoProject } from '@mornihosting/shared';

  const images: {
    readonly logos: Partial<Record<LogoProject, string>>;
    readonly gameArt: Partial<Record<GameArtId, string>>;
    /** Item pictures of the team dashboard demo, by item id. */
    readonly items: Readonly<Record<string, string>>;
    /** Player faces of the team dashboard demo, by uuid without dashes. */
    readonly heads: Readonly<Record<string, string>>;
  };
  export default images;
}
