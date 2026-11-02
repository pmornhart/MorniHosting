import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Inbox, XCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { OutboxEntry } from '@mornihosting/shared';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

/** While the tab is open the list follows along, so a test sign-up shows up within seconds. */
const REFRESH_MS = 5000;

/** The last mails the panel sent and what the mail server answered: shows where a missing mail got stuck. */
export function MailOutbox(): ReactElement {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['mail-outbox'],
    queryFn: () => api<OutboxEntry[]>('/api/mail/outbox'),
    refetchInterval: REFRESH_MS,
  });
  return (
    <Card className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <Inbox className="size-5 shrink-0 text-primary" aria-hidden />
          {t('outbox.title')}
        </CardTitle>
        <CardDescription>{t('outbox.text')}</CardDescription>
      </div>
      {data && data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('outbox.empty')}</p>
      ) : null}
      <ul className="grid gap-2">
        {data?.map((entry) => (
          <li
            key={`${entry.at}-${entry.to}`}
            className="flex min-w-0 gap-3 rounded-[12px] bg-secondary px-3 py-2.5"
          >
            {entry.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-label={t('outbox.sent')} />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label={t('outbox.failed')} />
            )}
            <div className="grid min-w-0 gap-0.5 text-sm">
              <p className="truncate font-semibold">{entry.subject}</p>
              <p className="truncate text-muted-foreground">
                {entry.to} · {formatRelative(entry.at)} · {entry.ok ? t('outbox.sent') : t('outbox.failed')}
              </p>
              {entry.detail ? (
                <p className="break-all font-mono text-xs text-muted-foreground">{entry.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t('outbox.hint')}</p>
    </Card>
  );
}
