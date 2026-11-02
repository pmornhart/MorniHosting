import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ExternalLink, Send, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  NOTIFY_CHANNELS,
  NOTIFY_TOPICS,
  type DiscordLinkCode,
  type NotifyPrefsInput,
  type NotifySettingsView,
} from '@mornihosting/shared';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';
import { useSession } from '@/features/auth/session';

const settingsQuery = {
  queryKey: ['notify-settings'],
  queryFn: () => api<NotifySettingsView>('/api/account/notifications'),
} as const;

/** "Mein Konto": what to be told about, by mail and/or Discord private message, and linking Discord. */
export function NotifyCard(): ReactElement {
  const { t } = useTranslation();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery(settingsQuery);
  const linked = Boolean(data?.discord.linked);
  // While a code is shown, look every few seconds whether /verbinden arrived.
  const code = useMutation({
    mutationFn: () => api<DiscordLinkCode>('/api/account/discord/code', { method: 'POST' }),
  });
  useQuery({ ...settingsQuery, refetchInterval: code.data && !linked ? 3000 : false });
  const save = useMutation({
    mutationFn: (prefs: NotifyPrefsInput) =>
      api<NotifySettingsView>('/api/account/notifications', { method: 'PUT', body: prefs }),
    onSuccess: (view) => queryClient.setQueryData(settingsQuery.queryKey, view),
  });
  const testDm = useMutation({
    mutationFn: () => api<void>('/api/account/discord/test', { method: 'POST' }),
    onSuccess: () => toast.success(t('notifyCard.testSent')),
    // The reason stays in the card; no second pop-up.
    onError: () => undefined,
  });
  const unlink = useMutation({
    mutationFn: () => api<void>('/api/account/discord', { method: 'DELETE' }),
    onSuccess: () => {
      code.reset();
      void queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
    },
  });
  if (!data) return <Card className="h-48 animate-pulse p-6" aria-busy />;
  const topics = NOTIFY_TOPICS.filter((topic) => topic !== 'approvals' || me.user.isAdmin);
  const toggle = (key: keyof NotifyPrefsInput, value: boolean): void =>
    save.mutate({ ...data.prefs, [key]: value });
  const command = code.data ? `/verbinden ${code.data.code}` : '';

  return (
    <Card className="grid min-w-0 gap-5 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-primary" aria-hidden />
          {t('notifyCard.title')}
        </CardTitle>
        <CardDescription>{t('notifyCard.text')}</CardDescription>
      </CardHeader>

      <div className="grid gap-2">
        <b className="text-sm">{t('notifyCard.how')}</b>
        {NOTIFY_CHANNELS.map((channel) => (
          <label key={channel} className="flex items-center gap-3 text-sm">
            <Switch checked={data.prefs[channel]} onCheckedChange={(v) => toggle(channel, v)} />
            {t(`notifyCard.channels.${channel}`)}
            {channel === 'email' && !data.emailSet ? (
              <span className="text-[13px] text-muted-foreground">({t('notifyCard.noEmail')})</span>
            ) : null}
            {channel === 'discord' && !linked ? (
              <span className="text-[13px] text-muted-foreground">({t('notifyCard.notLinked')})</span>
            ) : null}
          </label>
        ))}
      </div>
      <div className="grid gap-2">
        <b className="text-sm">{t('notifyCard.what')}</b>
        {topics.map((topic) => (
          <label key={topic} className="flex items-start gap-3 text-sm">
            <Switch
              checked={data.prefs[topic]}
              onCheckedChange={(v) => toggle(topic, v)}
              className="mt-0.5"
            />
            <span>
              {t(`notifyCard.topics.${topic}`)}
              <span className="block text-[13px] text-muted-foreground">
                {t(`notifyCard.topicHints.${topic}`)}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="grid gap-3 rounded-[12px] border border-border p-4">
        <b className="text-sm">{t('notifyCard.discordTitle')}</b>
        {!data.discord.available ? (
          <p className="text-[13px] text-muted-foreground">{t('notifyCard.discordUnavailable')}</p>
        ) : linked ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>{t('notifyCard.linkedAs', { name: data.discord.name ?? '' })}</span>
            <Button size="sm" disabled={testDm.isPending} onClick={() => testDm.mutate()}>
              <Send />
              {testDm.isPending ? t('notifyCard.testSending') : t('notifyCard.test')}
            </Button>
            <Button variant="outline" size="sm" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              <Unlink />
              {t('notifyCard.unlink')}
            </Button>
          </div>
        ) : (
          <ol className="grid list-decimal gap-3 pl-5 text-sm">
            <li className="grid gap-2">
              <span>{t('notifyCard.step1')}</span>
              {data.discord.installUrl ? (
                <Button asChild variant="outline" size="sm" className="justify-self-start">
                  <a href={data.discord.installUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    {t('notifyCard.addApp')}
                  </a>
                </Button>
              ) : null}
            </li>
            <li className="grid gap-2">
              <span>{t('notifyCard.step2')}</span>
              {code.data ? (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-[8px] bg-muted px-3 py-1.5 font-mono text-base">{command}</code>
                  <CopyButton text={command} />
                </div>
              ) : (
                <Button
                  size="sm"
                  className="justify-self-start"
                  disabled={code.isPending}
                  onClick={() => code.mutate()}
                >
                  {t('notifyCard.getCode')}
                </Button>
              )}
            </li>
            <li>{t('notifyCard.step3')}</li>
          </ol>
        )}
        {code.error ? <p className="text-sm text-destructive">{errorText(code.error)}</p> : null}
        {linked && (data.discord.lastDmError || testDm.error) && data.discord.serverInstallUrl ? (
          <div className="grid gap-2 rounded-[10px] border border-border p-3 text-sm">
            <b>{t('notifyCard.noDmTitle')}</b>
            <span className="text-muted-foreground">{t('notifyCard.noDmText')}</span>
            <Button asChild size="sm" className="justify-self-start">
              <a href={data.discord.serverInstallUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                {t('notifyCard.addToServer')}
              </a>
            </Button>
            {data.discord.lastDmError ? (
              <span className="text-[13px] text-muted-foreground">
                {t('notifyCard.lastError', { message: data.discord.lastDmError.message })}
              </span>
            ) : null}
          </div>
        ) : null}
        {testDm.error ? (
          <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
            {errorText(testDm.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
