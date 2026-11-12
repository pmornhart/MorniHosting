import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Backpack,
  BedDouble,
  Clock,
  Crosshair,
  Gamepad2,
  Globe2,
  MapPin,
  MessageSquareText,
  Minus,
  Package,
  PencilLine,
  Plus,
  RefreshCw,
  Skull,
  Swords,
  Terminal,
  Footprints,
  Zap,
  Hand,
} from 'lucide-react';
import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  PLAYER_GAMEMODES,
  type ItemStack,
  type PlayerAction,
  type PlayerAdjust,
  type PlayerDetail,
  type PlayerGamemode,
  type StatCount,
} from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/page';
import { PlayerHead } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton, Tip } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { errorText } from '@/lib/query';
import { cn } from '@/lib/utils';
import { useServer } from '../ServerLayout';
import { Food, Hearts, ItemIcon, itemName } from './mc-icons';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const PERCENT = 100;
const INVENTORY = { columns: 9, mainFrom: 9, mainTo: 36, hotbar: 9 } as const;
const ENDER_SLOTS = 27;

/** 4711 → "01:18:31" (hours may grow past 99). */
function clock(seconds: number | null): string {
  if (seconds === null) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(seconds / SECONDS_PER_HOUR);
  const m = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${pad(h)}:${pad(m)}:${pad(seconds % SECONDS_PER_MINUTE)}`;
}

const panel = 'rounded-[12px] border border-border bg-card';

function Tile({
  icon,
  label,
  value,
  onEdit,
  editLabel,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onEdit?: () => void;
  editLabel?: string;
}): ReactElement {
  return (
    <div
      className={cn(
        panel,
        'flex min-w-0 items-center gap-2.5 px-3 py-3 sm:gap-3 sm:px-4 sm:py-3.5 [&>svg]:size-5 [&>svg]:shrink-0',
      )}
    >
      {icon}
      <span className="grid min-w-0 flex-1">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <b className="truncate text-[14px] font-bold">{value}</b>
      </span>
      {onEdit ? (
        <Tip content={editLabel}>
          <button
            type="button"
            onClick={onEdit}
            aria-label={editLabel}
            className="rounded-md p-1 text-success hover:bg-secondary disabled:opacity-40"
          >
            <PencilLine className="size-4" />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

function StatList({
  icon,
  title,
  rows,
  mob,
  total,
}: {
  icon: ReactNode;
  title: string;
  rows: readonly StatCount[];
  mob?: boolean;
  total?: number;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn(panel, 'grid content-start gap-2.5 p-4')}>
      <h3 className="flex items-center gap-2 text-[15px] font-bold [&>svg]:size-4">
        {icon}
        <span className="flex-1">{title}</span>
        {total !== undefined ? (
          <span className="font-semibold tabular-nums">{formatNumber(total)}</span>
        ) : null}
      </h3>
      {rows.length === 0 ? (
        <span className="text-[13px] text-muted-foreground">{t('playerDetail.none')}</span>
      ) : null}
      <ul className="grid max-h-56 gap-1 overflow-y-auto pr-1 text-[13px]">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            {mob === undefined ? null : <ItemIcon id={r.id} mob={mob} className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">
              {mob === undefined ? t(`playerDetail.travel.${r.id}`) : itemName(r.id)}
            </span>
            <b className="tabular-nums">{formatNumber(r.count)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Slot({ item }: { item: ItemStack | undefined }): ReactElement {
  const box =
    'relative grid aspect-square place-items-center rounded-[8px] border border-border bg-background/60';
  if (!item) return <div className={box} />;
  return (
    <Tip content={`${itemName(item.id, item.customName)} × ${item.count}`}>
      <div className={cn(box, 'hover:border-primary/60')}>
        <ItemIcon id={item.id} className="size-[60%]" />
        {item.count > 1 ? (
          <span className="absolute bottom-0.5 right-1 text-[11px] font-bold tabular-nums [text-shadow:0_1px_0_#000]">
            {item.count}
          </span>
        ) : null}
      </div>
    </Tip>
  );
}

function Inventory({ player }: { player: PlayerDetail }): ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'inventory' | 'ender'>('inventory');
  const bySlot = (items: readonly ItemStack[], slot: number) => items.find((i) => i.slot === slot);
  const main = Array.from(
    { length: INVENTORY.mainTo - INVENTORY.mainFrom },
    (_, i) => INVENTORY.mainFrom + i,
  );
  const hotbar = Array.from({ length: INVENTORY.hotbar }, (_, i) => i);
  const armor = [
    { key: 'head', item: player.armor.head },
    { key: 'chest', item: player.armor.chest },
    { key: 'legs', item: player.armor.legs },
    { key: 'feet', item: player.armor.feet },
    { key: 'offhand', item: player.armor.offhand },
  ] as const;
  const tabs = [
    { id: 'inventory', icon: Backpack },
    { id: 'ender', icon: Package },
  ] as const;
  return (
    <div className={cn(panel, 'grid gap-5 p-4')}>
      <div className="flex gap-1 border-b border-border" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-[15px] font-medium',
              tab === x.id ? 'border-success text-success' : 'border-transparent text-muted-foreground',
            )}
          >
            <x.icon className="size-4" aria-hidden />
            {t(`playerDetail.tabs.${x.id}`)}
          </button>
        ))}
      </div>
      {tab === 'inventory' ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="grid content-start gap-3">
            <h3 className="text-[15px] font-bold">{t('playerDetail.mainInventory')}</h3>
            <div className="grid grid-cols-9 gap-1.5 sm:gap-2">
              {main.map((slot) => (
                <Slot key={slot} item={bySlot(player.inventory, slot)} />
              ))}
            </div>
            <h3 className="pt-1 text-[13px] font-semibold text-muted-foreground">
              {t('playerDetail.hotbar')}
            </h3>
            <div className="grid grid-cols-9 gap-1.5 sm:gap-2">
              {hotbar.map((slot) => (
                <Slot key={slot} item={bySlot(player.inventory, slot)} />
              ))}
            </div>
          </div>
          <div className="grid content-start gap-3">
            <h3 className="text-[15px] font-bold">{t('playerDetail.armor')}</h3>
            {armor.map(({ key, item }) => (
              <div
                key={key}
                className={cn(panel, 'flex min-w-0 items-center gap-3 bg-secondary/40 px-3 py-2.5')}
              >
                {item ? (
                  <ItemIcon id={item.id} className="size-7 shrink-0" />
                ) : (
                  <span className="size-7 shrink-0 rounded-[6px] border border-dashed border-border" />
                )}
                <span className="grid min-w-0">
                  <b className="truncate text-[14px] font-bold">
                    {item ? itemName(item.id, item.customName) : t('playerDetail.emptySlot')}
                  </b>
                  <span className="text-[12px] text-muted-foreground">
                    {t(`playerDetail.armorSlots.${key}`)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid max-w-3xl grid-cols-9 gap-1.5 sm:gap-2">
          {Array.from({ length: ENDER_SLOTS }, (_, slot) => (
            <Slot key={slot} item={bySlot(player.enderChest, slot)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatArchive({ player }: { player: PlayerDetail }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn(panel, 'grid gap-3 p-4')}>
      <h3 className="flex items-center gap-2 text-[15px] font-bold">
        <MessageSquareText className="size-4 text-primary" aria-hidden />
        <span className="flex-1">{t('playerDetail.chatTitle')}</span>
        <span className="text-[12px] font-medium text-muted-foreground">{t('playerDetail.chatHint')}</span>
      </h3>
      {player.chat.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('playerDetail.chatEmpty')}</p>
      ) : (
        <ol className="grid max-h-[28rem] gap-1 overflow-y-auto pr-1">
          {player.chat.map((line, i) => (
            <li
              key={`${line.at}-${i}`}
              className="flex min-w-0 items-start gap-3 rounded-[8px] px-2 py-1.5 text-[13px] odd:bg-secondary/40"
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-[12px] text-muted-foreground">
                {line.at ? `${line.at.slice(8, 10)}.${line.at.slice(5, 7)}. ${line.at.slice(11, 16)}` : ''}
              </span>
              {line.kind === 'command' ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Terminal
                    className="size-3.5 shrink-0 text-warning"
                    aria-label={t('playerDetail.command')}
                  />
                  <code className="break-all font-mono text-[12.5px] text-warning">{line.text}</code>
                </span>
              ) : (
                <span className="min-w-0 break-words">{line.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Stepper({
  label,
  children,
  onDown,
  onUp,
  disabled,
  tone,
}: {
  label: string;
  children: ReactNode;
  onDown: () => void;
  onUp: () => void;
  disabled: boolean;
  tone: 'red' | 'amber' | 'green';
}): ReactElement {
  const { t } = useTranslation();
  const colours = {
    red: 'bg-destructive/25 text-destructive',
    amber: 'bg-warning/25 text-warning',
    green: 'bg-success/25 text-success',
  }[tone];
  const step = 'grid size-6 place-items-center rounded-[5px] disabled:opacity-40 hover:brightness-125';
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[14px] text-muted-foreground">{label}</span>
      <button
        type="button"
        className={cn(step, colours)}
        onClick={onDown}
        disabled={disabled}
        aria-label={`${label} −`}
      >
        <Minus className="size-3.5" />
      </button>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      <Tip content={disabled ? t('playerDetail.onlyOnline') : label}>
        <button
          type="button"
          className={cn(step, colours)}
          onClick={onUp}
          disabled={disabled}
          aria-label={`${label} +`}
        >
          <Plus className="size-3.5" />
        </button>
      </Tip>
    </div>
  );
}

function GamemodeDialog({
  current,
  onClose,
  onSave,
}: {
  current: PlayerGamemode | null;
  onClose: () => void;
  onSave: (mode: PlayerGamemode) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PlayerGamemode>(current ?? 'survival');
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle>{t('playerDetail.gamemodeTitle')}</DialogTitle>
        <Select value={mode} onValueChange={(v) => setMode(v as PlayerGamemode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAYER_GAMEMODES.map((g) => (
              <SelectItem key={g} value={g}>
                {t(`playerDetail.gamemodes.${g}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onSave(mode)}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeleportDialog({
  current,
  onClose,
  onSave,
}: {
  current: PlayerDetail['position'];
  onClose: () => void;
  onSave: (to: { x: number; y: number; z: number }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [pos, setPos] = useState({
    x: String(Math.round(current?.x ?? 0)),
    y: String(Math.round(current?.y ?? 64)),
    z: String(Math.round(current?.z ?? 0)),
  });
  const values = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
  const valid =
    Object.values(values).every((n) => Number.isFinite(n)) && Object.values(pos).every((v) => v.trim());
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) onSave(values);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle>{t('playerDetail.teleportTitle')}</DialogTitle>
        <DialogDescription>{t('playerDetail.teleportText')}</DialogDescription>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid grid-cols-3 gap-3">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <Field key={axis} id={`tp-${axis}`} label={axis.toUpperCase()}>
                <Input
                  id={`tp-${axis}`}
                  inputMode="decimal"
                  value={pos[axis]}
                  onChange={(e) => setPos((p) => ({ ...p, [axis]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid}>
              {t('playerDetail.teleport')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Server → Spieler → one player: everything about them, also while they (or the server) are offline. */
export default function PlayerDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const key = ['player-detail', server.id, uuid];
  const [dialog, setDialog] = useState<'gamemode' | 'teleport' | null>(null);
  const [confirm, setConfirm] = useState<'ban' | 'kick' | null>(null);
  const {
    data: player,
    error,
    isFetching,
  } = useQuery({
    queryKey: key,
    queryFn: () => api<PlayerDetail>(`/api/servers/${server.id}/players/known/${uuid}`),
    refetchInterval: (q) => (q.state.data?.online ? 15_000 : false),
  });
  const adjust = useMutation({
    mutationFn: (change: PlayerAdjust) =>
      api(`/api/servers/${server.id}/players/known/${uuid}/adjust`, { method: 'POST', body: change }),
    onSuccess: () => {
      setDialog(null);
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), 1600);
    },
  });
  const act = useMutation({
    mutationFn: (action: PlayerAction) =>
      api(`/api/servers/${server.id}/players/action`, {
        method: 'POST',
        body: { action, name: player?.name ?? '' },
      }),
    onSuccess: async () => {
      toast.success(t('playerDetail.done'));
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ['players', server.id] });
    },
  });
  // "Aktualisieren" asks the server to save first, so an online player's data is current.
  const refresh = useMutation({
    mutationFn: () => api<PlayerDetail>(`/api/servers/${server.id}/players/known/${uuid}?fresh=1`),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });
  if (error) return <EmptyState title={errorText(error)} />;
  if (!player) return <Skeleton className="h-[40rem] rounded-[16px]" />;
  const canAdjust = player.online && can('commands');
  const actions: readonly { action: PlayerAction; label: string; show: boolean }[] = [
    {
      action: player.whitelisted ? 'whitelist-remove' : 'whitelist-add',
      label: player.whitelisted ? 'dewhitelist' : 'whitelist',
      show: true,
    },
    { action: player.op ? 'deop' : 'op', label: player.op ? 'deop' : 'op', show: true },
    { action: 'kick', label: 'kick', show: player.online },
    { action: player.banned ? 'pardon' : 'ban', label: player.banned ? 'pardon' : 'ban', show: true },
  ];
  const kdr = player.deaths ? player.playerKills / player.deaths : player.playerKills;
  const travel = [
    { id: 'walk', count: player.travel.walk },
    { id: 'sprint', count: player.travel.sprint },
    { id: 'crouch', count: player.travel.crouch },
    { id: 'swim', count: player.travel.swim },
    { id: 'ride', count: player.travel.ride },
    { id: 'fly', count: player.travel.fly },
  ];
  const progress = Math.round((player.levelProgress ?? 0) * PERCENT);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <Link
          to=".."
          relative="path"
          className="inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('playerDetail.back')}
        </Link>
      </div>
      <div className={cn(panel, 'grid gap-3 bg-card/60 p-3 sm:p-4')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[14px] text-success">
            {t('playerDetail.refreshed', { time: formatTime(player.refreshedAt) })}
          </span>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-1.5 text-[15px] font-medium hover:text-primary"
          >
            <RefreshCw
              className={cn('size-4', (isFetching || refresh.isPending) && 'animate-spin')}
              aria-hidden
            />
            {t('playerDetail.refresh')}
          </button>
        </div>

        <div
          className={cn(panel, 'grid gap-4 bg-secondary/40 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]')}
        >
          <div className="grid min-w-0 content-start gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <PlayerHead name={player.name} skin={player.uuid} className="size-12 shrink-0 rounded-[6px]" />
              <div className="grid min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <b className="truncate text-[17px] font-bold">{player.name}</b>
                  <span
                    className={cn(
                      'rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold uppercase',
                      player.online ? 'bg-success text-background' : 'bg-destructive text-white',
                    )}
                  >
                    {player.online ? t('playerDetail.online') : t('playerDetail.offline')}
                  </span>
                  {player.op ? (
                    <span className="rounded-[5px] bg-success/15 px-1.5 py-0.5 text-[11px] font-bold text-success">
                      OP
                    </span>
                  ) : null}
                  {player.banned ? (
                    <span className="rounded-[5px] bg-destructive/20 px-1.5 py-0.5 text-[11px] font-bold text-destructive">
                      {t('playerDetail.banned')}
                    </span>
                  ) : null}
                </span>
                <span className="truncate font-mono text-[12px] text-muted-foreground">{player.uuid}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {actions
                .filter((a) => a.show)
                .map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    disabled={act.isPending}
                    onClick={() =>
                      a.action === 'ban' || a.action === 'kick' ? setConfirm(a.action) : act.mutate(a.action)
                    }
                    className="rounded-[6px] border border-border bg-background/50 px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide hover:border-primary/60 disabled:opacity-50"
                  >
                    {t(`playerDetail.actions.${a.label}`)}
                  </button>
                ))}
            </div>
          </div>
          <div className="grid content-center gap-2.5">
            <Stepper
              label={t('playerDetail.health')}
              tone="red"
              disabled={!canAdjust || adjust.isPending}
              onDown={() => adjust.mutate({ kind: 'health', direction: 'down' })}
              onUp={() => adjust.mutate({ kind: 'health', direction: 'up' })}
            >
              <Hearts value={player.health} max={player.maxHealth} />
            </Stepper>
            <Stepper
              label={t('playerDetail.food')}
              tone="amber"
              disabled={!canAdjust || adjust.isPending}
              onDown={() => adjust.mutate({ kind: 'food', direction: 'down' })}
              onUp={() => adjust.mutate({ kind: 'food', direction: 'up' })}
            >
              <Food value={player.food} />
            </Stepper>
            <Stepper
              label={t('playerDetail.level', { level: player.level ?? 0 })}
              tone="green"
              disabled={!canAdjust || adjust.isPending}
              onDown={() => adjust.mutate({ kind: 'level', direction: 'down' })}
              onUp={() => adjust.mutate({ kind: 'level', direction: 'up' })}
            >
              <span className="flex w-full items-center gap-2">
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-background">
                  <span
                    className="block h-full rounded-full bg-success transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </span>
                <span className="w-9 text-right text-[12px] tabular-nums text-muted-foreground">
                  {progress}%
                </span>
              </span>
            </Stepper>
          </div>
        </div>

        {player.hasData ? null : (
          <p className="rounded-[10px] bg-warning-soft px-3 py-2 text-[13px]">{t('playerDetail.noData')}</p>
        )}

        <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
          <Tile icon={<Clock />} label={t('playerDetail.playTime')} value={clock(player.playTimeSeconds)} />
          <Tile
            icon={<Globe2 />}
            label={t('playerDetail.world')}
            value={
              player.world ? t(`playerDetail.worlds.${player.world}`, { defaultValue: player.world }) : '—'
            }
          />
          <Tile
            icon={<MapPin />}
            label={t('playerDetail.position')}
            value={
              player.position
                ? `${formatNumber(player.position.x, 1)}, ${Math.round(player.position.y)}, ${Math.round(player.position.z)}`
                : '—'
            }
            onEdit={canAdjust ? () => setDialog('teleport') : undefined}
            editLabel={t('playerDetail.teleportTitle')}
          />
          <Tile
            icon={<BedDouble />}
            label={t('playerDetail.lastSlept')}
            value={clock(player.sinceRestSeconds)}
          />
          <Tile
            icon={<Gamepad2 />}
            label={t('playerDetail.gamemode')}
            value={player.gamemode ? t(`playerDetail.gamemodes.${player.gamemode}`) : '—'}
            onEdit={canAdjust ? () => setDialog('gamemode') : undefined}
            editLabel={t('playerDetail.gamemodeTitle')}
          />
          <Tile
            icon={<Skull />}
            label={t('playerDetail.lastDeath')}
            value={clock(player.sinceDeathSeconds)}
          />
          <Tile icon={<Crosshair />} label={t('playerDetail.kdr')} value={formatNumber(kdr, 1)} />
          <Tile
            icon={<Swords />}
            label={t('playerDetail.deathsKills')}
            value={`${player.deaths} / ${player.playerKills}`}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatList icon={<Hand />} title={t('playerDetail.pickedUp')} rows={player.pickedUp} mob={false} />
          <StatList icon={<Zap />} title={t('playerDetail.used')} rows={player.used} mob={false} />
          <StatList icon={<Crosshair />} title={t('playerDetail.mobsKilled')} rows={player.killed} mob />
          <StatList
            icon={<Footprints />}
            title={t('playerDetail.travelled')}
            rows={travel}
            total={player.travel.total}
          />
        </div>

        <Inventory player={player} />
        <ChatArchive player={player} />
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={
          confirm === 'ban'
            ? t('playerDetail.confirmBan', { name: player.name })
            : t('playerDetail.confirmKick', { name: player.name })
        }
        description={player.uuid}
        confirmLabel={confirm === 'ban' ? t('playerDetail.actions.ban') : t('playerDetail.actions.kick')}
        onConfirm={() => {
          if (confirm) act.mutate(confirm);
          setConfirm(null);
        }}
      />
      {dialog === 'gamemode' ? (
        <GamemodeDialog
          current={player.gamemode}
          onClose={() => setDialog(null)}
          onSave={(gamemode) => adjust.mutate({ kind: 'gamemode', gamemode })}
        />
      ) : null}
      {dialog === 'teleport' ? (
        <TeleportDialog
          current={player.position}
          onClose={() => setDialog(null)}
          onSave={(to) => adjust.mutate({ kind: 'teleport', ...to })}
        />
      ) : null}
    </div>
  );
}
