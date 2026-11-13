import { useState, type ReactElement } from 'react';
import { cn } from '@/lib/utils';
import demoImages from 'virtual:demo-images';

/** The demo file cannot reach the panel; it carries the pictures itself. */
const DEMO = import.meta.env.MODE === 'demo';

/**
 * Small pixel pictures for the player page. Hearts and drumsticks are drawn here (own art); item and mob
 * pictures are fetched once by the panel from the Minecraft Wiki (/api/item-icons) – nothing from Mojang is stored
 * in the repo.
 */

/** "minecraft:golden_pickaxe" → "Golden Pickaxe"; other namespaces keep their prefix: "Stinkendreich:Smoking". */
export function itemName(id: string, customName?: string | null): string {
  if (customName) return customName;
  const [space, raw] = id.includes(':') ? (id.split(':', 2) as [string, string]) : ['minecraft', id];
  const words = raw
    .split('_')
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(' ');
  return space === 'minecraft' ? words : `${space[0]?.toUpperCase()}${space.slice(1)}:${words}`;
}

/** Only vanilla items have pictures; "minecraft:golden_pickaxe" → "golden_pickaxe". */
const vanillaId = (id: string): string | null => {
  if (id.includes(':') && !id.startsWith('minecraft:')) return null;
  return id.replace('minecraft:', '');
};

/** Grid of a pixel picture: each string is a row, characters pick colours. */
function Pixels({
  rows,
  colours,
  className,
}: {
  rows: readonly string[];
  colours: Readonly<Record<string, string>>;
  className?: string;
}): ReactElement {
  const width = rows[0]?.length ?? 0;
  return (
    <svg
      viewBox={`0 0 ${width} ${rows.length}`}
      className={className}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {rows.flatMap((row, y) =>
        Array.from(row).map((ch, x) =>
          colours[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={colours[ch]} /> : null,
        ),
      )}
    </svg>
  );
}

const HEART = ['.kk.kk.', 'krrkrrk', 'krwrrrk', 'krrrrrk', '.krrrk.', '..krk..', '...k...'];
const HEART_HALF = ['.kk.kk.', 'krrkeek', 'krwreek', 'krrreek', '.krrek.', '..kek..', '...k...'];
const HEART_EMPTY = ['.kk.kk.', 'keekeek', 'keeeeek', 'keeeeek', '.keeek.', '..kek..', '...k...'];
const HEART_COLOURS = { k: '#1a0b0b', r: '#e53935', w: '#ffb3b3', e: '#3a2424' };
const FOOD = ['....kk.', '...kwwk', '..kbbwk', '.kbbbk.', 'kbbbk..', 'kbbk...', '.kk....'];
const FOOD_EMPTY = ['....kk.', '...keek', '..keeek', '.keeek.', 'keeek..', 'keek...', '.kk....'];
const FOOD_COLOURS = { k: '#1c1208', w: '#f1e3c8', b: '#b5651d', e: '#3a2e22' };
const UNKNOWN = ['..rrr..', '.r...r.', '.....r.', '....r..', '...r...', '.......', '...r...'];

/** Ten hearts for 0 … 20 health points (half hearts included). */
export function Hearts({ value, max = 20 }: { value: number | null; max?: number }): ReactElement {
  const points = Math.max(0, Math.round(value ?? 0));
  const LOW = 6;
  return (
    <span className={cn('flex gap-0.5', points > 0 && points <= LOW && 'mh-beat')}>
      {Array.from({ length: max / 2 }, (_, i) => {
        const left = points - i * 2;
        const rows = left >= 2 ? HEART : left === 1 ? HEART_HALF : HEART_EMPTY; // eslint-disable-line ts-patterns/no-nested-ternary -- three heart states read best side by side
        return <Pixels key={i} rows={rows} colours={HEART_COLOURS} className="size-4 sm:size-[18px]" />;
      })}
    </span>
  );
}

/** Ten drumsticks for 0 … 20 food points. */
export function Food({ value }: { value: number | null }): ReactElement {
  const points = Math.max(0, Math.round(value ?? 0));
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 10 }, (_, i) => (
        <Pixels
          key={i}
          rows={points - i * 2 >= 1 ? FOOD : FOOD_EMPTY}
          colours={FOOD_COLOURS}
          className="size-4 sm:size-[18px]"
        />
      ))}
    </span>
  );
}

/** Red question mark for items without a known picture (modded items), as in other panels. */
export function UnknownItem({ className }: { className?: string }): ReactElement {
  return <Pixels rows={UNKNOWN} colours={{ r: '#e53935' }} className={className} />;
}

/** Picture of an item (or a mob via its spawn egg) from the Minecraft Wiki; falls back to the question mark. */
export function ItemIcon({
  id,
  mob = false,
  className,
}: {
  id: string;
  mob?: boolean;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = vanillaId(id);
  if (!name || failed) return <UnknownItem className={className} />;
  const embedded = DEMO && !mob ? demoImages.items[name] : undefined;
  return (
    <img
      src={embedded ?? `/api/item-icons/${mob ? 'mob' : 'item'}/${name}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('object-contain [image-rendering:pixelated]', className)}
    />
  );
}
