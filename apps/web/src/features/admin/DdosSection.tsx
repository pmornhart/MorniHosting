import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleX,
  Clock,
  Gauge,
  LoaderCircle,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DDOS_RATE_LIMIT_DEFAULT,
  DDOS_RATE_LIMIT_MAX,
  DDOS_RATE_LIMIT_MIN,
  DDOS_RATE_LIMIT_OFF,
  type DdosState,
  type DdosStatus,
  type DdosUpdate,
} from '@mornihosting/shared';
import { CommandLine } from '@/components/command-line';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/misc';
import { Pill, type PillTone } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatCompact, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

export const ddosQuery = { queryKey: ['ddos'], queryFn: () => api<DdosStatus>('/api/ddos') } as const;

/** While the host has not answered, ask again every few seconds; otherwise once a minute (counters). */
const POLL_WAITING_MS = 3000;
const POLL_MS = 60_000;
const INSTALL_COMMANDS = ['update', 'sudo /opt/mornihosting/scripts/ddos-guard.sh install'] as const;
const DROPPED_KEYS = ['tcpRate', 'tcpConnections', 'udpRate', 'invalid'] as const;
const PROVIDERS = ['tcpshield', 'cloudflare', 'netbird'] as const;

/** The big symbol at the top and the pill next to it, for each state. */
const LOOKS: Readonly<Record<DdosState, { icon: LucideIcon; box: string; tone: PillTone }>> = {
  active: { icon: ShieldCheck, box: 'from-emerald-400 to-emerald-700', tone: 'ok' },
  off: { icon: ShieldOff, box: 'from-slate-400 to-slate-700', tone: 'neutral' },
  waiting: { icon: LoaderCircle, box: 'from-sky-400 to-sky-700', tone: 'accent' },
  stuck: { icon: ShieldAlert, box: 'from-amber-300 to-orange-600', tone: 'warn' },
  failed: { icon: ShieldAlert, box: 'from-rose-400 to-rose-700', tone: 'bad' },
  no_host: { icon: ShieldAlert, box: 'from-amber-300 to-orange-600', tone: 'warn' },
};

function Notice({ tone, title, children }: { tone: 'warn' | 'bad'; title: string; children?: ReactElement }) {
  const Icon = tone === 'bad' ? CircleX : TriangleAlert;
  return (
    <div
      className={cn(
        'grid gap-2 rounded-[12px] px-3 py-2.5 text-sm',
        tone === 'bad' ? 'bg-destructive-soft' : 'bg-warning-soft',
      )}
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icon
          className={cn('mt-0.5 size-4 shrink-0', tone === 'bad' ? 'text-destructive' : 'text-warning')}
        />
        {title}
      </p>
      {children}
    </div>
  );
}

/** What the host script reported: dropped packets, ports and limits in plain words. */
function HostDetails({ data }: { data: DdosStatus }): ReactElement | null {
  const { t } = useTranslation();
  const host = data.host;
  if (!host) return null;
  return (
    <div className="grid gap-3">
      {host.active ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DROPPED_KEYS.map((key) => (
            <div key={key} className="grid gap-0.5 rounded-[12px] border border-border bg-secondary/60 p-3">
              <b className="text-xl font-extrabold tabular-nums">{formatCompact(host.dropped[key])}</b>
              <span className="text-[12px] leading-tight text-muted-foreground">
                {t(`ddos.dropped.${key}`)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" aria-hidden />
          {t('ddos.checked', { when: formatRelative(host.at) })}
        </span>
        <span>{host.ipv6 ? t('ddos.families.both') : t('ddos.families.v4')}</span>
      </p>
      {host.active && !host.docker ? <Notice tone="warn" title={t('ddos.noDocker')} /> : null}
      {host.active && !host.sysctl ? <Notice tone="warn" title={t('ddos.noSysctl')} /> : null}
      <details className="rounded-[12px] border border-border p-3 text-sm">
        <summary className="cursor-pointer font-semibold">{t('ddos.limitsTitle')}</summary>
        <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-muted-foreground">
          <li>
            {t('ddos.limits.tcpNew', { count: host.limits.tcpNewPerMinute, burst: host.limits.tcpBurst })}
          </li>
          <li>{t('ddos.limits.tcpConnections', { count: host.limits.tcpConnections })}</li>
          <li>{t('ddos.limits.udp', { count: host.limits.udpPacketsPerSecond })}</li>
          <li>{t('ddos.limits.invalid')}</li>
          <li>{t('ddos.limits.trusted')}</li>
        </ul>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {host.tcpPorts.map((p) => (
            <span key={`tcp-${p}`} className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[12px]">
              TCP {p.replace(':', '–')}
            </span>
          ))}
          {host.udpPorts.map((p) => (
            <span key={`udp-${p}`} className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[12px]">
              UDP {p.replace(':', '–')}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground">{t('ddos.limitsChange')}</p>
        <CommandLine text="sudo nano /etc/mornihosting/ddos.conf" className="mt-2" />
      </details>
    </div>
  );
}

/** Minecraft's own spam limit (rate-limit in server.properties), set before each start of a Java server. */
function RateLimitCard({
  data,
  onSave,
  saving,
}: {
  data: DdosStatus;
  onSave: (u: DdosUpdate) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  const [value, setValue] = useState(String(DDOS_RATE_LIMIT_DEFAULT));
  useEffect(() => {
    const limit = data.rateLimit;
    setOn(limit !== null && limit !== DDOS_RATE_LIMIT_OFF);
    if (limit) setValue(String(limit));
  }, [data.rateLimit]);
  const number = Number(value);
  const valid = Number.isInteger(number) && number >= DDOS_RATE_LIMIT_MIN && number <= DDOS_RATE_LIMIT_MAX;
  const save = (): void => onSave({ rateLimit: on ? number : DDOS_RATE_LIMIT_OFF });

  return (
    <Card fold="ddos-main" foldOpen className="grid min-w-0 gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Gauge className="size-5 text-primary" aria-hidden />
          {t('ddos.rateTitle')}
          {data.rateLimit ? (
            <Pill tone="ok">{t('ddos.ratePill', { count: data.rateLimit })}</Pill>
          ) : (
            <Pill>{t('ddos.off')}</Pill>
          )}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('ddos.rateText')}</CardDescription>
      <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
        <Switch checked={on} onCheckedChange={setOn} className="mt-0.5" />
        <span>
          <b className="block text-sm font-semibold">{t('ddos.rateSwitch')}</b>
          <span className="text-[13px] text-muted-foreground">{t('ddos.rateHint')}</span>
        </span>
      </label>
      {on ? (
        <Field
          id="ddos-rate"
          label={t('ddos.rateValue')}
          hint={t('ddos.rateValueHint', { min: DDOS_RATE_LIMIT_MIN, max: DDOS_RATE_LIMIT_MAX })}
        >
          <Input
            id="ddos-rate"
            type="number"
            inputMode="numeric"
            min={DDOS_RATE_LIMIT_MIN}
            max={DDOS_RATE_LIMIT_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="max-w-40"
          />
        </Field>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={saving || (on && !valid)} onClick={save}>
          <Save />
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
}

/** Admin tab "DDoS protection": the host firewall switch, its state, honest limits and the spam limit. */
export function DdosSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    ...ddosQuery,
    refetchInterval: (query) => (query.state.data?.state === 'waiting' ? POLL_WAITING_MS : POLL_MS),
  });
  const save = useMutation({
    mutationFn: (body: DdosUpdate) => api<DdosStatus>('/api/ddos', { method: 'PUT', body }),
    onSuccess: (result, body) => {
      queryClient.setQueryData(ddosQuery.queryKey, result);
      if (body.rateLimit !== undefined) toast.success(t('common.saved'));
    },
  });

  if (!data) return <Skeleton className="h-64 rounded-[16px]" />;
  const look = LOOKS[data.state];
  const headline = data.state === 'waiting' ? (data.enabled ? 'switchingOn' : 'switchingOff') : data.state;

  return (
    <>
      <Card fold="ddos-status" className="grid min-w-0 gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'grid size-14 shrink-0 place-items-center rounded-[16px] bg-gradient-to-br text-white shadow-lg ring-1 ring-white/15',
              look.box,
            )}
          >
            <look.icon className={cn('size-7', data.state === 'waiting' && 'animate-spin')} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {t('ddos.title')}
              <Pill tone={look.tone} className="normal-case tracking-normal">
                {t(`ddos.state.${data.state}`)}
              </Pill>
            </p>
            <h2 className="text-xl font-extrabold tracking-[-0.01em]">{t(`ddos.headline.${headline}`)}</h2>
          </div>
        </div>
        <p className="-mt-1 text-sm text-muted-foreground">{t(`ddos.stateText.${data.state}`)}</p>

        <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
          <Switch
            checked={data.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => save.mutate({ enabled })}
            className="mt-0.5"
          />
          <span>
            <b className="block text-sm font-semibold">{t('ddos.switch')}</b>
            <span className="text-[13px] text-muted-foreground">{t('ddos.switchHint')}</span>
          </span>
        </label>

        {data.state === 'no_host' || data.state === 'stuck' ? (
          <Notice tone="warn" title={t(data.state === 'no_host' ? 'ddos.installTitle' : 'ddos.stuckTitle')}>
            <div className="grid gap-2">
              <p className="text-muted-foreground">{t('ddos.installText')}</p>
              {INSTALL_COMMANDS.map((cmd) => (
                <CommandLine key={cmd} text={cmd} className="bg-background/60" />
              ))}
            </div>
          </Notice>
        ) : null}
        {data.state === 'failed' ? (
          <Notice tone="bad" title={t(`ddos.error.${data.host?.error ?? 'rules_failed'}`)}>
            <p className="text-muted-foreground">{t('ddos.errorHint')}</p>
          </Notice>
        ) : null}

        <HostDetails data={data} />
      </Card>

      <Card fold="ddos-more" className="grid min-w-0 gap-3 p-5 sm:p-6">
        <CardHeader className="mb-0">
          <CardTitle>{t('ddos.honestTitle')}</CardTitle>
        </CardHeader>
        <CardDescription>{t('ddos.honestText')}</CardDescription>
        <ul className="grid gap-2 text-sm">
          {PROVIDERS.map((key) => (
            <li key={key} className="rounded-[12px] border border-border p-3">
              <b className="block font-semibold">{t(`ddos.providers.${key}.name`)}</b>
              <span className="text-[13px] text-muted-foreground">{t(`ddos.providers.${key}.text`)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <RateLimitCard data={data} saving={save.isPending} onSave={(body) => save.mutate(body)} />
    </>
  );
}
