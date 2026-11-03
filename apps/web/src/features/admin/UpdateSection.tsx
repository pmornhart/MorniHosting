import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpCircle,
  CloudOff,
  Sparkles,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { UpdateInfo, UpdateRun } from '@mornihosting/shared';
import { CommandLine } from '@/components/command-line';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { updateQuery } from '@/features/shell/UpdateCard';

const MANUAL_COMMANDS = ['update', 'sudo /opt/mornihosting/update.sh'] as const;
const STEPS = ['pull', 'build', 'restart'] as const;
/** The big symbol at the top: all fine, something new, or GitHub could not be asked. */
const STATUS_LOOKS = {
  ok: { icon: CircleCheck, box: 'from-emerald-400 to-emerald-700' },
  new: { icon: Sparkles, box: 'from-amber-300 to-orange-600' },
  failed: { icon: CloudOff, box: 'from-slate-400 to-slate-700' },
} as const;
/** While an update runs the card asks every few seconds, also while the panel restarts. */
const POLL_MS = 3000;
const RELOAD_DELAY_MS = 1500;
const IS_DEMO = import.meta.env.MODE === 'demo';

/** How a step looks: done, running now, failed there, or still to come. */
const LOOKS = {
  done: { icon: CircleCheck, item: '', mark: 'text-success' },
  active: { icon: LoaderCircle, item: 'border-primary bg-accent', mark: 'animate-spin text-primary' },
  failed: { icon: CircleX, item: 'border-destructive/50 bg-destructive-soft', mark: 'text-destructive' },
  waiting: { icon: LoaderCircle, item: 'text-muted-foreground', mark: 'opacity-40' },
} as const;

function Steps({ run }: { run: UpdateRun }): ReactElement {
  const { t } = useTranslation();
  const index = run.step ? STEPS.indexOf(run.step) : -1;
  return (
    <ol className="grid gap-2 sm:grid-cols-3">
      {STEPS.map((step, i) => {
        const states = {
          failed: i === index && run.state === 'failed',
          done: i < index || run.state === 'done',
          active: i === index && run.state === 'running',
        };
        const look = LOOKS[(['failed', 'done', 'active'] as const).find((k) => states[k]) ?? 'waiting'];
        return (
          <li
            key={step}
            className={cn(
              'flex items-center gap-2 rounded-[10px] border border-border px-3 py-2 text-sm',
              look.item,
            )}
          >
            <look.icon className={cn('size-4 shrink-0', look.mark)} aria-hidden />
            <span>
              {i + 1}. {t(`update.steps.${step}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Log({ lines }: { lines: readonly string[] }): ReactElement | null {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);
  if (!lines.length) return null;
  return (
    <pre
      ref={box}
      className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-secondary px-3 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground"
    >
      {lines.join('\n')}
    </pre>
  );
}

/** What is going on right now: asked for, running with its steps, stuck, failed or just finished. */
function RunState({ run, restarting }: { run: UpdateRun; restarting: boolean }): ReactElement {
  const { t } = useTranslation();
  if (run.state === 'done') {
    return (
      <p className="flex items-center gap-2 rounded-[12px] bg-success-soft px-3 py-2.5 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        {t('update.done', { when: formatRelative(run.at) })}
      </p>
    );
  }
  if (run.state === 'stuck') {
    return (
      <div className="grid gap-2 rounded-[12px] bg-warning-soft px-3 py-2.5 text-sm">
        <p className="flex items-start gap-2 font-semibold">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {t('update.stuck')}
        </p>
        <p className="text-muted-foreground">{t('update.stuckText')}</p>
        {MANUAL_COMMANDS.map((cmd) => (
          <CommandLine key={cmd} text={cmd} className="bg-background/60" />
        ))}
      </div>
    );
  }
  const failed = run.state === 'failed';
  return (
    <div className="grid gap-3">
      {failed ? (
        <p className="flex items-start gap-2 rounded-[12px] bg-destructive-soft px-3 py-2.5 text-sm">
          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {t('update.failed')}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm font-semibold">
          <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />
          {restarting ? t('update.restarting') : t(`update.state.${run.state}`)}
        </p>
      )}
      <Steps run={run} />
      <Log lines={run.log} />
    </div>
  );
}

/** Updates: what is installed, what is new on GitHub, the update button and the live progress. */
export function UpdateSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const startedOn = useRef<string | null>(null);
  const { data, isError } = useQuery({
    ...updateQuery,
    retry: false,
    refetchInterval: (query) => (query.state.data?.updating || startedOn.current !== null ? POLL_MS : false),
  });
  const run = useMutation({
    mutationFn: () => api<UpdateInfo>('/api/system/update', { method: 'POST' }),
    onSuccess: (info) => {
      startedOn.current = info.current;
      toast.success(t('update.started'));
      queryClient.setQueryData(updateQuery.queryKey, info);
    },
  });
  const check = useMutation({
    mutationFn: () => api<UpdateInfo>('/api/system/update/check', { method: 'POST' }),
    onSuccess: (info) => queryClient.setQueryData(updateQuery.queryKey, info),
  });

  // The panel came back with another version: load the new one.
  const current = data?.current;
  useEffect(() => {
    if (startedOn.current === null || !current || current === startedOn.current) return;
    startedOn.current = null;
    toast.success(t('update.finished', { version: current }));
    // The demo lives in this one page: reloading would start it over, so it only refreshes the data.
    const timer = window.setTimeout(
      () => (IS_DEMO ? void queryClient.invalidateQueries() : window.location.reload()),
      RELOAD_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [current, t, queryClient]);

  if (!data) return <Skeleton id="update" className="h-40 rounded-[16px]" />;
  const restarting = isError && startedOn.current !== null;
  const shownRun: UpdateRun | null =
    data.run ?? (startedOn.current ? { state: 'requested', step: null, at: '', log: [] } : null);
  const retry = shownRun?.state === 'failed' || shownRun?.state === 'stuck';
  const flags = { failed: data.checkFailed, new: data.available } as const;
  const status = (['failed', 'new'] as const).find((key) => flags[key]) ?? 'ok';
  const look = STATUS_LOOKS[status];

  return (
    <Card fold="update" foldOpen id="update" className="grid min-w-0 scroll-mt-4 gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-4">
        <span
          className={cn(
            'grid size-14 shrink-0 place-items-center rounded-[16px] bg-gradient-to-br text-white shadow-lg ring-1 ring-white/15',
            look.box,
          )}
        >
          <look.icon className="size-7" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            {t('update.title')}
          </p>
          <h2 className="text-xl font-extrabold tracking-[-0.01em]">
            {status === 'new' && data.behind
              ? t('update.behind', { count: data.behind })
              : t(`update.headline.${status}`)}
          </h2>
          <p className="text-sm text-muted-foreground">
            {data.checkedAt
              ? t('update.checkedWhen', { when: formatRelative(data.checkedAt) })
              : t('update.intro')}
          </p>
        </div>
        <Button variant="secondary" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
          <RefreshCw className={cn(check.isPending && 'animate-spin')} />
          {t('update.checkNow')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5">
          <span className="text-muted-foreground">{t('update.installed')}</span>
          <b className="font-mono">{data.current}</b>
        </span>
        {data.available && data.latest ? (
          <>
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/50 bg-accent px-3 py-1.5">
              <span className="text-muted-foreground">{t('update.newest')}</span>
              <b className="font-mono">{data.latest}</b>
              {data.latestDate ? (
                <span className="text-xs text-muted-foreground">{formatDateTime(data.latestDate)}</span>
              ) : null}
            </span>
          </>
        ) : null}
      </div>

      {shownRun ? <RunState run={shownRun} restarting={restarting} /> : null}

      {data.available && data.changes.length ? (
        <div className="grid gap-2">
          <b className="text-sm font-semibold">{t('update.whatsNew')}</b>
          <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-[12px] bg-secondary p-2">
            {data.changes.map((c) => (
              <li key={c.sha} className="flex min-w-0 items-start gap-2 rounded-[8px] px-2 py-1.5 text-sm">
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">{c.title}</span>
                {c.date ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(c.date)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.canSelfUpdate && (data.available || retry) && !data.updating ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={run.isPending} onClick={() => run.mutate()}>
            <ArrowUpCircle />
            {retry ? t('update.retry') : t('update.now')}
          </Button>
          <span className="text-[13px] text-muted-foreground">{t('update.text')}</span>
        </div>
      ) : null}

      {data.canSelfUpdate ? null : (
        <div className="grid gap-2 text-sm">
          <span className="text-muted-foreground">{t('update.manual')}</span>
          {MANUAL_COMMANDS.map((cmd) => (
            <CommandLine key={cmd} text={cmd} />
          ))}
        </div>
      )}

      {data.url ? (
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 justify-self-start text-sm font-semibold text-primary hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t('update.allChanges')}
        </a>
      ) : null}
    </Card>
  );
}
