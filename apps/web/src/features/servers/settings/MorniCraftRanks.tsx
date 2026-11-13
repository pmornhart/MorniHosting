import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, Crown, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_RANKS,
  RANK_COLORS,
  RANK_PERMISSIONS,
  RANK_SOURCES,
  RANK_SYMBOLS,
  type KnownPlayer,
  type MorniCraftRank,
  type RankPermission,
  type RankSource,
} from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The Claude app on iPhone gives buttons its own text colour: these keep the card's. */
const OWN_TEXT_COLOUR = { color: 'inherit' } as const;
// Minecraft names: letters, digits, _ (Bedrock behind Floodgate also . * -): "Morni_23" and ".Morni" yes, "a b" no.
// https://regex101.com/?flavor=javascript&regex=%5E%5BA-Za-z0-9_.*-%5D%7B1%2C32%7D%24&testString=Morni_23%0A.Morni%0Aa%20b
const PLAYER_NAME = /^[A-Za-z0-9_.*-]{1,32}$/;
// Everything that can't be in a rank id: "mod team!" → the " " and "!" match, "mod" does not.
// https://regex101.com/?flavor=javascript&regex=%5B%5Ea-z0-9_-%5D%2B&flags=g&testString=mod%20team!
const NOT_ID = /[^a-z0-9_-]+/g;
// Dashes at the start or end: "-mod-" → both dashes match, "mod" not.
// https://regex101.com/?flavor=javascript&regex=%5E-%2B%7C-%2B%24&flags=g&testString=-mod-
const EDGE_DASHES = /^-+|-+$/g;
const MAX_ID = 24;
/** Room for "-2", "-3" … behind a long id. */
const SUFFIX_ROOM = 3;
const MAX_SUFFIX = 99;
const KNOWN_FRESH_MS = 60_000;
const NEW_COLOR = '#55aaff';
const NEW_SYMBOL = '★';

function newId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(NOT_ID, '-').replace(EDGE_DASHES, '').slice(0, MAX_ID) || 'rang';
  const candidates = [
    base,
    ...Array.from({ length: MAX_SUFFIX }, (_, i) => `${base.slice(0, MAX_ID - SUFFIX_ROOM)}-${i + 2}`),
  ];
  return candidates.find((id) => !taken.includes(id)) ?? `${base.slice(0, MAX_ID - SUFFIX_ROOM)}-x`;
}

/** "♛ Owner · Morni » Hallo!" as the chat shows it. */
/** The rank in front of the name: a badge (with the resource pack) or the symbol and name in colour. */
function RankLabel({
  rank,
  badge,
  text,
}: {
  rank: MorniCraftRank;
  badge: boolean;
  text: boolean;
}): ReactElement | null {
  // With badges everyone has one, also plain players (the rank for everyone else); symbols only with a symbol.
  if (!rank.symbol && !(badge && rank.isDefault)) return null;
  if (badge && !text) {
    // Only the icon (Philip: "nur noch die Krone").
    return (
      <span className="mr-1.5 align-middle" style={{ color: rank.color }}>
        {rank.symbol || '☺'}
      </span>
    );
  }
  if (badge) {
    return (
      <span
        className="mr-1.5 inline-flex items-center gap-1 rounded-[3px] px-1.5 align-middle text-[11px] font-bold tracking-wide text-white uppercase"
        style={{
          background: `color-mix(in srgb, ${rank.color} 50%, black)`,
          boxShadow: `inset 0 -1px 0 ${rank.color}`,
        }}
      >
        <span style={{ color: rank.color }}>{rank.symbol || '☺'}</span>
        {rank.name}
      </span>
    );
  }
  return (
    <>
      <span style={{ color: rank.color }}>
        {rank.symbol} {rank.name}
      </span>
      <span className="text-[#6b7570]"> · </span>
    </>
  );
}

export function ChatPreview({
  rank,
  player,
  badge = false,
  text = true,
}: {
  rank: MorniCraftRank;
  player: string;
  badge?: boolean;
  /** The rank's name on the badge too. */
  text?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-[8px] bg-[#1d1f1e]/90 px-3 py-2 font-mono text-[13px] leading-snug text-white shadow-inner">
      <RankLabel rank={rank} badge={badge} text={text} />
      <span style={{ color: rank.color }}>{player}</span>
      <span className="text-[#aaaaaa]"> » </span>
      <span>{t('mornicraft.ranks.previewText')}</span>
    </div>
  );
}

function RankEditor({
  rank,
  auto,
  known,
  onChange,
}: {
  rank: MorniCraftRank;
  auto: readonly string[];
  known: readonly string[];
  onChange: (r: MorniCraftRank) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const add = (): void => {
    const n = name.trim();
    if (!PLAYER_NAME.test(n) || rank.players.some((p) => p.toLowerCase() === n.toLowerCase())) return;
    onChange({ ...rank, players: [...rank.players, n] });
    setName('');
  };
  const togglePerm = (p: RankPermission, on: boolean): void =>
    onChange({
      ...rank,
      permissions: on
        ? RANK_PERMISSIONS.filter((x) => x === p || rank.permissions.includes(x))
        : rank.permissions.filter((x) => x !== p),
    });
  const listId = `mc-known-${rank.id}`;
  return (
    <div className="grid gap-4 border-t px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <label className="grid gap-1.5 text-sm font-medium">
          {t('mornicraft.ranks.name')}
          <Input
            value={rank.name}
            maxLength={20}
            onChange={(e) => onChange({ ...rank, name: e.target.value })}
          />
        </label>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">{t('mornicraft.ranks.symbol')}</span>
          <div className="flex flex-wrap gap-1">
            {['', ...RANK_SYMBOLS].map((s) => (
              <button
                key={s || 'none'}
                type="button"
                style={OWN_TEXT_COLOUR}
                onClick={() => onChange({ ...rank, symbol: s })}
                aria-pressed={rank.symbol === s}
                aria-label={s || t('mornicraft.ranks.noSymbol')}
                className={cn(
                  'grid size-8 place-items-center rounded-[8px] border text-[15px] transition-colors hover:bg-secondary',
                  rank.symbol === s && 'border-primary bg-primary/12 ring-1 ring-primary',
                )}
              >
                {s ? <span style={{ color: rank.color }}>{s}</span> : <X className="size-3.5 opacity-60" />}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{t('mornicraft.ranks.color')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {RANK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              style={{ ...OWN_TEXT_COLOUR, background: c }}
              onClick={() => onChange({ ...rank, color: c })}
              aria-label={c}
              aria-pressed={rank.color.toLowerCase() === c}
              className={cn(
                'size-7 rounded-full border-2 border-transparent shadow-sm transition-transform hover:scale-110',
                rank.color.toLowerCase() === c && 'border-foreground',
              )}
            />
          ))}
          <label className="ml-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <input
              type="color"
              value={rank.color}
              onChange={(e) => onChange({ ...rank, color: e.target.value })}
              className="size-7 cursor-pointer rounded-full border-0 bg-transparent p-0"
            />
            {t('mornicraft.ranks.ownColor')}
          </label>
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{t('mornicraft.ranks.permissions')}</span>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {RANK_PERMISSIONS.map((p) => (
            <div key={p} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{t(`mornicraft.ranks.perms.${p}`)}</div>
                <div className="text-[12px] text-muted-foreground">
                  {t(`mornicraft.ranks.permHints.${p}`)}
                </div>
              </div>
              <Switch
                checked={rank.permissions.includes(p)}
                onCheckedChange={(on) => togglePerm(p, on)}
                aria-label={t(`mornicraft.ranks.perms.${p}`)}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium">{t('mornicraft.ranks.players')}</span>
        {rank.isDefault ? (
          <p className="text-[12.5px] text-muted-foreground">{t('mornicraft.ranks.everyoneElse')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {auto.map((p) => (
                <span
                  key={`auto-${p}`}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[12.5px]"
                  title={t('mornicraft.ranks.autoHint')}
                >
                  <Crown className="size-3 text-primary" aria-hidden />
                  {p}
                </span>
              ))}
              {rank.players.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2.5 py-1 text-[12.5px]"
                >
                  {p}
                  <button
                    type="button"
                    style={OWN_TEXT_COLOUR}
                    onClick={() => onChange({ ...rank, players: rank.players.filter((x) => x !== p) })}
                    aria-label={t('mornicraft.ranks.removePlayer', { name: p })}
                    className="rounded-full p-0.5 opacity-60 hover:bg-destructive/15 hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {auto.length === 0 && rank.players.length === 0 ? (
                <span className="text-[12.5px] text-muted-foreground">{t('mornicraft.ranks.nobody')}</span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Input
                value={name}
                list={listId}
                placeholder={t('mornicraft.ranks.addPlaceholder')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <datalist id={listId}>
                {known.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <Button
                type="button"
                variant="secondary"
                disabled={!PLAYER_NAME.test(name.trim())}
                onClick={add}
                aria-label={t('mornicraft.ranks.add')}
              >
                <UserPlus aria-hidden />
                <span className="hidden sm:inline">{t('mornicraft.ranks.add')}</span>
              </Button>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">{t('mornicraft.ranks.fromPanel')}</span>
              <Select
                value={rank.fromPanel}
                onValueChange={(v) => onChange({ ...rank, fromPanel: v as RankSource })}
              >
                <SelectTrigger className="h-8 w-auto min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANK_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`mornicraft.ranks.sources.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Ranks of a MorniCraft server: symbol and colour in chat, tab list and above the head, and what each rank may do.
 * Highest first – the first rank that lists a player counts. Owners and moderators of the server in the panel get
 * their rank by themselves (with a linked Minecraft account).
 */
export function MorniCraftRanks({
  serverId,
  ranks,
  panelMembers,
  badges,
  badgesReady,
  onBadges,
  badgesRequired,
  onBadgesRequired,
  badgeText,
  onBadgeText,
  onChange,
  knownNames = [],
}: {
  /** In the panel: suggestions from the server's known players. */
  serverId?: string;
  /** On the team dashboard: the names it knows (online players, punished ones). */
  knownNames?: readonly string[];
  ranks: readonly MorniCraftRank[];
  panelMembers: Readonly<Record<'owner' | 'moderator', readonly string[]>>;
  /** Ranks as small pictures in the chat (needs the panel's domain: players load a tiny resource pack). */
  badges: boolean;
  badgesReady: boolean;
  onBadges: (on: boolean) => void;
  badgesRequired: boolean;
  onBadgesRequired: (on: boolean) => void;
  badgeText: boolean;
  onBadgeText: (on: boolean) => void;
  onChange: (ranks: MorniCraftRank[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const { data: knownPlayers } = useQuery({
    queryKey: ['players-known', serverId],
    queryFn: () => api<KnownPlayer[]>(`/api/servers/${serverId ?? ''}/players/known`),
    staleTime: KNOWN_FRESH_MS,
    enabled: serverId !== undefined,
  });
  const known = [...new Set([...(knownPlayers ?? []).map((p) => p.name), ...knownNames])].filter(Boolean);
  const list = [...ranks];
  const update = (i: number, r: MorniCraftRank): void => {
    // Only one rank is everyone else's: switching it on here switches it off elsewhere.
    const others = r.isDefault ? list.map((x) => ({ ...x, isDefault: false })) : list;
    const next = others.map((x, j) => (j === i ? r : x));
    onChange(next);
  };
  const move = (i: number, by: number): void => {
    const next = [...list];
    const [r] = next.splice(i, 1);
    if (r) next.splice(i + by, 0, r);
    onChange(next);
  };
  const remove = (i: number): void => onChange(list.filter((_, j) => j !== i));
  const addRank = (): void => {
    const name = t('mornicraft.ranks.newName');
    const rank: MorniCraftRank = {
      id: newId(
        name,
        list.map((r) => r.id),
      ),
      name,
      symbol: NEW_SYMBOL,
      color: NEW_COLOR,
      permissions: [],
      players: [],
      isDefault: false,
      fromPanel: 'none',
    };
    // New ranks go above the default rank (which is usually last).
    const at = list.findIndex((r) => r.isDefault);
    const next = [...list];
    next.splice(at < 0 ? next.length : at, 0, rank);
    onChange(next);
    setOpen(rank.id);
  };
  const autoOf = (r: MorniCraftRank): readonly string[] =>
    r.fromPanel === 'none' ? [] : panelMembers[r.fromPanel];
  const previewName = (r: MorniCraftRank): string => autoOf(r)[0] ?? r.players[0] ?? 'Steve';

  return (
    <section className="grid gap-3 rounded-[12px] border bg-secondary/30 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Crown className="size-4 text-primary" aria-hidden />
            {t('mornicraft.sections.ranks')}
          </h3>
          <p className="text-[12.5px] text-muted-foreground">{t('mornicraft.ranks.text')}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={list.length >= MAX_RANKS}
          onClick={addRank}
        >
          <Plus aria-hidden />
          {t('mornicraft.ranks.addRank')}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-[10px] border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{t('mornicraft.ranks.badges')}</div>
          <div className="text-[12px] text-muted-foreground">
            {badgesReady ? t('mornicraft.ranks.badgesHint') : t('mornicraft.ranks.badgesNoDomain')}
          </div>
        </div>
        <Switch checked={badges} onCheckedChange={onBadges} aria-label={t('mornicraft.ranks.badges')} />
      </div>
      {badges && (
        <div className="flex items-center justify-between gap-3 rounded-[10px] border bg-card px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('mornicraft.ranks.badgesRequired')}</div>
            <div className="text-[12px] text-muted-foreground">
              {t('mornicraft.ranks.badgesRequiredHint')}
            </div>
          </div>
          <Switch
            checked={badgesRequired}
            onCheckedChange={onBadgesRequired}
            aria-label={t('mornicraft.ranks.badgesRequired')}
          />
        </div>
      )}
      {badges && (
        <div className="flex items-center justify-between gap-3 rounded-[10px] border bg-card px-3 py-2.5">
          <div className="grid min-w-0 gap-1.5">
            <div className="text-[13px] font-medium">{t('mornicraft.ranks.badgeText')}</div>
            <div className="text-[12px] text-muted-foreground">{t('mornicraft.ranks.badgeTextHint')}</div>
            {list[0] && <ChatPreview rank={list[0]} player={previewName(list[0])} badge text={badgeText} />}
          </div>
          <Switch
            checked={badgeText}
            onCheckedChange={onBadgeText}
            aria-label={t('mornicraft.ranks.badgeText')}
          />
        </div>
      )}
      <div className="grid gap-2">
        {list.map((r, i) => {
          const isOpen = open === r.id;
          const count = r.players.length + autoOf(r).length;
          return (
            <div key={r.id} className="overflow-hidden rounded-[10px] border bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  style={OWN_TEXT_COLOUR}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-3"
                >
                  <span
                    className="grid size-9 shrink-0 place-items-center rounded-[9px] text-lg font-semibold"
                    style={{ background: `${r.color}22`, color: r.color }}
                    aria-hidden
                  >
                    {r.symbol || r.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold" style={{ color: r.color }}>
                      {r.name}
                    </span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {r.isDefault
                        ? t('mornicraft.ranks.default')
                        : `${t('mornicraft.ranks.playerCount', { count })} · ${t('mornicraft.ranks.permCount', { count: r.permissions.length })}`}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn('ml-auto size-4 shrink-0 transition-transform', isOpen && 'rotate-180')}
                    aria-hidden
                  />
                </button>
                <div className="flex shrink-0 items-center [&_button]:size-8 sm:[&_button]:size-9">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={t('mornicraft.ranks.up')}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={i === list.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t('mornicraft.ranks.down')}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(i)}
                    aria-label={t('mornicraft.ranks.remove', { name: r.name })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
              {isOpen ? (
                <>
                  <div className="px-4 pb-3">
                    <ChatPreview
                      rank={r}
                      player={previewName(r)}
                      badge={badges && badgesReady}
                      text={badgeText}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{t('mornicraft.ranks.isDefault')}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {t('mornicraft.ranks.isDefaultHint')}
                      </div>
                    </div>
                    <Switch
                      checked={r.isDefault}
                      onCheckedChange={(on) => update(i, { ...r, isDefault: on })}
                      aria-label={t('mornicraft.ranks.isDefault')}
                    />
                  </div>
                  <RankEditor rank={r} auto={autoOf(r)} known={known} onChange={(next) => update(i, next)} />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
