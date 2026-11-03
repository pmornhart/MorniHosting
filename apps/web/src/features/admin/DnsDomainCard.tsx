import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Lock, PlugZap, Save, Unplug } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DNS_PROVIDERS,
  type DnsProvider,
  type DnsStatus,
  type DnsZoneOption,
  type HttpsStatus,
} from '@mornihosting/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { dnsStatusQuery } from '@/features/dns/dns';

const PROVIDER_LABEL: Readonly<Record<DnsProvider, string>> = {
  inwx: 'INWX',
  cloudflare: 'Cloudflare',
  ionos: 'IONOS',
};

/** INWX login data as the stored key; empty until user name and password are filled in. */
function loginToken(login: { user: string; pass: string; otp: string }): string {
  if (!login.user.trim() || !login.pass) return '';
  const otp = login.otp.trim();
  return JSON.stringify({ user: login.user.trim(), pass: login.pass, ...(otp ? { otp } : {}) });
}

function ConnectForm({
  status,
  onDone,
  onCancel,
}: {
  status: DnsStatus;
  onDone: (next: DnsStatus) => void;
  onCancel: (() => void) | null;
}): ReactElement {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<DnsProvider>(status.provider ?? 'inwx');
  const [key, setKey] = useState('');
  // INWX signs in with the account itself: user name, password and – if 2FA is on – its secret.
  const [login, setLogin] = useState({ user: '', pass: '', otp: '' });
  const usesLogin = provider === 'inwx';
  const token = usesLogin ? loginToken(login) : key.trim();
  const [zoneId, setZoneId] = useState('');
  const keepToken = status.configured && status.provider === provider;
  const body = { provider, ...(token ? { token } : {}) };
  const discover = useMutation({
    mutationFn: () => api<{ zones: DnsZoneOption[] }>('/api/dns/discover', { method: 'POST', body }),
    onSuccess: ({ zones }) =>
      setZoneId(zones.find((z) => z.name === status.domain)?.id ?? zones[0]?.id ?? ''),
  });
  const save = useMutation({
    mutationFn: () => api<DnsStatus>('/api/dns', { method: 'PUT', body: { ...body, zoneId } }),
    onSuccess: (next) => {
      toast.success(t('dnsAuto.connected'));
      onDone(next);
    },
  });
  const zones = discover.data?.zones;
  const error = save.error ?? discover.error;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <label className="grid gap-2 text-sm font-semibold">
          {t('dnsAuto.provider')}
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value as DnsProvider);
              discover.reset();
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DNS_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {usesLogin ? null : (
          <Field
            id="dns-token"
            label={t('dnsAuto.tokenLabel')}
            hint={keepToken ? t('dnsAuto.tokenKeep') : t(`dnsAuto.tokenHint.${provider}`)}
          >
            <Input
              id="dns-token"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={keepToken ? '••••••••' : ''}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
        )}
      </div>
      {usesLogin ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="dns-user" label={t('dnsAuto.inwxUser')}>
            <Input
              id="dns-user"
              autoComplete="off"
              value={login.user}
              onChange={(e) => setLogin({ ...login, user: e.target.value })}
            />
          </Field>
          <Field id="dns-pass" label={t('dnsAuto.inwxPass')}>
            <Input
              id="dns-pass"
              type="password"
              autoComplete="off"
              value={login.pass}
              placeholder={keepToken ? '••••••••' : ''}
              onChange={(e) => setLogin({ ...login, pass: e.target.value })}
            />
          </Field>
          <Field id="dns-otp" label={t('dnsAuto.inwxOtp')}>
            <Input
              id="dns-otp"
              type="password"
              autoComplete="off"
              value={login.otp}
              onChange={(e) => setLogin({ ...login, otp: e.target.value })}
            />
          </Field>
          <p className="text-[13px] text-muted-foreground sm:col-span-3">
            {keepToken ? t('dnsAuto.tokenKeep') : t('dnsAuto.tokenHint.inwx')}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={zones ? 'secondary' : 'default'}
          disabled={discover.isPending || (!token && !keepToken)}
          onClick={() => discover.mutate()}
        >
          <PlugZap />
          {discover.isPending ? t('dnsAuto.connecting') : t('dnsAuto.connect')}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
      </div>
      {zones && !zones.length ? (
        <p className="rounded-[12px] bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {t('dnsAuto.noZones')}
        </p>
      ) : null}
      {zones?.length ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-2 text-sm font-semibold">
            {t('dnsAuto.domain')}
            <Select value={zoneId} onValueChange={setZoneId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button type="button" disabled={!zoneId || save.isPending} onClick={() => save.mutate()}>
            <Save />
            {save.isPending ? t('dnsAuto.saving') : t('common.save')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">{errorText(error)}</p>
      ) : null}
    </div>
  );
}

const httpsQuery = { queryKey: ['https'], queryFn: () => api<HttpsStatus>('/api/https') } as const;

/** HTTPS for the own domain: one switch starts Caddy on 80/443, which fetches the certificates itself. */
function HttpsSection(): ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(httpsQuery);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<HttpsStatus>('/api/https', { method: 'PUT', body: { enabled } }),
    onSuccess: (next) => {
      queryClient.setQueryData(httpsQuery.queryKey, next);
      toast.success(next.enabled ? t('https.on') : t('https.off'));
    },
  });
  if (!data) return null;
  const error = toggle.error ? errorText(toggle.error) : null;
  const lastError = data.error ? t(`errors.${data.error.code}`, data.error.params) : null;
  return (
    <div className="grid gap-3 rounded-[12px] border border-border px-3.5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <Lock className="size-4 text-primary" aria-hidden />
        {t('https.title')}
        {data.enabled ? (
          <Pill tone={data.running ? 'ok' : 'warn'}>
            {data.running ? t('https.running') : t('https.stopped')}
          </Pill>
        ) : null}
      </div>
      <p className="text-muted-foreground">{t('https.text', { domain: data.domain })}</p>
      {data.enabled && data.domain ? (
        <a
          href={`https://${data.domain}`}
          className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          https://{data.domain}
        </a>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={data.enabled ? 'ghost' : 'default'}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!data.enabled)}
        >
          <Lock />
          {data.enabled ? t('https.disable') : t('https.enable')}
        </Button>
      </div>
      {error || lastError ? (
        <p className="rounded-[10px] bg-destructive-soft px-3 py-2">{error ?? lastError}</p>
      ) : null}
    </div>
  );
}

/** Admin area: an own domain without NetBird – the panel writes the DNS records and keeps the IP current. */
export function DnsDomainCard(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useQuery(dnsStatusQuery);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const refresh = async (next: DnsStatus): Promise<void> => {
    queryClient.setQueryData(dnsStatusQuery.queryKey, next);
    setEditing(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['server'] }),
      queryClient.invalidateQueries({ queryKey: ['connection'] }),
    ]);
  };
  const disconnect = useMutation({
    mutationFn: () => api<DnsStatus>('/api/dns', { method: 'DELETE' }),
    onSuccess: async (next) => {
      toast.success(t('dnsAuto.disconnected'));
      await refresh(next);
    },
  });
  if (!status) return null;
  // NetBird hands out the addresses already; otherwise the summary, or the form while connecting.
  const blocked = status.netbirdActive && !status.configured;
  const showSummary = status.configured && !editing;
  const checked = status.ipCheckedAt
    ? new Date(status.ipCheckedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <Card fold="own-domain" foldOpen id="own-domain" className="grid min-w-0 scroll-mt-4 gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Globe className="size-4 text-primary" aria-hidden />
          {t('dnsAuto.title')}
          {status.configured ? (
            <Pill tone="ok">{t('dnsAuto.connectedPill')}</Pill>
          ) : (
            <Pill>{t('dnsAuto.notConnected')}</Pill>
          )}
        </CardTitle>
      </CardHeader>
      <CardDescription>{t('dnsAuto.text')}</CardDescription>
      {blocked ? (
        <p className="rounded-[12px] bg-secondary px-3 py-2.5 text-sm">{t('dnsAuto.netbirdActive')}</p>
      ) : null}
      {showSummary ? (
        <>
          <p className="rounded-[12px] bg-secondary px-3 py-2.5 text-sm">
            <Trans
              i18nKey="dnsAuto.summary"
              values={{
                domain: status.domain,
                provider: status.provider ? PROVIDER_LABEL[status.provider] : '',
                ip: status.ip ?? '–',
                time: checked ?? '–',
              }}
              components={{ b: <b className="font-mono font-semibold" /> }}
            />
          </p>
          <p className="text-[13px] text-muted-foreground">{t('dnsAuto.portNote')}</p>
          <HttpsSection />
          {status.error ? (
            <p className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
              {t(`errors.${status.error.code}`, status.error.params)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
              {t('dnsAuto.change')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => setConfirm(true)}
            >
              <Unplug />
              {t('dnsAuto.disconnect')}
            </Button>
          </div>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={t('dnsAuto.disconnectTitle')}
            description={t('dnsAuto.disconnectText')}
            confirmLabel={t('dnsAuto.disconnect')}
            destructive
            onConfirm={() => disconnect.mutate()}
          />
        </>
      ) : null}
      {!blocked && !showSummary ? (
        <ConnectForm
          status={status}
          onDone={(next) => void refresh(next)}
          onCancel={status.configured ? () => setEditing(false) : null}
        />
      ) : null}
    </Card>
  );
}
