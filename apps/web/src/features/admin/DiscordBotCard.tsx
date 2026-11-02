import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, Save, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { DiscordSettingsView } from '@mornihosting/shared';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

export const discordQuery = {
  queryKey: ['discord'],
  queryFn: () => api<DiscordSettingsView>('/api/discord'),
  refetchInterval: 15_000,
} as const;

const PORTAL = 'https://discord.com/developers/applications';
const STEPS = ['step1', 'step2', 'step3'] as const;

/** Admins: the Discord bot that sends everyone their notifications as private messages. */
export function DiscordBotCard(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery(discordQuery);
  const [token, setToken] = useState('');
  const refresh = (view: DiscordSettingsView | null): void => {
    queryClient.setQueryData(discordQuery.queryKey, view);
    void queryClient.invalidateQueries({ queryKey: discordQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: ['notify-settings'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<DiscordSettingsView>('/api/discord', { method: 'PUT', body: { token: token.trim() } }),
    onSuccess: (view) => {
      setToken('');
      refresh(view);
      toast.success(t('discordBot.saved', { name: view.botName ?? '' }));
    },
  });
  const testDm = useMutation({
    mutationFn: () => api<void>('/api/account/discord/test', { method: 'POST' }),
    onSuccess: () => toast.success(t('notifyCard.testSent')),
    // The reason stays in the card; no second pop-up.
    onError: () => undefined,
  });
  const remove = useMutation({
    mutationFn: () => api<void>('/api/discord', { method: 'DELETE' }),
    onSuccess: () => refresh(null),
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate();
  };
  const tone = !data?.configured ? 'neutral' : data.online ? 'ok' : 'warn';
  const status = !data?.configured
    ? t('discordBot.off')
    : data.online
      ? t('discordBot.online')
      : t('discordBot.connecting');

  return (
    <Card className="grid min-w-0 gap-4 p-5 sm:p-6">
      <CardHeader className="mb-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Bot className="size-4 text-primary" aria-hidden />
          {t('discordBot.title')}
          <Pill tone={tone} dot>
            {status}
          </Pill>
        </CardTitle>
        <CardDescription>{t('discordBot.text')}</CardDescription>
      </CardHeader>

      {data?.configured ? (
        <div className="grid gap-3">
          <p className="text-sm">
            {t('discordBot.connectedAs')} <b>{data.botName}</b>
          </p>
          <p className="text-[13px] text-muted-foreground">{t('discordBot.nextStep')}</p>
          <div className="flex flex-wrap gap-2">
            {data.installUrl ? (
              <Button asChild>
                <a href={data.installUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {t('discordBot.install')}
                </a>
              </Button>
            ) : null}
            <Button variant="secondary" disabled={testDm.isPending} onClick={() => testDm.mutate()}>
              <Send />
              {testDm.isPending ? t('notifyCard.testSending') : t('discordBot.testToMe')}
            </Button>
            <Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 />
              {t('discordBot.remove')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ol className="grid list-decimal gap-2 pl-5 text-sm">
            {STEPS.map((step) => (
              <li key={step}>{t(`discordBot.${step}`)}</li>
            ))}
          </ol>
          <Button asChild variant="outline" className="justify-self-start">
            <a href={PORTAL} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t('discordBot.portal')}
            </a>
          </Button>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <Field id="discord-token" label={t('discordBot.token')} className="min-w-0 flex-1">
              <Input
                id="discord-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <Button type="submit" disabled={save.isPending || !token.trim()}>
              <Save />
              {t('discordBot.connect')}
            </Button>
          </form>
        </>
      )}
      {testDm.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(testDm.error)}
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
          {errorText(save.error)}
        </p>
      ) : null}
      {data?.error ? <p className="text-[13px] text-muted-foreground">{data.error}</p> : null}
      {data?.lastDmError ? (
        <div className="grid gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-sm">
          <b>{t('notifyCard.noDmTitle')}</b>
          <span>{t('notifyCard.lastError', { message: data.lastDmError.message })}</span>
          {data.lastDmError.blocked && data.serverInstallUrl ? (
            <>
              <span>{t('notifyCard.noDmText')}</span>
              <Button asChild size="sm" className="justify-self-start">
                <a href={data.serverInstallUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {t('notifyCard.addToServer')}
                </a>
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
