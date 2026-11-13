import {
  Gavel,
  Heart,
  Lock,
  MapPin,
  MicOff,
  Snowflake,
  Timer,
  Unlock,
  UserX,
  Utensils,
  Wifi,
} from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamBoardItem, TeamBoardPlayer } from '@mornihosting/shared';
import { PlayerHead } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ItemIcon } from '@/features/servers/players/mc-icons';
import { can, type TeamRequest } from './team-api';
import { durationLabel, RankPill, useLeft, type Board } from './team-ui';

const HOTBAR = 9;
const MAIN_END = 36;
/** Armour slots in the player inventory: boots 36 … helmet 39, off hand 40. */
const BOOTS = 36;
const LEGGINGS = 37;
const CHEST = 38;
const HELMET = 39;
const ARMOUR = [HELMET, CHEST, LEGGINGS, BOOTS] as const;
const OFF_HAND = 40;
const ENDER_SLOTS = 27;
const MINUTES_PER_HOUR = 60;
const LAST_PUNISHMENTS = 12;

/** One slot: the item's picture, how many, a shimmer when enchanted. */
function Slot({ item }: { item?: TeamBoardItem }): ReactElement {
  return (
    <div
      className={cn(
        'relative grid aspect-square place-items-center rounded-md border border-border bg-secondary/60',
        item?.enchanted && 'shadow-[inset_0_0_10px_rgba(168,85,247,0.55)]',
      )}
      title={item ? item.id.replaceAll('_', ' ') : undefined}
    >
      {item ? <ItemIcon id={item.id} className="size-[70%]" /> : null}
      {item && item.count > 1 ? (
        <span className="absolute bottom-0.5 right-1 text-[11px] font-bold tabular-nums text-white [text-shadow:1px_1px_0_#000]">
          {item.count}
        </span>
      ) : null}
    </div>
  );
}

function Grid({
  items,
  from,
  to,
}: {
  items: readonly TeamBoardItem[];
  from: number;
  to: number;
}): ReactElement {
  const bySlot = new Map(items.map((i) => [i.slot, i]));
  return (
    <div className="grid grid-cols-9 gap-1">
      {Array.from({ length: to - from }, (_, i) => (
        <Slot key={from + i} item={bySlot.get(from + i)} />
      ))}
    </div>
  );
}

/**
 * Everything about one player for the team: rank, health, where (if allowed), inventory and ender chest, past
 * punishments – and the buttons this team member may use.
 */
export function PlayerSheet({
  player,
  board,
  onClose,
  onSend,
  onPunish,
  busy,
}: {
  player: TeamBoardPlayer | null;
  board: Board;
  onClose: () => void;
  onSend: (request: TeamRequest) => void;
  onPunish: (action: 'jail' | 'mute' | 'ban' | 'kick', name: string) => void;
  busy: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const left = useLeft();
  const [view, setView] = useState<'inventory' | 'ender'>('inventory');
  const p = player;
  const past = p
    ? board.history.filter((h) => h.target.toLowerCase() === p.name.toLowerCase()).slice(0, LAST_PUNISHMENTS)
    : [];
  const bySlot = new Map((p?.inventory ?? []).map((i) => [i.slot, i]));
  return (
    <Dialog open={p !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        {p ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-4">
              <PlayerHead
                name={p.name}
                skin={p.bedrock ? undefined : p.uuid}
                className="size-16 rounded-xl"
              />
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-xl">{p.name}</DialogTitle>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <RankPill name={p.rank} color={p.rankColor} />
                  <Pill tone="neutral">
                    {t(`teamBoard.mode.${p.gamemode}`, { defaultValue: p.gamemode })}
                  </Pill>
                  {p.bedrock ? <Pill tone="neutral">Bedrock</Pill> : null}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat
                icon={<Heart className="size-4 text-red-400" />}
                label={t('teamBoard.health')}
                value={`${p.health} / 20`}
              />
              <Stat
                icon={<Utensils className="size-4 text-amber-400" />}
                label={t('teamBoard.food')}
                value={`${p.food} / 20`}
              />
              <Stat icon={<Wifi className="size-4 text-emerald-400" />} label="Ping" value={`${p.ping} ms`} />
              <Stat
                icon={<Timer className="size-4 text-sky-400" />}
                label={t('teamBoard.played')}
                value={t('teamBoard.hoursShort', { h: Math.floor(p.playMinutes / MINUTES_PER_HOUR) })}
              />
            </div>
            {p.where ? (
              <p className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                <MapPin className="size-4 text-primary" />
                <span className="font-mono">
                  {p.where.x} {p.where.y} {p.where.z}
                </span>
                <span className="text-muted-foreground">· {p.where.world}</span>
              </p>
            ) : null}

            {p.jailedUntil || p.mutedUntil || p.frozen ? (
              <div className="flex flex-wrap gap-1.5">
                {p.jailedUntil ? (
                  <Pill tone="bad">
                    <Lock className="size-3" /> {t('teamBoard.inJail', { time: left(p.jailedUntil) })}
                  </Pill>
                ) : null}
                {p.mutedUntil ? (
                  <Pill tone="warn">
                    <MicOff className="size-3" /> {t('teamBoard.mutedFor', { time: left(p.mutedUntil) })}
                  </Pill>
                ) : null}
                {p.frozen ? (
                  <Pill tone="accent">
                    <Snowflake className="size-3" /> {t('teamBoard.frozen')}
                  </Pill>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-2">
              <div className="flex gap-1.5">
                {(['inventory', 'ender'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    style={{ color: 'inherit' }}
                    onClick={() => setView(v)}
                    className={cn(
                      'rounded-lg px-3 py-1 text-sm',
                      view === v ? 'bg-primary/15 font-semibold text-primary' : 'hover:bg-secondary',
                    )}
                  >
                    {t(`teamBoard.${v}`)}
                  </button>
                ))}
              </div>
              {view === 'inventory' ? (
                <div className="grid gap-2 rounded-xl border border-border bg-background/40 p-3">
                  <div className="flex gap-1">
                    {ARMOUR.map((s) => (
                      <div key={s} className="w-10">
                        <Slot item={bySlot.get(s)} />
                      </div>
                    ))}
                    <div className="ml-auto w-10">
                      <Slot item={bySlot.get(OFF_HAND)} />
                    </div>
                  </div>
                  <Grid items={p.inventory} from={HOTBAR} to={MAIN_END} />
                  <div className="mt-1">
                    <Grid items={p.inventory} from={0} to={HOTBAR} />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-background/40 p-3">
                  <Grid items={p.ender} from={0} to={ENDER_SLOTS} />
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <p className="text-sm font-semibold">{t('teamBoard.actions')}</p>
              <div className="flex flex-wrap gap-2">
                {p.jailedUntil ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onSend({ action: 'free', target: p.name })}
                  >
                    <Unlock className="size-4" /> {t('teamBoard.do.free')}
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" onClick={() => onPunish('jail', p.name)}>
                    <Lock className="size-4" /> {t('teamBoard.do.jail')}
                  </Button>
                )}
                {p.mutedUntil ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onSend({ action: 'unmute', target: p.name })}
                  >
                    {t('teamBoard.do.unmute')}
                  </Button>
                ) : (
                  <Button size="sm" variant="destructive" onClick={() => onPunish('mute', p.name)}>
                    <MicOff className="size-4" /> {t('teamBoard.do.mute')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onSend({ action: 'freeze', target: p.name })}
                >
                  <Snowflake className="size-4" />{' '}
                  {t(p.frozen ? 'teamBoard.do.unfreeze' : 'teamBoard.do.freeze')}
                </Button>
                {can(board, 'kick') ? (
                  <Button size="sm" variant="destructive" onClick={() => onPunish('kick', p.name)}>
                    <UserX className="size-4" /> {t('teamBoard.do.kick')}
                  </Button>
                ) : null}
                {can(board, 'ban') ? (
                  <Button size="sm" variant="danger" onClick={() => onPunish('ban', p.name)}>
                    <Gavel className="size-4" /> {t('teamBoard.do.ban')}
                  </Button>
                ) : null}
              </div>
              {can(board, 'ranks') && board.ranks.length ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t('teamBoard.rank')}</span>
                  <Select
                    value={p.rankId}
                    onValueChange={(rank) => onSend({ action: 'rank', target: p.name, rank })}
                  >
                    <SelectTrigger className="h-9 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {board.ranks.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          <span style={{ color: r.color }}>{r.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <p className="text-sm font-semibold">{t('teamBoard.pastPunishments')}</p>
              {past.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('teamBoard.clean')}</p>
              ) : (
                past.map((h) => (
                  <div key={`${h.at}-${h.type}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {new Date(h.at).toLocaleDateString()}
                    </span>
                    <Pill tone={['free', 'unmute', 'unfreeze', 'unban'].includes(h.type) ? 'ok' : 'bad'}>
                      {t(`teamBoard.type.${h.type}`, { defaultValue: h.type })}
                    </Pill>
                    {h.minutes ? <span>{durationLabel(t, h.minutes)}</span> : null}
                    {h.reason ? <span className="text-muted-foreground">„{h.reason}“</span> : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t('teamBoard.by', { name: h.by })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ icon, label, value }: { icon: ReactElement; label: string; value: string }): ReactElement {
  return (
    <div className="grid gap-1 rounded-xl border border-border p-2.5">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon} {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
