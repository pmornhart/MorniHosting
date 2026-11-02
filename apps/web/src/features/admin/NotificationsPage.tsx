import { DiscordBotCard } from './DiscordBotCard';
import { MailOutbox } from './MailOutbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Globe,
  Hash,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_KINDS,
  type WebhookEntry,
  type WebhookEvent,
  type WebhookInput,
  type WebhookKind,
} from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field, Label } from '@/components/ui/label';
import { Checkbox, Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSession } from '@/features/auth/session';
import { serversQuery } from '@/features/servers/live';

const KIND_ICONS: Readonly<Record<WebhookKind, LucideIcon>> = {
  discord: MessageCircle,
  slack: Hash,
  teams: Users,
  generic: Globe,
};
const KIND_LABELS: Readonly<Record<WebhookKind, string>> = {
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  generic: 'Webhook',
};
const OK_FROM = 200;
const OK_UNTIL = 300;
const ALL_SERVERS = 'all';
const DEFAULT_EVENTS: readonly WebhookEvent[] = [
  'server.started',
  'server.stopped',
  'server.crashed',
  'backup.failed',
];

interface Draft {
  readonly name: string;
  readonly kind: WebhookKind;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly serverId: string | null;
}

function draftOf(entry: WebhookEntry | null): Draft {
  return entry
    ? { name: entry.name, kind: entry.kind, url: '', events: entry.events, serverId: entry.serverId }
    : { name: '', kind: 'discord', url: '', events: DEFAULT_EVENTS, serverId: null };
}

function WebhookDialog({
  open,
  onOpenChange,
  entry,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: WebhookEntry | null;
  onSubmit: (input: Partial<WebhookInput>) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const { data: servers } = useQuery(serversQuery);
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDraft(draftOf(entry));
  }, [open, entry]);
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const name = draft.name.trim() || KIND_LABELS[draft.kind];
  const valid = draft.events.length > 0 && (entry !== null || draft.url.trim().startsWith('https://'));

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await onSubmit({
        name,
        kind: draft.kind,
        events: [...draft.events],
        serverId: draft.serverId,
        ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
      });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogTitle>{entry ? t('webhooks.editTitle') : t('webhooks.newTitle')}</DialogTitle>
        <DialogDescription>{t('webhooks.dialogText')}</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="grid gap-5">
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            role="radiogroup"
            aria-label={t('webhooks.kind')}
          >
            {WEBHOOK_KINDS.map((kind) => {
              const Icon = KIND_ICONS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === kind}
                  onClick={() => set({ kind })}
                  className={cn(
                    'grid justify-items-center gap-1.5 rounded-[12px] border px-2 py-3 text-[13px] font-semibold',
                    draft.kind === kind ? 'border-primary bg-accent' : 'border-input hover:bg-secondary',
                  )}
                >
                  <Icon className="size-5 text-primary" aria-hidden />
                  {kind === 'generic' ? t('webhooks.generic') : KIND_LABELS[kind]}
                </button>
              );
            })}
          </div>
          <Field
            id="webhook-url"
            label={t('webhooks.url')}
            hint={entry ? t('webhooks.urlKeep', { host: entry.urlHost }) : t(`webhooks.howTo.${draft.kind}`)}
          >
            <Input
              id="webhook-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={draft.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder={t(`webhooks.placeholder.${draft.kind}`)}
            />
          </Field>
          <div className="grid gap-2">
            <Label>{t('webhooks.events')}</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map((event) => (
                <label
                  key={event}
                  className="flex items-center gap-2.5 rounded-[10px] border border-border px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={draft.events.includes(event)}
                    onCheckedChange={(on) =>
                      set({
                        events:
                          on === true ? [...draft.events, event] : draft.events.filter((e) => e !== event),
                      })
                    }
                  />
                  {t(`webhooks.event.${event}`)}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-semibold">
              {t('webhooks.servers')}
              <Select
                value={draft.serverId ?? ALL_SERVERS}
                onValueChange={(v) => set({ serverId: v === ALL_SERVERS ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SERVERS}>{t('webhooks.allServers')}</SelectItem>
                  {(servers ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Field id="webhook-name" label={t('common.name')}>
              <Input
                id="webhook-name"
                value={draft.name}
                maxLength={40}
                placeholder={KIND_LABELS[draft.kind]}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {entry ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Messages to Discord, Slack or Teams when servers start, stop, crash, or backups finish. */
export function NotificationsPage(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ entry: WebhookEntry | null } | null>(null);
  const [deleting, setDeleting] = useState<WebhookEntry | null>(null);
  const { data: servers } = useQuery(serversQuery);
  const { data } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<WebhookEntry[]>('/api/webhooks'),
    enabled: me.user.isAdmin,
  });
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['webhooks'] });

  const save = useMutation({
    mutationFn: ({ input, id }: { input: Partial<WebhookInput>; id: number | null }) =>
      api<WebhookEntry>(id ? `/api/webhooks/${id}` : '/api/webhooks', {
        method: id ? 'PATCH' : 'POST',
        body: input,
      }),
    onSuccess: async (entry, { id }) => {
      toast.success(t('webhooks.saved', { name: entry.name }));
      await refresh();
      if (!id) test.mutate(entry);
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api(`/api/webhooks/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (entry: WebhookEntry) =>
      api<{ status: number }>(`/api/webhooks/${entry.id}/test`, { method: 'POST' }),
    onSuccess: async ({ status }) => {
      if (status >= OK_FROM && status < OK_UNTIL) toast.success(t('webhooks.testOk'));
      else toast.error(status ? t('webhooks.testFailed', { status }) : t('webhooks.testUnreachable'));
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (entry: WebhookEntry) => api(`/api/webhooks/${entry.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (!me.user.isAdmin) return <EmptyState title={t('errors.admin_only')} />;
  const serverName = (id: string | null): string =>
    id ? (servers?.find((s) => s.id === id)?.name ?? id) : t('webhooks.allServers');

  const list = (): ReactElement => {
    if (!data) return <Skeleton className="h-48 rounded-[16px]" />;
    if (!data.length) {
      return (
        <EmptyState
          icon={<Bell />}
          title={t('webhooks.emptyTitle')}
          text={t('webhooks.emptyText')}
          action={
            <Button onClick={() => setDialog({ entry: null })}>
              <Plus />
              {t('webhooks.new')}
            </Button>
          }
        />
      );
    }
    return (
      <Card className="divide-y divide-border overflow-hidden">
        {data.map((entry) => {
          const Icon = KIND_ICONS[entry.kind];
          const ok = entry.lastStatus !== null && entry.lastStatus >= OK_FROM && entry.lastStatus < OK_UNTIL;
          return (
            <div
              key={entry.id}
              className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !entry.enabled && 'opacity-60')}
            >
              <span className="grid size-10 place-items-center rounded-[10px] bg-accent text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="truncate text-sm font-semibold">{entry.name}</b>
                  {entry.lastAt ? (
                    <Pill tone={ok ? 'ok' : 'bad'}>
                      {ok
                        ? t('webhooks.lastOk', { when: formatRelative(entry.lastAt) })
                        : t('webhooks.lastFailed', { status: entry.lastStatus ?? 0 })}
                    </Pill>
                  ) : null}
                </div>
                <p className="truncate text-[12px] text-muted-foreground">
                  {entry.urlHost} · {serverName(entry.serverId)} ·{' '}
                  {t('webhooks.eventCount', { count: entry.events.length })}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={test.isPending}
                onClick={() => test.mutate(entry)}
              >
                <Send />
                {t('webhooks.test')}
              </Button>
              <Switch
                checked={entry.enabled}
                aria-label={t('webhooks.enabledFor', { name: entry.name })}
                onCheckedChange={(enabled) => toggle.mutate({ id: entry.id, enabled })}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('files.actionsFor', { name: entry.name })}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog({ entry })}>
                    <Pencil />
                    {t('common.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => setDeleting(entry)}>
                    <Trash2 />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
        actions={
          <Button onClick={() => setDialog({ entry: null })}>
            <Plus />
            {t('webhooks.new')}
          </Button>
        }
      />
      <DiscordBotCard />
      <MailOutbox />
      <h2 className="text-lg font-semibold">{t('webhooks.channelsTitle')}</h2>
      {list()}
      <WebhookDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        entry={dialog?.entry ?? null}
        onSubmit={async (input) => {
          await save.mutateAsync({ input, id: dialog?.entry?.id ?? null });
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('webhooks.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('webhooks.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </>
  );
}
