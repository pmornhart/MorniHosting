import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle,
  ExternalLink,
  MoreHorizontal,
  Package,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SOFTWARE, type InstalledContent, type InstallResult, type ServerDetail } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress, Skeleton } from '@/components/ui/misc';
import { Pill, Tag } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api, upload } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { toastError } from '@/lib/query';
import { cn } from '@/lib/utils';
import { SOURCE_LABELS } from './sources';

const PERCENT = 100;

export const contentQuery = (serverId: string) =>
  ({
    queryKey: ['content', serverId],
    queryFn: () => api<InstalledContent[]>(`/api/servers/${serverId}/content`),
  }) as const;

function ContentIcon({ entry }: { entry: InstalledContent }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (entry.iconUrl && !failed) {
    return (
      <img
        src={entry.iconUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-10 shrink-0 rounded-[10px] bg-secondary object-cover"
      />
    );
  }
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-accent text-primary">
      <Package className="size-5" aria-hidden />
    </span>
  );
}

const AUTO_CHECK_MS = 10 * 60 * 1000;

/** Everything in the plugins/mods folder: on/off, updates, delete, and own .jar files by drag and drop. */
export function InstalledList({
  server,
  onChanged,
  onBrowse,
}: {
  server: ServerDetail;
  onChanged: () => void;
  onBrowse: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<InstalledContent | null>(null);
  const key = contentQuery(server.id).queryKey;
  const { data } = useQuery(contentQuery(server.id));
  // Opening the tab looks for updates by itself (at most every 10 minutes per server and browser tab).
  useEffect(() => {
    const mark = `mh:content-check:${server.id}`;
    try {
      if (Date.now() - Number(sessionStorage.getItem(mark) ?? 0) < AUTO_CHECK_MS) return;
      sessionStorage.setItem(mark, String(Date.now()));
    } catch {
      // No storage (private window): just check.
    }
    check.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once when the tab opens
  }, [server.id]);
  const base = `/api/servers/${server.id}/content`;
  const kind = t(`content.kind.${SOFTWARE[server.software].content === 'mods' ? 'mods' : 'plugins'}`);

  const setList = (list: InstalledContent[]): void => {
    queryClient.setQueryData(key, list);
  };
  const changed = async (): Promise<void> => {
    onChanged();
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: ['market', server.id] });
  };

  const check = useMutation({
    mutationFn: (_quiet: boolean) => api<InstalledContent[]>(`${base}/check-updates`, { method: 'POST' }),
    onSuccess: (list, quiet) => {
      setList(list);
      void queryClient.invalidateQueries({ queryKey: ['content-updates'] });
      const count = list.filter((e) => e.update).length;
      if (!quiet || count)
        toast.success(count ? t('content.updatesFound', { count }) : t('content.allUpToDate'));
    },
    onError: (_err, quiet) => {
      if (!quiet) toast.error(t('content.checkFailed'));
    },
  });
  const updateOne = useMutation({
    mutationFn: (entry: InstalledContent) =>
      api<InstallResult>(`${base}/update`, { method: 'POST', body: { fileName: entry.fileName } }),
    onSuccess: async (_r, entry) => {
      toast.success(t('content.updated', { name: entry.name, version: entry.update?.versionName ?? '' }));
      await changed();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ entry, enabled }: { entry: InstalledContent; enabled: boolean }) =>
      api(`${base}/toggle`, { method: 'POST', body: { fileName: entry.fileName, enabled } }),
    onMutate: ({ entry, enabled }) =>
      queryClient.setQueryData<InstalledContent[]>(key, (prev) =>
        prev?.map((e) => (e.fileName === entry.fileName ? { ...e, enabled } : e)),
      ),
    onSettled: changed,
  });
  const remove = useMutation({
    mutationFn: (entry: InstalledContent) =>
      api(`${base}/delete`, { method: 'POST', body: { fileName: entry.fileName } }),
    onSuccess: async (_r, entry) => {
      toast.success(t('content.removed', { name: entry.name }));
      await changed();
    },
  });

  const uploadJars = async (files: readonly File[]): Promise<void> => {
    const jars = files.filter((f) => f.name.toLowerCase().endsWith('.jar'));
    if (jars.length < files.length) toast.error(t('content.onlyJar'));
    if (!jars.length) return;
    const form = new FormData();
    jars.forEach((f) => form.append('file', f, f.name));
    setProgress(0);
    try {
      const result = await upload<{ uploaded: string[]; content: InstalledContent[] }>(
        `${base}/upload`,
        form,
        (p) => setProgress((p.loaded / Math.max(p.total, 1)) * PERCENT),
      );
      setList(result.content);
      onChanged();
      toast.success(t('content.uploaded', { count: result.uploaded.length }));
    } catch (err) {
      toastError(err);
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const updates = (data ?? []).filter((e) => e.update);

  /** One after another; a failed update shows its own message and does not stop the others. */
  const updateAll = async (): Promise<void> => {
    await updates.reduce(async (previous, entry) => {
      await previous;
      try {
        await updateOne.mutateAsync(entry);
      } catch {
        // Already reported by the mutation's error toast.
      }
    }, Promise.resolve());
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    void uploadJars([...e.dataTransfer.files]);
  };

  const body = (): ReactElement => {
    if (!data) return <Skeleton className="h-64 rounded-[16px]" />;
    if (!data.length) {
      return (
        <EmptyState
          icon={<Package />}
          title={t('content.emptyTitle', { kind })}
          text={t('content.emptyText')}
          action={
            <Button onClick={onBrowse}>
              <Search />
              {t('content.browse')}
            </Button>
          }
        />
      );
    }
    return (
      <Card className="divide-y divide-border overflow-hidden">
        {data.map((entry) => (
          <div
            key={entry.fileName}
            className={cn(
              'flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap',
              !entry.enabled && 'opacity-60',
            )}
          >
            <ContentIcon entry={entry} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <b className="truncate text-sm font-semibold">{entry.name}</b>
                {entry.versionName ? (
                  <span className="text-[13px] text-muted-foreground">{entry.versionName}</span>
                ) : null}
                {entry.source === 'upload' ? (
                  <Tag>{t('content.ownFile')}</Tag>
                ) : (
                  <Tag>{SOURCE_LABELS[entry.source]}</Tag>
                )}
                {entry.enabled ? null : <Pill tone="neutral">{t('content.off')}</Pill>}
              </div>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {entry.dependencyOf ? `${t('content.neededBy', { name: entry.dependencyOf })} · ` : ''}
                {entry.fileName} · {formatBytes(entry.size)}
              </p>
            </div>
            {entry.update ? (
              <Button
                size="sm"
                disabled={updateOne.isPending}
                onClick={() => updateOne.mutate(entry)}
                className="max-sm:order-last"
              >
                <ArrowUpCircle />
                {t('content.updateTo', { version: entry.update.versionName })}
              </Button>
            ) : null}
            <Switch
              checked={entry.enabled}
              aria-label={t('content.enabledFor', { name: entry.name })}
              onCheckedChange={(enabled) => toggle.mutate({ entry, enabled })}
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
                {entry.url ? (
                  <DropdownMenuItem asChild>
                    <a href={entry.url} target="_blank" rel="noreferrer noopener">
                      <ExternalLink />
                      {t('content.projectPage')}
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem destructive onSelect={() => setDeleting(entry)}>
                  <Trash2 />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </Card>
    );
  };

  return (
    <div
      className="relative grid gap-4"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={check.isPending || !data?.length}
          onClick={() => check.mutate(false)}
        >
          <RefreshCw className={cn(check.isPending && 'animate-spin')} />
          {t('content.checkUpdates')}
        </Button>
        {updates.length ? (
          <Button disabled={updateOne.isPending} onClick={() => void updateAll()}>
            <ArrowUpCircle />
            {t('content.updateAll', { count: updates.length })}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          <Upload />
          {t('content.uploadJar')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".jar,application/java-archive"
          multiple
          hidden
          onChange={(e) => void uploadJars([...(e.target.files ?? [])])}
        />
      </div>

      {progress !== null ? <Progress value={progress} /> : null}

      {body()}

      <p className="text-center text-[13px] text-muted-foreground">{t('content.dropHint')}</p>

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[16px] border-2 border-dashed border-primary bg-background/85">
          <div className="grid justify-items-center gap-2 text-center">
            <Upload className="size-8 text-primary" aria-hidden />
            <b>{t('content.dropHere')}</b>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('content.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('content.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </div>
  );
}
