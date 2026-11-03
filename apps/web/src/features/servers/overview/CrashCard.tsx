import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Wrench, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { CrashFixOffer, CrashHelp, CrashInfo } from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { serversQuery } from '../live';

/** Where to look by hand, for crashes the helper cannot repair alone. */
const MANUAL: Readonly<Record<string, (crash: CrashInfo) => { label: string; to: string } | null>> = {
  'version-not-found': () => ({ label: 'crash.openSettings', to: 'version' }),
  'missing-dependency': (c) => ({
    label: 'crash.openMarket',
    to: `content?q=${encodeURIComponent(c.params['dependency'] ?? '')}`,
  }),
  'mod-version-mismatch': () => ({ label: 'crash.openPlugins', to: 'content?view=installed' }),
  'plugin-error': () => ({ label: 'crash.openPlugins', to: 'content?view=installed' }),
  'world-broken': () => ({ label: 'crash.openBackups', to: 'backups' }),
};

export const crashHelpKey = (serverId: string) => ['crash-help', serverId] as const;

/** Runs one repair; shared by the card on the server page and the popup. */
export function useCrashFix(serverId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fix: CrashFixOffer['id']; start: boolean }) =>
      api<{ done: string }>(`/api/servers/${serverId}/crash/fix`, { method: 'POST', body: input }),
    onSuccess: (_r, input) => {
      toast.success(t(input.start ? 'crash.fixedStarting' : 'crash.fixed'));
      void queryClient.invalidateQueries({ queryKey: crashHelpKey(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
    },
  });
}

/** The crash helper: what went wrong in plain words, and buttons that repair it. */
export function CrashCard({
  serverId,
  crash,
  canControl,
}: {
  serverId: string;
  crash: CrashInfo;
  canControl: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [startAfter, setStartAfter] = useState(true);
  const [confirm, setConfirm] = useState<CrashFixOffer | null>(null);
  const { data } = useQuery({
    queryKey: [...crashHelpKey(serverId), crash.at],
    queryFn: () => api<{ help: CrashHelp | null }>(`/api/servers/${serverId}/crash`),
  });
  const fix = useCrashFix(serverId);
  const dismiss = useMutation({
    mutationFn: () => api(`/api/servers/${serverId}/crash/dismiss`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['server', serverId] });
      void queryClient.invalidateQueries({ queryKey: serversQuery.queryKey });
    },
  });
  const known = t(`crash.${crash.ruleId}.title`, { defaultValue: '' }) ? crash.ruleId : 'unknown';
  const manual = MANUAL[known]?.(crash) ?? null;
  const fixes = data?.help?.fixes ?? [];
  const run = (offer: CrashFixOffer): void => {
    if (offer.danger) setConfirm(offer);
    else fix.mutate({ fix: offer.id, start: startAfter });
  };
  return (
    <section
      className="grid gap-4 rounded-[16px] border border-destructive/40 bg-card p-5 shadow-card"
      aria-labelledby="crash-title"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-destructive-soft text-destructive">
          <LifeBuoy className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-destructive">{t('crash.title')}</p>
          <h2 id="crash-title" className="text-lg font-bold leading-tight">
            {t(`crash.${known}.title`, crash.params)}
          </h2>
          <p className="mt-1 text-sm">{t(`crash.${known}.text`, crash.params)}</p>
          <p className="mt-2 text-sm font-semibold">{t(`crash.${known}.fix`, crash.params)}</p>
        </div>
        {canControl ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('crash.dismiss')}
            onClick={() => dismiss.mutate()}
          >
            <X />
          </Button>
        ) : null}
      </div>
      {canControl && fixes.length ? (
        <div className="grid gap-2.5 rounded-[12px] bg-secondary p-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Wrench className="size-4 text-primary" aria-hidden />
            {t('crash.repairTitle')}
          </span>
          <div className="flex flex-wrap gap-2">
            {fixes.map((offer, i) => (
              <Button
                key={offer.id}
                variant={offer.danger ? 'destructive' : i === 0 ? 'default' : 'outline'} // eslint-disable-line ts-patterns/no-nested-ternary -- three button looks: dangerous, first suggestion, the rest
                disabled={fix.isPending}
                onClick={() => run(offer)}
              >
                {t(`crash.fixes.${offer.id}`, offer.params)}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox checked={startAfter} onCheckedChange={(v) => setStartAfter(v === true)} />
            {t('crash.startAfter')}
          </label>
        </div>
      ) : null}
      {manual ? (
        <Button asChild variant="outline" className="justify-self-start">
          <Link to={manual.to}>{t(manual.label)}</Link>
        </Button>
      ) : null}
      {crash.excerpt.length ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {t('crash.excerpt')}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-[10px] bg-console p-3 font-mono text-xs leading-relaxed text-console-foreground">
            {crash.excerpt.join('\n')}
          </pre>
        </details>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={confirm ? t(`crash.fixes.${confirm.id}`, confirm.params) : ''}
        description={confirm ? t(`crash.danger.${confirm.id}`, confirm.params) : ''}
        confirmLabel={confirm ? t(`crash.fixes.${confirm.id}`, confirm.params) : ''}
        onConfirm={() => {
          if (confirm) fix.mutate({ fix: confirm.id, start: startAfter });
          setConfirm(null);
        }}
      />
    </section>
  );
}
