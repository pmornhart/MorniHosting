import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Crown, DoorOpen, ListChecks, Plus, ShieldOff, UserMinus, UsersRound } from 'lucide-react';
import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  SOFTWARE,
  gameOf,
  type PlayerAction,
  type PlayerEntry,
  type PlayersResponse,
} from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/page';
import { PlayerHead } from '@/components/server-visuals';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton, Tip } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useServer } from '../ServerLayout';
import { TabIntro } from '@/components/tab-intro';
import { KnownPlayersCard } from './KnownPlayersCard';

interface ActionInput {
  readonly action: PlayerAction;
  readonly name: string;
  readonly reason?: string;
}

interface RowAction {
  readonly action: PlayerAction;
  readonly icon: typeof Crown;
  readonly label: string;
  readonly destructive?: boolean;
}

function PlayerRow({
  player,
  sub,
  actions,
  onAction,
  busy,
}: {
  player: PlayerEntry;
  sub?: ReactNode;
  actions: readonly RowAction[];
  onAction: (action: RowAction) => void;
  busy: boolean;
}): ReactElement {
  return (
    <li className="flex items-center gap-3 rounded-[10px] px-2 py-1.5 hover:bg-secondary/60">
      <PlayerHead name={player.name} className="size-8 rounded-[7px]" />
      <div className="min-w-0 flex-1">
        <b className="block truncate text-sm font-semibold">{player.name}</b>
        {sub ? <span className="block truncate text-[12px] text-muted-foreground">{sub}</span> : null}
      </div>
      <div className="flex gap-1">
        {actions.map((a) => (
          <Tip key={a.action} content={a.label}>
            <Button
              size="icon-sm"
              variant={a.destructive ? 'destructive' : 'secondary'}
              aria-label={`${a.label}: ${player.name}`}
              disabled={busy}
              onClick={() => onAction(a)}
            >
              <a.icon />
            </Button>
          </Tip>
        ))}
      </div>
    </li>
  );
}

function AddPlayer({
  label,
  placeholder,
  onAdd,
  withReason = false,
}: {
  label: string;
  placeholder: string;
  onAdd: (name: string, reason: string) => Promise<void>;
  withReason?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onAdd(name.trim(), reason.trim());
      setName('');
      setReason('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-wrap gap-2">
      <Input
        aria-label={label}
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-w-[150px] flex-1"
        autoComplete="off"
      />
      {withReason ? (
        <Input
          aria-label={t('playersTab.reason')}
          placeholder={t('playersTab.reasonPlaceholder')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-w-[150px] flex-1"
        />
      ) : null}
      <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>
        <Plus />
        {label}
      </Button>
    </form>
  );
}

function ListCard({
  icon,
  title,
  text,
  count,
  empty,
  children,
  extra,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  count: number;
  empty: string;
  children: ReactNode;
  extra?: ReactNode;
}): ReactElement {
  return (
    <Card className="p-5">
      <CardHeader className="mb-1 items-start">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-accent text-primary [&_svg]:size-4">
            {icon}
          </span>
          <CardTitle>
            {title} <span className="tabular font-normal text-muted-foreground">({count})</span>
          </CardTitle>
        </div>
        {extra}
      </CardHeader>
      <CardDescription className="mb-3">{text}</CardDescription>
      {count ? (
        <ul className="grid gap-0.5">{children}</ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">{empty}</p>
      )}
    </Card>
  );
}

/** Players: who is online, operators, the whitelist and bans – all without typing commands. */
export default function PlayersTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ActionInput | null>(null);
  const key = ['players', server.id, server.live.players.join(',')];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<PlayersResponse>(`/api/servers/${server.id}/players`),
  });
  const act = useMutation({
    mutationFn: (input: ActionInput) =>
      api(`/api/servers/${server.id}/players/action`, { method: 'POST', body: input }),
    onSuccess: async (_r, input) => {
      toast.success(t(`playersTab.done.${input.action}`, { name: input.name }));
      await queryClient.invalidateQueries({ queryKey: ['players', server.id] });
    },
  });
  const whitelist = useMutation({
    mutationFn: (enabled: boolean) =>
      api<PlayersResponse>(`/api/servers/${server.id}/players/whitelist`, {
        method: 'PUT',
        body: { enabled },
      }),
    onSuccess: (result) => queryClient.setQueryData(key, result),
  });

  if (!can('players')) return <EmptyState title={t('server.noPermission')} />;
  if (SOFTWARE[server.software].proxy) return <EmptyState title={t('playersTab.proxy')} />;
  if (!data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className="h-48 rounded-[16px]" />
        ))}
      </div>
    );
  }

  const bedrock = server.edition === 'bedrock';
  const running = server.live.state === 'running';
  const run = (input: ActionInput): void => {
    const dangerous = input.action === 'ban' || input.action === 'kick';
    if (dangerous) setConfirm(input);
    else act.mutate(input);
  };
  const isOp = (name: string): boolean => data.ops.some((o) => o.name.toLowerCase() === name.toLowerCase());
  const label = (action: PlayerAction): string => t(`playersTab.actions.${action}`);

  return (
    <div className="grid gap-4">
      <TabIntro title={t('playersTab.title')} text={t('playersTab.intro')} />
      {!running ? (
        <p className="rounded-[12px] border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
          {t(bedrock ? 'playersTab.offlineBedrock' : 'playersTab.offline')}
        </p>
      ) : null}
      {bedrock || gameOf(server.software) ? null : (
        <KnownPlayersCard serverId={server.id} live={server.live.players.join(',')} />
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ListCard
          icon={<UsersRound />}
          title={t('playersTab.online')}
          text={t('playersTab.onlineText')}
          count={data.online.length}
          empty={running ? t('players.nobody') : t('players.serverOff')}
        >
          {data.online.map((p) => (
            <PlayerRow
              key={p.name}
              player={p}
              sub={isOp(p.name) ? t('playersTab.isOp') : undefined}
              busy={act.isPending}
              onAction={(a) => run({ action: a.action, name: p.name })}
              actions={[
                isOp(p.name)
                  ? { action: 'deop', icon: ShieldOff, label: label('deop') }
                  : { action: 'op', icon: Crown, label: label('op') },
                { action: 'kick', icon: DoorOpen, label: label('kick'), destructive: true },
                ...(bedrock
                  ? []
                  : [{ action: 'ban', icon: Ban, label: label('ban'), destructive: true } as const]),
              ]}
            />
          ))}
        </ListCard>

        <ListCard
          icon={<Crown />}
          title={t('playersTab.ops')}
          text={t(bedrock ? 'playersTab.opsTextBedrock' : 'playersTab.opsText')}
          count={data.ops.length}
          empty={t('playersTab.noOps')}
        >
          {data.ops.map((p) => (
            <PlayerRow
              key={p.name}
              player={p}
              busy={act.isPending}
              onAction={(a) => run({ action: a.action, name: p.name })}
              actions={bedrock ? [] : [{ action: 'deop', icon: ShieldOff, label: label('deop') }]}
            />
          ))}
          {bedrock ? null : (
            <AddPlayer
              label={label('op')}
              placeholder={t('playersTab.namePlaceholder')}
              onAdd={async (name) => {
                await act.mutateAsync({ action: 'op', name });
              }}
            />
          )}
        </ListCard>

        <ListCard
          icon={<ListChecks />}
          title={t(bedrock ? 'playersTab.allowlist' : 'playersTab.whitelist')}
          text={t('playersTab.whitelistText')}
          count={data.whitelist.length}
          empty={t('playersTab.noWhitelist')}
          extra={
            <label className="flex shrink-0 items-center gap-2 text-[13px] font-semibold">
              <Switch
                checked={data.whitelistEnabled}
                disabled={whitelist.isPending}
                onCheckedChange={(on) => whitelist.mutate(on)}
              />
              {data.whitelistEnabled ? t('common.enabled') : t('common.disabled')}
            </label>
          }
        >
          {data.whitelist.map((p) => (
            <PlayerRow
              key={p.name}
              player={p}
              busy={act.isPending}
              onAction={(a) => run({ action: a.action, name: p.name })}
              actions={[{ action: 'whitelist-remove', icon: UserMinus, label: label('whitelist-remove') }]}
            />
          ))}
          <AddPlayer
            label={label('whitelist-add')}
            placeholder={t('playersTab.namePlaceholder')}
            onAdd={async (name) => {
              await act.mutateAsync({ action: 'whitelist-add', name });
            }}
          />
        </ListCard>

        {bedrock ? null : (
          <ListCard
            icon={<Ban />}
            title={t('playersTab.banned')}
            text={t('playersTab.bannedText')}
            count={data.banned.length}
            empty={t('playersTab.noBans')}
          >
            {data.banned.map((p) => (
              <PlayerRow
                key={p.name}
                player={p}
                sub={p.reason ?? undefined}
                busy={act.isPending}
                onAction={(a) => run({ action: a.action, name: p.name })}
                actions={[{ action: 'pardon', icon: ShieldOff, label: label('pardon') }]}
              />
            ))}
            <AddPlayer
              withReason
              label={label('ban')}
              placeholder={t('playersTab.namePlaceholder')}
              onAdd={async (name, reason) => {
                setConfirm({ action: 'ban', name, reason });
              }}
            />
          </ListCard>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t(`playersTab.confirm.${confirm?.action === 'kick' ? 'kick' : 'ban'}Title`, {
          name: confirm?.name,
        })}
        description={t(`playersTab.confirm.${confirm?.action === 'kick' ? 'kick' : 'ban'}Text`)}
        confirmLabel={confirm ? label(confirm.action) : ''}
        onConfirm={async () => {
          if (confirm) await act.mutateAsync(confirm);
        }}
      />
    </div>
  );
}
