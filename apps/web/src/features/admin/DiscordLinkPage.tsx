import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Link2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { DiscordLinked, NotifySettingsView } from '@mornihosting/shared';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { errorText } from '@/lib/query';

const TOKEN_KEY = 'mh-discord-link';

/** The token from "#…"; kept for a moment in case the person has to log in first. */
export function rememberDiscordToken(): void {
  if (window.location.pathname !== '/discord-link' || !window.location.hash) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, window.location.hash.slice(1));
  } catch {
    // Private mode: the hash still works when already signed in.
  }
}

function readToken(): string {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) return fromHash;
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Opened from the "Jetzt verbinden" button in Discord: one click links the account. */
export function DiscordLinkPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [token] = useState(readToken);
  const peek = useQuery({
    queryKey: ['discord-peek', token],
    queryFn: () => api<{ name: string }>(`/api/account/discord/peek?token=${encodeURIComponent(token)}`),
    enabled: Boolean(token),
    retry: false,
  });
  const claim = useMutation({
    mutationFn: () => api<DiscordLinked>('/api/account/discord/claim', { method: 'POST', body: { token } }),
    onSuccess: () => {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        // Nothing to clean up.
      }
      void queryClient.invalidateQueries({ queryKey: ['notify-settings'] });
    },
    onError: () => undefined,
  });
  const settings = useQuery({
    queryKey: ['notify-settings'],
    queryFn: () => api<NotifySettingsView>('/api/account/notifications'),
    enabled: claim.isSuccess,
  });
  const error = peek.error ?? claim.error;

  return (
    <div className="grid max-w-xl gap-5">
      <PageHeader title={t('discordLink.title')} />
      <Card className="grid gap-4 p-6">
        {!token ? <p>{t('discordLink.missing')}</p> : null}
        {error ? (
          <p role="alert" className="rounded-[10px] bg-destructive-soft px-3 py-2 text-sm">
            {errorText(error)}
          </p>
        ) : null}
        {claim.data ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="size-5 text-primary" aria-hidden />
              {claim.data.dm ? t('discordLink.noDm') : t('discordLink.done')}
            </p>
            {claim.data.dm && settings.data?.discord.serverInstallUrl ? (
              <Button asChild className="justify-self-start">
                <a href={settings.data.discord.serverInstallUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  {t('notifyCard.addToServer')}
                </a>
              </Button>
            ) : null}
            <Button asChild variant="outline" className="justify-self-start">
              <Link to="/account">{t('discordLink.toAccount')}</Link>
            </Button>
          </div>
        ) : peek.data ? (
          <div className="grid gap-4">
            <p>{t('discordLink.question', { name: peek.data.name })}</p>
            <Button
              size="lg"
              className="justify-self-start"
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              <Link2 />
              {t('discordLink.confirm')}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
