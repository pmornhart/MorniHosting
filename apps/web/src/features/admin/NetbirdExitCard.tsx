import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, EyeOff, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { NetbirdExitStatus } from '@mornihosting/shared';
import { CommandLine } from '@/components/command-line';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import i18n from '@/i18n';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

const exitQueryKey = ['netbird-exit'] as const;
/** NetBird needs a few seconds to switch the machine over; until then the check repeats. */
const RECHECK_MS = 8000;

/** The server's error code as friendly text (like errorText, for errors inside a status). */
const translatedError = (error: NetbirdExitStatus['error']): string | null => {
  if (!error) return null;
  const key = `errors.${error.code}`;
  return i18n.exists(key) ? i18n.t(key, error.params) : i18n.t('errors.generic');
};

/**
 * "Hausanschluss verstecken": all internet traffic of the panel's machine goes out through another NetBird
 * machine (normally the NetBird server). Visitors come in through NetBird anyway, so the home connection's IP
 * appears nowhere.
 */
export function NetbirdExitCard({ apiUrl }: { apiUrl: string }): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: exitQueryKey,
    queryFn: () => api<NetbirdExitStatus>('/api/netbird/exit'),
    refetchInterval: (query) =>
      query.state.data?.enabled && query.state.data.hidden !== true ? RECHECK_MS : false,
  });
  const [picked, setPicked] = useState('');
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; exitPeerId?: string }) =>
      api<NetbirdExitStatus>('/api/netbird/exit', { method: 'PUT', body }),
    onSuccess: (next) => queryClient.setQueryData(exitQueryKey, next),
  });
  const check = useMutation({
    mutationFn: () => api<NetbirdExitStatus>('/api/netbird/exit'),
    onSuccess: (next) => queryClient.setQueryData(exitQueryKey, next),
  });
  const candidates = data?.candidates ?? [];
  const suggested = candidates.find((c) => c.connected && c.publicIp) ?? candidates[0];
  const exitPeerId = picked || suggested?.id || '';
  const management = new URL(apiUrl).origin;
  const error = translatedError(data?.error ?? null);

  return (
    <div className="grid gap-3 rounded-[12px] border border-border p-3 sm:p-4">
      <b className="flex items-center gap-2 text-sm font-semibold">
        <EyeOff className="size-4 text-primary" aria-hidden />
        {t('netbirdExit.title')}
      </b>
      <p className="text-[13px] text-muted-foreground">{t('netbirdExit.text')}</p>

      {data?.enabled ? (
        <div className="grid gap-2.5">
          {data.hidden === true ? (
            <p className="flex items-start gap-2 rounded-[10px] bg-success-soft px-3 py-2 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>
                {t('netbirdExit.hidden', { name: data.exitPeerName ?? '…', ip: data.exitIp ?? '…' })}
              </span>
            </p>
          ) : null}
          {data.hidden === false ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[10px] bg-destructive-soft px-3 py-2 text-sm"
            >
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>{t('netbirdExit.notYet', { name: data.exitPeerName ?? '…' })}</span>
            </p>
          ) : null}
          {data.hidden === null && !error ? (
            <p className="text-sm text-muted-foreground">{t('netbirdExit.unknown')}</p>
          ) : null}
          {data.leaks.length ? (
            <div role="alert" className="grid gap-1 rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              <b className="flex items-center gap-2">
                <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden />
                {t('netbirdExit.leaksTitle')}
              </b>
              <span className="break-all font-mono text-xs">{data.leaks.join(', ')}</span>
              <span>{t('netbirdExit.leaksTip')}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
              <RefreshCw className={check.isPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
              {t('netbirdExit.check')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => save.mutate({ enabled: false })}
            >
              {t('netbirdExit.off')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {candidates.length ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Field id="nb-exit" label={t('netbirdExit.machine')} hint={t('netbirdExit.machineHint')}>
                <Select value={exitPeerId} onValueChange={setPicked}>
                  <SelectTrigger id="nb-exit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.publicIp ? ` · ${c.publicIp}` : ''}
                        {c.connected ? '' : ` · ${t('netbirdExit.offline')}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button
                type="button"
                disabled={!exitPeerId || save.isPending}
                onClick={() => save.mutate({ enabled: true, exitPeerId })}
              >
                <EyeOff className="size-4" aria-hidden />
                {t('netbirdExit.on')}
              </Button>
            </div>
          ) : null}
          <details className="rounded-[10px] bg-secondary px-3 py-2 text-[13px]" open={!candidates.length}>
            <summary className="cursor-pointer font-semibold">{t('netbirdExit.agentTitle')}</summary>
            <div className="mt-2 grid min-w-0 gap-2">
              <span>{t('netbirdExit.agentText')}</span>
              <CommandLine text="curl -fsSL https://pkgs.netbird.io/install.sh | sh" />
              <CommandLine text={`netbird up --management-url ${management} --setup-key DEIN-SETUP-KEY`} />
              <span className="text-muted-foreground">{t('netbirdExit.agentHint')}</span>
            </div>
          </details>
        </div>
      )}

      {data?.dnsAutomation ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {t('netbirdExit.dnsAutomation')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(save.error)}
        </p>
      ) : null}
    </div>
  );
}
