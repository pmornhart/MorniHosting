import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { GAME_ART_SOURCES, itemWikiName, PROJECT_LOGOS } from '../../packages/shared/src/branding';
import TEAM_SAMPLE from './src/demo/team-demo.json';

/** The app ships as one bundle with the console and editor split off; warn only for real outliers. */
const CHUNK_WARNING_KB = 1500;
const BACKEND = process.env['MH_DEV_BACKEND'] ?? 'http://localhost:8099';
/** The demo is one self-contained file: fonts and images go inline. */
const DEMO_INLINE_BYTES = 50_000_000;
const src = path.resolve(import.meta.dirname, 'src');
const DEMO_IMAGES = 'virtual:demo-images';
const RESOLVED_DEMO_IMAGES = `\0${DEMO_IMAGES}`;

/**
 * Libraries in their own files: they rarely change, so after a panel update the browser keeps them in its cache
 * and only fetches the panel's own code again. First match wins.
 */
const VENDOR_CHUNKS: readonly (readonly [string, RegExp])[] = [
  // "node_modules/react-dom/client.js" → react; "node_modules/react-router/dist/index.js" → router.
  // https://regex101.com/?flavor=javascript&regex=node_modules%5C%2F(react%7Creact-dom%7Cscheduler)%5C%2F&testString=node_modules%2Freact-dom%2Fclient.js%0Anode_modules%2Freact-router%2Fdist%2Findex.js
  ['react', /node_modules\/(react|react-dom|scheduler)\//],
  ['router', /node_modules\/react-router\//],
  // "node_modules/@tanstack/query-core/build/index.js" → query.
  // https://regex101.com/?flavor=javascript&regex=node_modules%5C%2F%40tanstack%5C%2F&testString=node_modules%2F%40tanstack%2Fquery-core%2Fbuild%2Findex.js
  ['query', /node_modules\/@tanstack\//],
  // "node_modules/@radix-ui/react-dialog/dist/index.mjs" → ui; "node_modules/@floating-ui/dom/x.js" → ui.
  // https://regex101.com/?flavor=javascript&regex=node_modules%5C%2F(%40radix-ui%7C%40floating-ui%7Creact-remove-scroll%7Csonner%7Ctailwind-merge)&testString=node_modules%2F%40radix-ui%2Freact-dialog%2Fdist%2Findex.mjs%0Anode_modules%2F%40floating-ui%2Fdom%2Fx.js
  ['ui', /node_modules\/(@radix-ui|@floating-ui|react-remove-scroll|sonner|tailwind-merge)/],
  // "node_modules/zod/v4/core/core.js" → zod.
  // https://regex101.com/?flavor=javascript&regex=node_modules%5C%2Fzod%5C%2F&testString=node_modules%2Fzod%2Fv4%2Fcore%2Fcore.js
  ['zod', /node_modules\/zod\//],
  // "node_modules/i18next/dist/esm/i18next.js" → i18n; "node_modules/react-i18next/dist/x.js" → i18n.
  // https://regex101.com/?flavor=javascript&regex=node_modules%5C%2F(react-)%3Fi18next&testString=node_modules%2Fi18next%2Fdist%2Fesm%2Fi18next.js%0Anode_modules%2Freact-i18next%2Fdist%2Fx.js
  ['i18n', /node_modules\/(react-)?i18next/],
];

function vendorChunk(id: string): string | undefined {
  return VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0];
}

/** Downloads one picture as a data: URI, or nothing if it cannot be fetched (the drawn fallback shows then). */
async function embed(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: 'image/*' } });
    if (!response.ok) return undefined;
    const type = response.headers.get('content-type') ?? 'image/png';
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function embedAll(sources: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    Object.entries(sources).map(async ([key, url]) => [key, await embed(url)] as const),
  );
  return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined));
}

/** "golden_apple" → Minecraft Wiki picture "Invicon_Golden_Apple.png" (as the panel's /api/item-icons). */
function teamItemSources(): Record<string, string> {
  const ids = new Set(
    Object.values(TEAM_SAMPLE.inventories).flatMap((rows) => rows.map((row) => String(row[1]))),
  );
  return Object.fromEntries(
    [...ids].map((id) => [id, `https://minecraft.wiki/images/Invicon_${itemWikiName(id)}.png`]),
  );
}

/** Mojang's skin service; the panel itself uses the same (apps/server/src/players/heads.ts). */
const MOJANG_PROFILE = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const FACE_PX = 8;
const HEAD_PX = 64;
const HAT_X = 40;
const RGBA = 4;

/** pngjs comes with the server package; the demo build borrows it to cut the faces. */
type Png = { width: number; height: number; data: Buffer };
type PngLib = {
  PNG: {
    new (o: { width: number; height: number }): Png;
    sync: { read(b: Buffer): Png; write(p: Png): Buffer };
  };
};
const pngLib = (): PngLib =>
  createRequire(path.resolve(__dirname, '../server/package.json'))('pngjs') as PngLib;

/** The face with the hat layer, 64×64 – like the panel's /api/heads. */
async function headOf(uuid: string): Promise<string | undefined> {
  try {
    const profile = (await (await fetch(MOJANG_PROFILE + uuid.replaceAll('-', ''))).json()) as {
      properties?: { name: string; value: string }[];
    };
    const value = profile.properties?.find((p) => p.name === 'textures')?.value ?? '';
    const textures = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string } };
    };
    const url = (textures.textures?.SKIN?.url ?? '').replace('http://', 'https://');
    if (!url) return undefined;
    const { PNG } = pngLib();
    const skin = PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer()));
    const out = new PNG({ width: HEAD_PX, height: HEAD_PX });
    const scale = HEAD_PX / FACE_PX;
    // Old 64×32 skins often have a solid hat layer; Minecraft only shows it if some of it is see-through.
    const hatShows =
      skin.height >= skin.width ||
      Array.from({ length: FACE_PX * FACE_PX }, (_, n) => n).some(
        (n) =>
          (skin.data[((FACE_PX + Math.floor(n / FACE_PX)) * skin.width + HAT_X + (n % FACE_PX)) * RGBA + 3] ??
            0) < 255,
      );
    const at = (x: number, y: number): number[] => [
      ...skin.data.subarray((y * skin.width + x) * RGBA, (y * skin.width + x) * RGBA + RGBA),
    ];
    Array.from({ length: HEAD_PX * HEAD_PX }, (_, n) => n).forEach((n) => {
      const fx = Math.floor((n % HEAD_PX) / scale);
      const fy = Math.floor(Math.floor(n / HEAD_PX) / scale);
      const hat = hatShows ? at(HAT_X + fx, FACE_PX + fy) : [];
      const [r = 0, g = 0, b = 0] = (hat.at(-1) ?? 0) > 0 ? hat : at(FACE_PX + fx, FACE_PX + fy);
      out.data.set([r, g, b, 255], n * RGBA);
    });
    return `data:image/png;base64,${PNG.sync.write(out).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Faces of the demo's team dashboard players (real accounts), by uuid without dashes. */
async function teamHeads(): Promise<Record<string, string>> {
  const ids = [...TEAM_SAMPLE.players.map((p) => p.uuid), ...TEAM_SAMPLE.jailedOffline.map((e) => e.uuid)];
  const pairs = await Promise.all(ids.map(async (id) => [id.replaceAll('-', ''), await headOf(id)] as const));
  return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined));
}

/**
 * The demo is one sealed file that cannot load pictures from other sites, so its build embeds the project logos
 * and game card pictures (fetched at build time, never stored in the repository). Outside the demo it is empty.
 */
function demoImages(demo: boolean): Plugin {
  return {
    name: 'mornihosting-demo-images',
    resolveId: (id) => (id === DEMO_IMAGES ? RESOLVED_DEMO_IMAGES : undefined),
    load: async (id) => {
      if (id !== RESOLVED_DEMO_IMAGES) return undefined;
      const images = demo
        ? {
            logos: await embedAll(PROJECT_LOGOS),
            gameArt: await embedAll(GAME_ART_SOURCES),
            items: await embedAll(teamItemSources()),
            heads: await teamHeads(),
          }
        : { logos: {}, gameArt: {}, items: {}, heads: {} };
      return `export default ${JSON.stringify(images)};`;
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    plugins: [react(), tailwindcss(), demoImages(demo)],
    base: demo ? './' : '/',
    resolve: {
      alias: [
        // "@/lib/api" → src/lib/api; "@simplewebauthn/browser" does not match.
        // https://regex101.com/?flavor=javascript&regex=%5E%40%5C%2F&testString=%40%2Flib%2Fapi%0A%40simplewebauthn%2Fbrowser
        { find: /^@\//, replacement: `${src}/` },
        // The demo's sealed frame refuses real passkeys; a marked pretend dialog stands in.
        ...(demo
          ? [
              { find: '@simplewebauthn/browser', replacement: path.join(src, 'demo/webauthn-shim.ts') },
              // The demo's stylesheet gives the panel's colours priority over the Claude app's own.
              // "./styles/globals.css" matches; "./styles/panel.css" does not.
              // https://regex101.com/?flavor=javascript&regex=%5E%5C.%5C%2Fstyles%5C%2Fglobals%5C.css%24&testString=.%2Fstyles%2Fglobals.css%0A.%2Fstyles%2Fpanel.css
              { find: /^\.\/styles\/globals\.css$/, replacement: path.join(src, 'styles/demo.css') },
            ]
          : []),
      ],
    },
    server: {
      proxy: {
        '/api': { target: BACKEND, ws: true, changeOrigin: false },
      },
    },
    build: demo
      ? {
          outDir: 'dist-demo',
          sourcemap: false,
          assetsInlineLimit: DEMO_INLINE_BYTES,
          cssCodeSplit: false,
          chunkSizeWarningLimit: DEMO_INLINE_BYTES,
          rollupOptions: {
            input: path.resolve(import.meta.dirname, 'demo.html'),
            output: { inlineDynamicImports: true },
          },
        }
      : {
          outDir: 'dist',
          sourcemap: false,
          chunkSizeWarningLimit: CHUNK_WARNING_KB,
          rollupOptions: { output: { manualChunks: vendorChunk } },
        },
  };
});
