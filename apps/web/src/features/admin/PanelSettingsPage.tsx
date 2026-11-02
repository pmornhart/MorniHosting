import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PackageOpen,
  ArrowUpCircle,
  ExternalLink,
  Globe,
  KeyRound,
  Mail,
  Network,
  Save,
  Shield,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LOCALES, type Locale, type PanelSettings } from '@mornihosting/shared';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/misc';
import { Pill } from '@/components/ui/pill';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { updateQuery } from '@/features/shell/UpdateCard';
import { useSession } from '@/features/auth/session';
import { MailCard } from './MailCard';
import { NetBirdGuide } from './NetBirdGuide';
import { DnsDomainCard } from './DnsDomainCard';
import { NetbirdAutomationCard } from './NetbirdAutomationCard';
import { PasswordResetCard } from './PasswordResetCard';
import { UpdateSection } from './UpdateSection';
import { DdosSection } from './DdosSection';
import { TransferSection } from './TransferCard';

const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { de: 'Deutsch', en: 'English' };
/** The admin area's tabs; the address bar (#update …) opens one directly. */
const TABS = [
  { key: 'domain', icon: Globe },
  { key: 'netbird', icon: Network },
  { key: 'update', icon: ArrowUpCircle },
  { key: 'ddos', icon: Shield },
  { key: 'mail', icon: Mail },
  { key: 'passwords', icon: KeyRound },
  { key: 'move', icon: PackageOpen },
  { key: 'settings', icon: SlidersHorizontal },
] as const;
type Tab = (typeof TABS)[number]['key'];
/** Older links point at a card inside a tab. */
const ANCHORS: Readonly<Record<string, Tab>> = { 'own-domain': 'domain' };
const FOCUS_DELAY_MS = 50;

function tabOf(hash: string): Tab {
  const anchor = hash.slice(1);
  return TABS.find((tab) => tab.key === anchor)?.key ?? ANCHORS[anchor] ?? 'domain';
}
const URL_MARK = '://';

/** "https://Panel.Example.de/login" and "panel.example.de" both become "panel.example.de". */
function toHostname(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.includes(URL_MARK)) return URL.canParse(value) ? new URL(value).hostname : value;
  return value.split('/')[0] ?? '';
}

/** Tells whether this very page already runs on the panel domain over HTTPS, so passkeys work here. */
function DomainState({ domain }: { domain: string }): ReactElement | null {
  const { t } = useTranslation();
  if (!domain) return null;
  const here = window.location.hostname === domain && window.location.protocol === 'https:';
  return here ? (
    <p className="rounded-[12px] bg-success-soft px-3 py-2.5 text-sm">{t('admin.domainActive')}</p>
  ) : (
    <p className="flex flex-wrap items-center gap-2 rounded-[12px] bg-secondary px-3 py-2.5 text-sm">
      <span className="flex-1">{t('admin.domainOpen', { domain })}</span>
      <a
        href={`https://${domain}`}
        className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
      >
        <ExternalLink className="size-4" aria-hidden />
        https://{domain}
      </a>
    </p>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  title: ReactNode;
  hint: ReactNode;
}): ReactElement {
  return (
    <label className="flex items-start gap-3 rounded-[12px] border border-border p-3">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <span>
        <b className="block text-sm font-semibold">{title}</b>
        <span className="text-[13px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The admin area: the panel's domain, updates, password resets for others, and panel-wide settings
 * (address shown to players, CurseForge key, time zone, language).
 */
export function PanelSettingsPage(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api<PanelSettings>('/api/settings'),
    enabled: me.user.isAdmin,
  });
  const [draft, setDraft] = useState<PanelSettings | null>(null);
  const [cfKey, setCfKey] = useState('');
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tab = tabOf(hash);
  const { data: update } = useQuery({ ...updateQuery, retry: false, enabled: me.user.isAdmin });
  // On a phone the tabs scroll sideways: keep the open one in view.
  useEffect(() => {
    document
      .querySelector('[data-admin-tab][aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  const open = (next: Tab): void => {
    navigate({ hash: next }, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<PanelSettings>('/api/settings', { method: 'PUT', body }),
    onSuccess: async (result) => {
      toast.success(t('common.saved'));
      setCfKey('');
      queryClient.setQueryData(['panel-settings'], result);
      await queryClient.invalidateQueries({ queryKey: ['market-sources'] });
    },
  });

  if (!me.user.isAdmin) return <EmptyState title={t('errors.admin_only')} />;
  if (!draft) return <Skeleton className="h-96 rounded-[16px]" />;
  const set = (patch: Partial<PanelSettings>): void => setDraft({ ...draft, ...patch });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const { curseforgeConfigured: _ignored, ...rest } = draft;
    save.mutate({
      ...rest,
      panelDomain: toHostname(rest.panelDomain),
      publicAddress: toHostname(rest.publicAddress),
      ...(cfKey.trim() ? { curseforgeApiKey: cfKey.trim() } : {}),
    });
  };

  const saveButton = (
    <div className="flex justify-end">
      <Button type="submit" disabled={save.isPending}>
        <Save />
        {t('common.save')}
      </Button>
    </div>
  );

  const settingsForm = (
    <form onSubmit={submit} className="grid min-w-0 gap-5">
      <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
        <CardHeader className="mb-0">
          <CardTitle>{t('panelSettings.addressTitle')}</CardTitle>
        </CardHeader>
        <CardDescription>{t('panelSettings.addressText')}</CardDescription>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ps-lan" label={t('panelSettings.lanIp')} hint={t('panelSettings.lanIpHint')}>
            <Input
              id="ps-lan"
              value={draft.lanIp}
              placeholder="192.168.178.20"
              onChange={(e) => set({ lanIp: e.target.value })}
            />
          </Field>
        </div>
        <Toggle
          checked={draft.publicIpLookup}
          onChange={(on) => set({ publicIpLookup: on })}
          title={t('panelSettings.publicIpLookup')}
          hint={t('panelSettings.publicIpLookupHint')}
        />
        <Toggle
          checked={draft.reachabilityCheck}
          onChange={(on) => set({ reachabilityCheck: on })}
          title={t('panelSettings.reachability')}
          hint={t('panelSettings.reachabilityHint')}
        />
      </Card>

      <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
        <CardHeader className="mb-0">
          <CardTitle className="flex items-center gap-2">
            CurseForge
            {draft.curseforgeConfigured ? (
              <Pill tone="ok">{t('panelSettings.keySet')}</Pill>
            ) : (
              <Pill>{t('panelSettings.keyMissing')}</Pill>
            )}
          </CardTitle>
        </CardHeader>
        <CardDescription>{t('panelSettings.curseforgeText')}</CardDescription>
        <Field
          id="ps-cf"
          label={t('panelSettings.curseforgeKey')}
          hint={draft.curseforgeConfigured ? t('panelSettings.keyKeep') : undefined}
        >
          <Input
            id="ps-cf"
            type="password"
            autoComplete="off"
            value={cfKey}
            onChange={(e) => setCfKey(e.target.value)}
          />
        </Field>
      </Card>

      <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
        <CardHeader className="mb-0">
          <CardTitle>{t('panelSettings.generalTitle')}</CardTitle>
        </CardHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold">
            {t('panelSettings.timezone')}
            <Select value={draft.timezone} onValueChange={(v) => set({ timezone: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[13px] font-normal text-muted-foreground">
              {t('panelSettings.timezoneHint')}
            </span>
          </label>
          <label className="grid gap-2 text-sm font-semibold">
            {t('panelSettings.language')}
            <Select value={draft.defaultLocale} onValueChange={(v) => set({ defaultLocale: v as Locale })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCALES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LANGUAGE_NAMES[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[13px] font-normal text-muted-foreground">
              {t('panelSettings.languageHint')}
            </span>
          </label>
        </div>
        <Toggle
          checked={draft.checkUpdates}
          onChange={(on) => set({ checkUpdates: on })}
          title={t('panelSettings.checkUpdates')}
          hint={t('panelSettings.checkUpdatesHint')}
        />
      </Card>

      {saveButton}
    </form>
  );

  const badges: Partial<Record<Tab, ReactNode>> = {
    domain: draft.panelDomain ? <span className="size-2 rounded-full bg-success" aria-hidden /> : null,
    update: update?.available ? (
      <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
        {update.behind || '!'}
      </span>
    ) : null,
  };

  const manualDomain = (
    <form onSubmit={submit} className="grid min-w-0 gap-5">
      <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
        <CardHeader className="mb-0">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t('admin.domainTitle')}
            {draft.panelDomain ? (
              <Pill tone="ok">{draft.panelDomain}</Pill>
            ) : (
              <Pill>{t('admin.domainNone')}</Pill>
            )}
          </CardTitle>
        </CardHeader>
        <CardDescription>{t('admin.domainText')}</CardDescription>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ps-domain" label={t('admin.panelDomain')} hint={t('admin.panelDomainHint')}>
            <Input
              id="ps-domain"
              value={draft.panelDomain}
              placeholder="panel.example.de"
              autoComplete="off"
              onChange={(e) => set({ panelDomain: e.target.value })}
              onBlur={(e) => set({ panelDomain: toHostname(e.target.value) })}
            />
          </Field>
          <Field
            id="ps-public"
            label={t('panelSettings.publicAddress')}
            hint={t('panelSettings.publicAddressHint')}
          >
            <Input
              id="ps-public"
              value={draft.publicAddress}
              placeholder="mc.example.de"
              autoComplete="off"
              onChange={(e) => set({ publicAddress: e.target.value })}
              onBlur={(e) => set({ publicAddress: toHostname(e.target.value) })}
            />
          </Field>
        </div>
        <DomainState domain={data?.panelDomain ?? ''} />
        <details className="rounded-[12px] border border-border p-3 text-sm">
          <summary className="cursor-pointer font-semibold">{t('admin.httpsGuideTitle')}</summary>
          <ol className="mt-2 grid list-decimal gap-1.5 pl-5 text-muted-foreground">
            <li>{t('admin.httpsStep1')}</li>
            <li>{t('admin.httpsStep2')}</li>
            <li>{t('admin.httpsStep3')}</li>
          </ol>
        </details>
        {saveButton}
      </Card>
    </form>
  );

  const panels: Readonly<Record<Tab, ReactNode>> = {
    domain: (
      <>
        <DnsDomainCard />
        {manualDomain}
      </>
    ),
    netbird: (
      <>
        <NetbirdAutomationCard panelDomain={data?.panelDomain ?? ''} />
        <Card className="min-w-0 p-5 sm:p-6">
          <details className="group grid gap-4">
            <summary className="cursor-pointer text-base font-semibold">
              {t('admin.netbirdManual')}
              <span className="block text-sm font-normal text-muted-foreground">
                {t('admin.netbirdManualHint')}
              </span>
            </summary>
            <div className="mt-4 grid min-w-0 gap-4">
              <NetBirdGuide
                panelDomain={draft.panelDomain}
                lanIp={draft.lanIp}
                onUsePanelDomain={(domain) => {
                  set({ panelDomain: domain });
                  open('domain');
                  window.setTimeout(() => document.getElementById('ps-domain')?.focus(), FOCUS_DELAY_MS);
                }}
              />
            </div>
          </details>
        </Card>
      </>
    ),
    update: <UpdateSection />,
    ddos: <DdosSection />,
    mail: <MailCard />,
    passwords: <PasswordResetCard />,
    move: <TransferSection />,
    settings: settingsForm,
  };

  return (
    <div className="grid min-w-0 gap-5">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('admin.title')} className="flex flex-wrap gap-1.5 lg:sticky lg:top-4 lg:grid">
          {TABS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              data-admin-tab
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => open(key)}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
                tab === key && 'bg-accent text-foreground',
              )}
            >
              <Icon className={cn('size-4', tab === key && 'text-primary')} aria-hidden />
              <span className="flex-1 whitespace-nowrap">{t(`admin.sections.${key}`)}</span>
              {badges[key]}
            </button>
          ))}
        </nav>
        <section className="grid min-w-0 max-w-3xl gap-5" aria-label={t(`admin.sections.${tab}`)}>
          <p className="text-sm text-muted-foreground">{t(`admin.sectionText.${tab}`)}</p>
          {panels[tab]}
        </section>
      </div>
    </div>
  );
}
