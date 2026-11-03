import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleHelp,
  CircleMinus,
  Link2,
  RefreshCw,
  Server,
  Unplug,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { StalwartCheck, StalwartConnectResult, StalwartStep, StalwartView } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import i18n from '@/i18n';
import { errorText } from '@/lib/query';

const stalwartQuery = { queryKey: ['stalwart'], queryFn: () => api<StalwartView>('/api/stalwart') } as const;

const STEP_ICON: Readonly<Record<StalwartStep['state'], ReactElement>> = {
  ok: <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />,
  failed: <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />,
  skipped: <CircleMinus className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
};

const checkIcon = (ok: boolean | null): ReactElement => {
  if (ok === null) return <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return ok ? STEP_ICON.ok : STEP_ICON.failed;
};

/** "stalwart_login: HTTP 401" → the friendly text for stalwart_login, plus what the server said. */
const stepDetail = (detail: string): { text: string; raw: string } => {
  const [code = '', ...rest] = detail.split(': ');
  const key = `errors.${code}`;
  if (i18n.exists(key))
    return { text: i18n.t(key, { host: '', message: rest.join(': ') }), raw: rest.join(': ') };
  if (i18n.exists(`stalwart.detail.${detail}`)) return { text: i18n.t(`stalwart.detail.${detail}`), raw: '' };
  return { text: '', raw: detail };
};

function Steps(props: { readonly steps: readonly StalwartStep[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <ol className="grid gap-1.5 rounded-[12px] border border-border p-3" aria-live="polite">
      {props.steps.map((step) => {
        const detail = stepDetail(step.detail);
        return (
          <li key={step.key} className="grid gap-0.5 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {STEP_ICON[step.state]}
              <span className={step.state === 'skipped' ? 'text-muted-foreground' : 'font-medium'}>
                {t(`stalwart.steps.${step.key}`)}
              </span>
            </span>
            {step.state === 'ok' && detail.raw ? (
              <span className="ml-6 break-all font-mono text-xs text-muted-foreground">{detail.raw}</span>
            ) : null}
            {step.state !== 'ok' && (detail.text || detail.raw) ? (
              <span className="ml-6 grid gap-0.5">
                {detail.text ? <span>{detail.text}</span> : null}
                {detail.raw ? (
                  <span className="break-words font-mono text-xs text-muted-foreground">{detail.raw}</span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Checks(props: { readonly checks: readonly StalwartCheck[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <ul className="grid gap-2">
      {props.checks.map((check) => (
        <li key={check.key} className="flex min-w-0 gap-3 rounded-[12px] bg-secondary px-3 py-2.5">
          {checkIcon(check.ok)}
          <div className="grid min-w-0 gap-0.5 text-sm">
            <b className="font-semibold">{t(`stalwart.checks.${check.key}.title`)}</b>
            <span className="break-words font-mono text-xs text-muted-foreground">
              {t('stalwart.found')}: {check.found || '—'}
            </span>
            {check.ok === true ? null : (
              <>
                <span className="break-words font-mono text-xs text-muted-foreground">
                  {t('stalwart.expected')}: {check.expected}
                </span>
                <span className="text-[13px]">{t(`stalwart.checks.${check.key}.tip`)}</span>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Admin → E-Mail: connect a Stalwart mail server with its admin login. The panel creates domain and sender
 * there, sets up its own mail sending, hands the DNS access over (INWX/Cloudflare) and checks the records.
 */
export function StalwartCard(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(stalwartQuery);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [sender, setSender] = useState('noreply');
  const [publicIp, setPublicIp] = useState('');
  const [publishDns, setPublishDns] = useState(true);

  useEffect(() => {
    if (!data) return;
    setUrl(data.url);
    setUsername(data.username);
    setDomain(data.domain);
    setSender(data.sender);
    setPublicIp(data.publicIp);
    setPublishDns(data.connected ? data.dnsAutomatic : true);
  }, [data]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['stalwart'] });
    void queryClient.invalidateQueries({ queryKey: ['mail'] });
    void queryClient.invalidateQueries({ queryKey: ['mail-outbox'] });
  };
  const connect = useMutation({
    mutationFn: () =>
      api<StalwartConnectResult>('/api/stalwart/connect', {
        method: 'POST',
        body: {
          url: url.trim(),
          username: username.trim(),
          password,
          domain: domain.trim(),
          sender: sender.trim(),
          publicIp: publicIp.trim(),
          publishDns,
        },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['stalwart'], result.view);
      if (result.ok) {
        setPassword('');
        toast.success(t('stalwart.done'));
      }
      refresh();
    },
  });
  const check = useMutation({
    mutationFn: () => api<StalwartView>('/api/stalwart/check', { method: 'POST' }),
    onSuccess: (view) => queryClient.setQueryData(['stalwart'], view),
  });
  const disconnect = useMutation({
    mutationFn: () => api('/api/stalwart', { method: 'DELETE' }),
    onSuccess: () => {
      connect.reset();
      refresh();
    },
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    connect.mutate();
  };
  const view = connect.data?.view ?? data;
  const mailDomain = domain.trim() || data?.suggestedDomain || '…';
  const hasChecks = (view?.checks.length ?? 0) > 0;

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Server className="size-5 shrink-0 text-primary" aria-hidden />
            {t('stalwart.title')}
          </CardTitle>
          <CardDescription>{t('stalwart.text')}</CardDescription>
        </div>
        {data?.connected ? <Pill tone="ok">{t('stalwart.connected')}</Pill> : null}
      </div>

      <form onSubmit={submit} className="grid gap-3">
        <Field id="st-url" label={t('stalwart.url')} hint={t('stalwart.urlHint')}>
          <Input
            id="st-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mail.mornihosting.de"
            inputMode="url"
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="st-username" label={t('stalwart.username')}>
            <Input
              id="st-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Field
            id="st-password"
            label={t('stalwart.password')}
            hint={data?.connected ? t('stalwart.passwordKept') : undefined}
          >
            <Input
              type="password"
              id="st-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required={!data?.connected}
            />
          </Field>
          <Field id="st-domain" label={t('stalwart.domain')} hint={t('stalwart.domainHint')}>
            <Input
              id="st-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={data?.suggestedDomain || 'mornihosting.de'}
            />
          </Field>
          <Field
            id="st-sender"
            label={t('stalwart.sender')}
            hint={t('stalwart.senderHint', { address: `${sender || 'noreply'}@${mailDomain}` })}
          >
            <Input id="st-sender" value={sender} onChange={(e) => setSender(e.target.value)} />
          </Field>
          <Field id="st-publicIp" label={t('stalwart.publicIp')} hint={t('stalwart.publicIpHint')}>
            <Input
              id="st-publicIp"
              value={publicIp}
              onChange={(e) => setPublicIp(e.target.value)}
              placeholder="203.0.113.10"
              inputMode="decimal"
            />
          </Field>
        </div>
        <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
          <Switch checked={publishDns} onCheckedChange={setPublishDns} className="mt-0.5" />
          <span>
            <b className="block text-sm font-semibold">{t('stalwart.publishDns')}</b>
            <span className="text-[13px] text-muted-foreground">
              {data?.dnsProvider
                ? t('stalwart.publishDnsHint', { provider: data.dnsProvider.toUpperCase() })
                : t('stalwart.publishDnsNone')}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={connect.isPending}>
            <Link2 className="size-4" aria-hidden />
            {connect.isPending ? t('stalwart.connecting') : t('stalwart.connect')}
          </Button>
          {data?.connected ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                <RefreshCw className={check.isPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
                {t('stalwart.check')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                <Unplug className="size-4" aria-hidden />
                {t('stalwart.disconnect')}
              </Button>
            </>
          ) : null}
        </div>
      </form>

      {connect.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(connect.error)}
        </p>
      ) : null}
      {connect.data ? <Steps steps={connect.data.steps} /> : null}

      {hasChecks && view ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">
            {t('stalwart.checksTitle', { host: view.hostname, domain: view.domain })}
          </h3>
          <Checks checks={view.checks} />
        </div>
      ) : null}

      {view && view.records.length > 0 ? (
        <details className="rounded-[12px] border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            {view.dnsAutomatic ? t('stalwart.recordsAuto') : t('stalwart.recordsManual')}
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('stalwart.recordName')}</th>
                  <th className="py-1 pr-3 font-medium">{t('stalwart.recordType')}</th>
                  <th className="py-1 font-medium">{t('stalwart.recordValue')}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {view.records.map((r) => (
                  <tr key={`${r.name}-${r.type}-${r.value}`} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3 break-all">{r.name}</td>
                    <td className="py-1.5 pr-3">{r.type}</td>
                    <td className="py-1.5 break-all">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}
