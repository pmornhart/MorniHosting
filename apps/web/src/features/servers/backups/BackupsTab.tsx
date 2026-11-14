import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  CalendarClock,
  Download,
  HardDrive,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { BackupEntry, BackupSettings } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Pill, Tag, type PillTone } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, apiUrl } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { useServer } from '../ServerLayout';
import { TabIntro } from '@/components/tab-intro';

interface BackupsResponse {
  readonly backups: readonly BackupEntry[];
  readonly settings: BackupSettings;
  readonly totalBytes: number;
  readonly freeBytes: number;
}

const POLL_MS = 1500;
const KEEP_CHOICES: readonly number[] = [1, 2, 3, 5, 7, 10, 14, 20, 30]; // eslint-disable-line ts-patterns/no-magic-numbers -- choices offered in the select
const KIND_TONE: Readonly<Record<BackupEntry['kind'], PillTone>> = {
  manual: 'neutral',
  scheduled: 'accent',
  'before-restore': 'warn',
};

function SettingsCard({ serverId, settings }: { serverId: string; settings: BackupSettings }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [keep, setKeep] = useState(settings.keep);
  const [exclude, setExclude] = useState<readonly string[]>(settings.exclude);
  const [draft, setDraft] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<BackupSettings>(`/api/servers/${serverId}/backups/settings`, {
        method: 'PUT',
        body: { keep, exclude },
      }),
    onSuccess: async () => {
      toast.success(t('common.saved'));
      await queryClient.invalidateQueries({ queryKey: ['backups', serverId] });
    },
  });
  const changed = keep !== settings.keep || exclude.join('\n') !== settings.exclude.join('\n');
  const add = (e: FormEvent): void => {
    e.preventDefault();
    const value = draft.trim();
    if (value && !exclude.includes(value)) setExclude([...exclude, value]);
    setDraft('');
  };
  return (
    <Card className="p-5">
      <CardHeader className="mb-1">
        <CardTitle>{t('backups.settingsTitle')}</CardTitle>
      </CardHeader>
      <CardDescription className="mb-4">{t('backups.settingsText')}</CardDescription>
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm font-semibold">
          {t('backups.keep')}
          <Select value={String(keep)} onValueChange={(v) => setKeep(Number(v))}>
            <SelectTrigger className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEEP_CHOICES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('backups.keepN', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="grid gap-2">
          <span className="text-sm font-semibold">{t('backups.exclude')}</span>
          <div className="flex flex-wrap gap-1.5">
            {exclude.map((pattern) => (
              <Tag key={pattern} className="gap-1 pr-1 font-mono">
                {pattern}
                <button
                  type="button"
                  aria-label={t('backups.removeExclude', { pattern })}
                  onClick={() => setExclude(exclude.filter((p) => p !== pattern))}
                  className="rounded p-0.5 hover:bg-muted"
                >
                  <X className="size-3" />
                </button>
              </Tag>
            ))}
            {exclude.length ? null : (
              <span className="text-[13px] text-muted-foreground">{t('backups.excludeNone')}</span>
            )}
          </div>
          <form onSubmit={add} className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('backups.excludePlaceholder')}
              aria-label={t('backups.exclude')}
              className="font-mono"
            />
            <Button type="submit" variant="secondary" disabled={!draft.trim()}>
              <Plus />
              {t('backups.addExclude')}
            </Button>
          </form>
          <p className="text-[13px] text-muted-foreground">{t('backups.excludeHint')}</p>
        </div>
        <div className="flex justify-end">
          <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>
            <Save />
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Backups: one click to create, one to restore; old ones are cleaned up automatically. */
export default function BackupsTab(): ReactElement {
  const { t } = useTranslation();
  const { server, can } = useServer();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const [deleting, setDeleting] = useState<BackupEntry | null>(null);
  const key = ['backups', server.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<BackupsResponse>(`/api/servers/${server.id}/backups`),
    refetchInterval: (query) =>
      query.state.data?.backups.some((b) => b.status === 'running') ? POLL_MS : false,
  });
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api<BackupEntry>(`/api/servers/${server.id}/backups`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success(t('backups.started'));
      await refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (b: BackupEntry) =>
      api(`/api/servers/${server.id}/backups/${b.id}/restore`, { method: 'POST' }),
    onSuccess: async (_r, b) => {
      toast.success(t('backups.restored', { when: formatDateTime(b.createdAt) }));
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['files', server.id] });
    },
  });
  const remove = useMutation({
    mutationFn: (b: BackupEntry) => api(`/api/servers/${server.id}/backups/${b.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (!can('backups')) return <EmptyState title={t('server.noPermission')} />;
  if (!data) return <Skeleton className="h-96 rounded-[16px]" />;
  const running = data.backups.some((b) => b.status === 'running');

  const statusLine = (b: BackupEntry): string => {
    const lines: Readonly<Record<BackupEntry['status'], () => string>> = {
      running: () => t('backups.running'),
      done: () => `${formatBytes(b.sizeBytes)} · ${formatRelative(b.createdAt)}`,
      failed: () => (b.error === 'interrupted' ? t('backups.interrupted') : (b.error ?? '')),
    };
    return lines[b.status]();
  };

  const list = (): ReactElement => {
    if (!data.backups.length) {
      return (
        <EmptyState
          icon={<Archive />}
          title={t('backups.emptyTitle')}
          text={t('backups.emptyText')}
          action={
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              <Plus />
              {t('backups.create')}
            </Button>
          }
        />
      );
    }
    return (
      <Card className="divide-y divide-border overflow-hidden">
        {data.backups.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid size-10 place-items-center rounded-[10px] bg-accent text-primary">
              {b.status === 'running' ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <Archive className="size-5" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-sm font-semibold">{formatDateTime(b.createdAt)}</b>
                <Pill tone={KIND_TONE[b.kind]} dot={false}>
                  {t(`backups.kind.${b.kind}`)}
                </Pill>
                {b.status === 'failed' ? <Pill tone="bad">{t('backups.failed')}</Pill> : null}
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{statusLine(b)}</p>
            </div>
            {b.status === 'done' ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRestoring(b)}
                  disabled={restore.isPending}
                >
                  <RotateCcw />
                  {t('common.restore')}
                </Button>
                <Button size="icon-sm" variant="ghost" asChild aria-label={t('common.download')}>
                  <a href={apiUrl(`/api/servers/${server.id}/backups/${b.id}/download`)} download>
                    <Download />
                  </a>
                </Button>
              </>
            ) : null}
            {b.status === 'running' ? null : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.delete')}
                onClick={() => setDeleting(b)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </Card>
    );
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="lg:col-span-2">
        <TabIntro title={t('backups.title')} text={t('backups.intro')} />
      </div>
      <div className="grid min-w-0 gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => create.mutate()} disabled={create.isPending || running}>
            {running ? <Loader2 className="animate-spin" /> : <Plus />}
            {running ? t('backups.running') : t('backups.create')}
          </Button>
          <Button variant="secondary" asChild>
            <Link to="../schedules">
              <CalendarClock />
              {t('backups.automatic')}
            </Link>
          </Button>
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <HardDrive className="size-4" aria-hidden />
            {t('backups.storage', { used: formatBytes(data.totalBytes), free: formatBytes(data.freeBytes) })}
          </span>
        </div>
        {list()}
      </div>
      <SettingsCard
        key={`${data.settings.keep}-${data.settings.exclude.join(',')}`}
        serverId={server.id}
        settings={data.settings}
      />

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={t('backups.restoreTitle', { when: restoring ? formatDateTime(restoring.createdAt) : '' })}
        description={t(
          server.live.state === 'running' ? 'backups.restoreTextRunning' : 'backups.restoreText',
        )}
        confirmLabel={t('common.restore')}
        destructive={false}
        onConfirm={async () => {
          if (restoring) await restore.mutateAsync(restoring);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('backups.deleteTitle')}
        description={t('backups.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </div>
  );
}
