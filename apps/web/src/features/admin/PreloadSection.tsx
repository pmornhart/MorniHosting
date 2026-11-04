import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Download,
  DownloadCloud,
  Loader2,
  RefreshCcw,
  RotateCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SOFTWARE, isGameId, type PreloadItem, type PreloadState } from '@mornihosting/shared';
import { DownloadInfo } from '@/components/download-info';
import { SoftwareLogo } from '@/components/software-logo';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/misc';
import { Pill, type PillTone } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

/** While something loads the list refreshes quickly, otherwise now and then. */
const FAST_REFRESH_MS = 2000;
const SLOW_REFRESH_MS = 30_000;
const TONES: Readonly<Record<PreloadState, PillTone>> = {
  none: 'neutral',
  queued: 'accent',
  loading: 'warn',
  ready: 'ok',
  failed: 'bad',
};
const STATE_ICONS: Readonly<Record<PreloadState, typeof Download>> = {
  none: Download,
  queued: Clock,
  loading: Loader2,
  ready: CheckCircle2,
  failed: XCircle,
};
const QUERY_KEY = ['preload'] as const;

function PreloadCard({ item }: { item: PreloadItem }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const start = useMutation({
    mutationFn: () => api(`/api/preload/${item.software}`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/preload/${item.software}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success(t('preload.removed'));
      await refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const Icon = STATE_ICONS[item.state];
  const label = SOFTWARE[item.software].label;
  const family = isGameId(item.software) ? null : 'Minecraft';
  return (
    <Card className="mh-lift grid min-w-0 content-start gap-3 p-4">
      <div className="flex items-center gap-3">
        <SoftwareLogo id={item.software} className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate text-[15px]">{label}</CardTitle>
          <p className="truncate text-xs text-muted-foreground">
            {[family, item.version, item.sizeGb !== null ? t('preload.size', { gb: item.sizeGb }) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {item.newVersion ? (
          <Pill tone="accent" className="shrink-0">
            <ArrowUpCircle className="size-3.5" aria-hidden />
            {t('preload.newVersion', { version: item.newVersion })}
          </Pill>
        ) : null}
        <Pill tone={TONES[item.state]} className="shrink-0">
          <Icon className={item.state === 'loading' ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          {t(`preload.states.${item.state}`)}
        </Pill>
      </div>
      <p className="text-xs text-muted-foreground">{t(`preload.modes.${item.mode}`)}</p>
      {item.state === 'loading' ? (
        <div className="grid gap-1.5">
          <Progress value={item.progress ?? 0} className="mh-shimmer" />
          <DownloadInfo download={item.download ?? null} />
        </div>
      ) : null}
      {item.state === 'failed' && item.error ? (
        <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-xs [overflow-wrap:anywhere] text-destructive">
          {item.error}
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap gap-2">
        {item.state === 'ready' ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => start.mutate()} disabled={start.isPending}>
              <RotateCw aria-hidden />
              {t('preload.refresh')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
              <Trash2 aria-hidden />
              {t('preload.remove')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => start.mutate()}
            disabled={item.state === 'loading' || item.state === 'queued' || start.isPending}
          >
            <Download aria-hidden />
            {item.state === 'failed' ? t('preload.retry') : t('preload.download')}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Admin area → "Spiele vorladen": download games before the first server, so ordering is quick. */
export function PreloadSection(): ReactElement {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<PreloadItem[]>('/api/preload'),
    refetchInterval: (query) =>
      query.state.data?.some((i) => i.state === 'loading' || i.state === 'queued')
        ? FAST_REFRESH_MS
        : SLOW_REFRESH_MS,
  });
  const queryClient = useQueryClient();
  const all = useMutation({
    mutationFn: () => api('/api/preload', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (err) => toast.error(errorText(err)),
  });
  const update = useMutation({
    mutationFn: () => api('/api/preload/update-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (err) => toast.error(errorText(err)),
  });
  const outdated = data?.filter((i) => i.newVersion !== null).length ?? 0;
  const missing = data?.filter((i) => i.state === 'none' || i.state === 'failed').length ?? 0;
  const busy = data?.filter((i) => i.state === 'loading' || i.state === 'queued').length ?? 0;
  const allLabel = (): string => {
    if (missing) return t('preload.all', { count: missing });
    if (busy) return t('preload.allBusy', { count: busy });
    return t('preload.allDone');
  };
  const checkedAt = data?.find((i) => i.checkedAt)?.checkedAt ?? null;
  return (
    <Card className="grid gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
          <RefreshCcw className="size-4 shrink-0 text-primary" aria-hidden />
          {checkedAt
            ? t('preload.autoChecked', {
                time: new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              })
            : t('preload.auto')}
        </p>
        {outdated ? (
          <Button variant="secondary" onClick={() => update.mutate()} disabled={update.isPending}>
            <RotateCw aria-hidden />
            {t('preload.updateAll', { count: outdated })}
          </Button>
        ) : null}
        <Button onClick={() => all.mutate()} disabled={!missing || all.isPending}>
          <DownloadCloud aria-hidden />
          {allLabel()}
        </Button>
      </div>
      {data ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((item) => (
            <PreloadCard key={item.software} item={item} />
          ))}
        </div>
      ) : (
        <Skeleton className="h-40" />
      )}
    </Card>
  );
}
